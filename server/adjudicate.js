const crypto = require('crypto');

// 服务端判定模块：只做规则裁决（校验 / 幂等 / 异文待核对 / 冲突停写），不做任何 I/O。
// 存档由 archive.js 承担，HTTP 编排由 server.js 承担。

const SITE_STATUS_OPTIONS = ['常规观察', '重点保护', '暂停开放'];
// 「同一时段」以现场巡测日期（自然日）为准
const PERIOD_FIELD = 'date';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// 现场单号是幂等键；正文内容（队伍 / 巡测记录 / 样点标记）做指纹，用于识别「同号异文」
function contentHash(payload) {
  return crypto
    .createHash('sha256')
    .update(stableStringify({ team: payload.team, survey: payload.survey, siteMark: payload.siteMark }))
    .digest('hex');
}

function teamOf(payload) {
  return String(payload.team || payload.survey?.surveyor || '').trim();
}

function pointLabel(site) {
  if (!site) return '';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function validate(payload) {
  if (!payload || typeof payload !== 'object') return '请求体格式不正确';
  if (!payload.ticketNo || !String(payload.ticketNo).trim()) return '缺少现场单号';
  if (!payload.survey || typeof payload.survey !== 'object') return '缺少巡测记录（两份记录须一起补传）';
  if (!payload.siteMark || typeof payload.siteMark !== 'object') return '缺少样点标记（两份记录须一起补传）';
  if (!teamOf(payload)) return '缺少队伍信息';
  const siteId = payload.survey.siteId;
  if (!siteId) return '巡测记录缺少样点';
  if (payload.siteMark.siteId !== siteId) return '巡测记录与样点标记必须指向同一样点';
  if (!payload.survey.surveyor) return '缺少巡测人员';
  if (!payload.survey[PERIOD_FIELD]) return '缺少巡测日期';
  if (!SITE_STATUS_OPTIONS.includes(payload.siteMark.protectedStatus)) return '样点标记的保护状态无效';
  return '';
}

// 另一支队已被受理（有效）的批次，且在同一日对同一样点执行了关闭标记
function findAppliedClosingBatch(db, siteId, date, team) {
  return (db.syncBatches || [])
    .filter((batch) => batch.outcome === 'applied')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .find(
      (batch) =>
        batch.siteId === siteId &&
        batch.survey?.[PERIOD_FIELD] === date &&
        batch.siteMark?.protectedStatus === '暂停开放' &&
        batch.team &&
        batch.team !== team
    );
}

function conflictFromBatch(batch, site) {
  return {
    reason: 'same-period-other-team-closed',
    siteId: batch.siteId,
    pointLabel: pointLabel(site),
    ticketNo: batch.ticketNo,
    team: batch.team,
    surveyor: batch.survey?.surveyor,
    surveyId: batch.result?.surveyId,
    date: batch.survey?.[PERIOD_FIELD]
  };
}

function conflictFromClosure(closure, site) {
  return {
    reason: 'same-period-other-team-closed',
    siteId: site.id,
    pointLabel: pointLabel(site),
    ticketNo: closure.ticketNo,
    team: closure.team,
    surveyor: closure.surveyor,
    surveyId: closure.surveyId,
    date: closure.date
  };
}

function withMessage(conflict) {
  return {
    ...conflict,
    message:
      `样点 ${conflict.pointLabel || conflict.siteId} 已由 ${conflict.team}（巡测员 ${conflict.surveyor || '未知'}）` +
      `在 ${conflict.date} 的有效巡测（现场单号 ${conflict.ticketNo}）关闭（暂停开放），本批整批停写，冲突来源请核对该单号`
  };
}

/**
 * 返回 decision：
 *  - { outcome:'invalid',       status:400, error }
 *  - { outcome:'replayed',      status:200|409, first }     同号同文，沿用首次结果
 *  - { outcome:'pending-review',status:200, first }         同号异文，留两份待核对，不动样点
 *  - { outcome:'conflict',      status:409, conflict }      同时段别队已关闭，整批停写
 *  - { outcome:'applied',       status:201, site }          判定通过，交由存档模块落库
 */
function adjudicate(db, rawPayload) {
  const payload = rawPayload || {};
  const error = validate(payload);
  if (error) return { outcome: 'invalid', status: 400, error };

  const hash = contentHash(payload);
  const team = teamOf(payload);
  const { ticketNo } = payload;

  const prior = (db.syncBatches || [])
    .filter((batch) => batch.ticketNo === ticketNo)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const first = prior[0];

  if (first) {
    // 同号重放：内容一致 → 完全沿用首次结果（首次是冲突也照旧回放 409）
    if (first.contentHash === hash) {
      return { outcome: 'replayed', status: first.outcome === 'conflict' ? 409 : 200, first };
    }
    // 同号内容不同 → 不覆盖首次、不动样点档案，异文另存一份待核对
    return { outcome: 'pending-review', status: 200, first, payload, hash, team };
  }

  const site = (db.sites || []).find((entry) => entry.id === payload.survey.siteId);
  if (!site) return { outcome: 'invalid', status: 400, error: '样点不存在或已失效' };

  // 同一时段另一支队的「有效巡测」（已受理批次）已经关闭样点 → 整批停写
  if (site.protectedStatus === '暂停开放') {
    const date = payload.survey[PERIOD_FIELD];
    const closingBatch = findAppliedClosingBatch(db, site.id, date, team);
    let conflict = closingBatch ? conflictFromBatch(closingBatch, site) : null;
    if (!conflict && site.closure && site.closure.date === date && site.closure.team && site.closure.team !== team) {
      const sourceStillValid = (db.syncBatches || []).some(
        (batch) => batch.ticketNo === site.closure.ticketNo && batch.outcome === 'applied'
      );
      if (sourceStillValid) conflict = conflictFromClosure(site.closure, site);
    }
    if (conflict) return { outcome: 'conflict', status: 409, conflict: withMessage(conflict), payload, hash, team };
  }

  return { outcome: 'applied', status: 201, site, payload, hash, team };
}

module.exports = { adjudicate, contentHash, SITE_STATUS_OPTIONS };

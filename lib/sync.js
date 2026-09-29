'use strict';

// 离线补传的服务端判定逻辑：纯函数，不做读写，存档由 server.js 负责。
// 规则：
// 1. 按现场单号整批补传，同号重放沿用首次结果（内容哈希一致即幂等）。
// 2. 同号但内容不同：两份都留存待核对，不写巡测、不动样点档案。
// 3. 同一时段另一支队的有效巡测已关闭样点：整批停写，返回冲突来源。
// 4. 校验全部通过后才写入；先落巡测记录，再动样点档案。

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function rand() {
  return Math.random().toString(16).slice(2, 7);
}

// 只对业务条目做哈希，批次号、时间戳等元数据不影响内容判定。
function hashItems(items) {
  const canonical = JSON.stringify(items);
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = (hash * 31 + canonical.charCodeAt(i)) >>> 0;
  }
  return `h${hash.toString(36)}-${canonical.length}`;
}

function newBatch(overrides) {
  const now = new Date().toISOString();
  return {
    id: `sync-${Date.now()}-${rand()}`,
    ticketNo: '',
    batchId: '',
    status: '',
    contentHash: '',
    items: [],
    result: null,
    conflict: null,
    conflictReason: '',
    duplicateOf: null,
    originalSnapshot: null,
    createdAt: now,
    updatedAt: now,
    history: [],
    ...overrides
  };
}

// 从条目中取出样点与标记，巡测条目与样点标记条目统一处理。
function describeItem(item) {
  if (item.kind === 'survey') {
    const p = item.payload || {};
    return { siteId: p.siteId, mark: p.mark || '', surveyor: p.surveyor || '', date: p.date || '', tempId: item.tempId || null };
  }
  return { siteId: item.siteId, mark: item.protectedStatus || '', surveyor: item.surveyor || '', date: item.date || '', tempId: item.tempId || null };
}

function validate(batch) {
  if (!batch || typeof batch.ticketNo !== 'string' || !batch.ticketNo.trim()) {
    return { error: '缺少现场单号' };
  }
  if (typeof batch.batchId !== 'string' || !batch.batchId.trim()) {
    return { error: '缺少批次编号' };
  }
  if (!Array.isArray(batch.items) || !batch.items.length) {
    return { error: '缺少补传记录' };
  }
  for (const item of batch.items) {
    if (item.kind === 'survey') {
      const p = item.payload || {};
      if (!p.siteId || !p.surveyor || !p.date) return { error: '巡测记录字段不完整（样点、人员、日期必填）' };
      if (p.mark && !['重点保护', '暂停开放'].includes(p.mark)) return { error: '样点标记类型无效' };
    } else if (item.kind === 'siteMark') {
      if (!item.siteId || !item.protectedStatus) return { error: '样点标记字段不完整' };
      if (!['重点保护', '暂停开放'].includes(item.protectedStatus)) return { error: '样点标记类型无效' };
    } else {
      return { error: '未知记录类型' };
    }
  }
  return null;
}

// 冲突判定：样点已被本单号之外的有效巡测关闭（暂停开放）即整批停写。
function findConflict(db, ticketNo, items) {
  for (const item of items) {
    const desc = describeItem(item);
    if (desc.mark !== '暂停开放') continue;
    const site = (db.sites || []).find((entry) => entry.id === desc.siteId);
    if (!site) return { reason: `样点 ${desc.siteId} 不存在`, source: null };
    if (site.protectedStatus !== '暂停开放') continue;
    const closedBy = site.closedBy;
    if (closedBy && closedBy.ticketNo !== ticketNo) {
      const who = closedBy.surveyor ? `${closedBy.surveyor}队` : '其他队';
      const when = closedBy.date ? `（${closedBy.date}）` : '';
      const ticket = closedBy.ticketNo ? `，现场单号 ${closedBy.ticketNo}` : '';
      return {
        reason: `样点「${site.pointCode || site.id}」已被${who}${when}的有效巡测关闭${ticket}，本批整批停写`,
        source: {
          ticketNo: closedBy.ticketNo || '',
          surveyId: closedBy.surveyId || '',
          surveyor: closedBy.surveyor || '',
          date: closedBy.date || '',
          at: closedBy.at || ''
        }
      };
    }
    // 兼容没有 closedBy 印记的历史数据：从样点历史里找关闭记录。
    const closeEntry = (site.history || []).find((h) => h.action === '暂停开放' || (h.note || '').includes('暂停开放'));
    if (closeEntry) {
      const match = /现场单号\s*([^\s：:]+)/.exec(closeEntry.note || '');
      const otherTicket = match ? match[1] : '';
      if (!otherTicket || otherTicket === ticketNo) continue;
      return {
        reason: `样点「${site.pointCode || site.id}」已被其他队的有效巡测关闭（${closeEntry.note || closeEntry.action}），本批整批停写`,
        source: { ticketNo: otherTicket, surveyId: '', surveyor: '', date: '', at: closeEntry.at || '' }
      };
    }
  }
  return null;
}

// 落库：先写巡测记录，再动样点档案；样点印记与巡测单号互相对应。
function applyBatch(db, batch) {
  const now = new Date().toISOString();
  const surveyRefs = [];
  for (const item of batch.items) {
    if (item.kind !== 'survey') continue;
    const p = item.payload || {};
    const status = p.mark ? '异常待复查' : (p.status || '正常');
    const survey = {
      id: `survey-${Date.now()}-${rand()}`,
      ...p,
      ticketNo: batch.ticketNo,
      batchId: batch.batchId,
      status,
      createdAt: now,
      updatedAt: now,
      history: [stamp('离线补传', `现场单号 ${batch.ticketNo}`)]
    };
    db.surveys = db.surveys || [];
    db.surveys.push(survey);
    surveyRefs.push({ tempId: item.tempId || null, surveyId: survey.id });
  }
  for (const item of batch.items) {
    const desc = describeItem(item);
    if (!desc.mark) continue;
    const site = (db.sites || []).find((entry) => entry.id === desc.siteId);
    if (!site) continue;
    site.protectedStatus = desc.mark;
    site.updatedAt = now;
    site.history = site.history || [];
    site.history.unshift(stamp('离线补传标记', `现场单号 ${batch.ticketNo}：${desc.mark}`));
    if (desc.mark === '暂停开放') {
      const ref = surveyRefs.find((entry) => entry.tempId === desc.tempId);
      site.closedBy = {
        ticketNo: batch.ticketNo,
        surveyId: ref ? ref.surveyId : '',
        surveyor: desc.surveyor,
        date: desc.date,
        at: now
      };
    }
  }
  return surveyRefs;
}

// 处理一个补传批次，返回 { status, batch, ... }；status 为
// replayed（同号同内容，沿用首次结果）、pending-review（同号不同内容，待核对）、
// conflict（冲突停写）、applied（补传成功）。
function processBatch(db, input) {
  const invalid = validate(input);
  if (invalid) return { status: 'error', error: invalid.error };

  const ticketNo = input.ticketNo.trim();
  const batchId = input.batchId.trim();
  const items = input.items;
  const contentHash = hashItems(items);

  db.syncBatches = db.syncBatches || [];
  const applied = db.syncBatches.find((b) => b.ticketNo === ticketNo && b.status === 'applied');

  // 同号重放：内容一致沿用首次结果，不再重复落库。
  if (applied && applied.contentHash === contentHash) {
    return { status: 'replayed', batch: applied, replayed: true };
  }

  // 同号不同内容：两份都留存待核对，不写巡测、不动样点档案。
  if (applied && applied.contentHash !== contentHash) {
    const review = newBatch({
      ticketNo,
      batchId,
      status: 'pending-review',
      contentHash,
      items,
      duplicateOf: applied.id,
      originalSnapshot: {
        batchId: applied.batchId,
        contentHash: applied.contentHash,
        items: applied.items,
        result: applied.result,
        createdAt: applied.createdAt
      },
      history: [stamp('待核对', `与现场单号 ${ticketNo} 的首次补传内容不一致，两份留存待核对`)]
    });
    db.syncBatches.unshift(review);
    return { status: 'pending-review', batch: review };
  }

  // 冲突判定：在任何写入之前完成，整批停写。
  const conflict = findConflict(db, ticketNo, items);
  if (conflict) {
    const blocked = newBatch({
      ticketNo,
      batchId,
      status: 'conflict',
      contentHash,
      items,
      conflict: conflict.source,
      conflictReason: conflict.reason,
      history: [stamp('冲突停写', conflict.reason)]
    });
    db.syncBatches.unshift(blocked);
    return { status: 'conflict', error: conflict.reason, conflict: conflict.source, batch: blocked };
  }

  const refs = applyBatch(db, { ticketNo, batchId, items });
  const done = newBatch({
    ticketNo,
    batchId,
    status: 'applied',
    contentHash,
    items: items.map((item) => ({
      tempId: item.tempId || null,
      kind: item.kind,
      ref: item.kind === 'survey' ? (refs.find((r) => r.tempId === (item.tempId || null)) || {}).surveyId || null : null,
      mark: describeItem(item).mark
    })),
    result: { applied: refs.length },
    history: [stamp('补传成功', `共同步 ${refs.length} 条巡测记录`)]
  });
  db.syncBatches.unshift(done);
  return { status: 'applied', batch: done, refs };
}

module.exports = { processBatch, hashItems };

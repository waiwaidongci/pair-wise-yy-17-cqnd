const fs = require('fs/promises');
const path = require('path');

// 存档模块：仅负责按裁决结果读写 db.json（落库、异文留档、冲突留痕、幂等回放快照）。
// 不做业务判定；样点档案只在裁决为 applied 时才允许改动。

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

const ID_PREFIX = { syncBatches: 'syncbatch', surveys: 'survey', sites: 'site' };

function newId(collection) {
  const prefix = ID_PREFIX[collection] || collection.replace(/s$/, '');
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function surveyStatusFromMark(protectedStatus) {
  return protectedStatus === '暂停开放' ? '异常待复查' : '正常';
}

// 裁决 applied：两份记录一起落库，然后才允许写样点档案
function persistApplied(db, decision) {
  const { site, payload, hash, team } = decision;
  const now = new Date().toISOString();

  db.syncBatches ||= [];
  db.surveys ||= [];
  db.sites ||= [];

  const survey = {
    id: newId('surveys'),
    ...payload.survey,
    team,
    ticketNo: payload.ticketNo,
    status: surveyStatusFromMark(payload.siteMark.protectedStatus),
    reviewNote: payload.siteMark.reviewNote || '',
    createdAt: now,
    updatedAt: now,
    history: [
      stamp('离线补传', `现场单号 ${payload.ticketNo}，队伍 ${team}`),
      stamp('创建', payload.survey.disturbance || '')
    ]
  };
  db.surveys.push(survey);

  const markNote = payload.siteMark.note || '';
  Object.assign(site, {
    protectedStatus: payload.siteMark.protectedStatus,
    updatedAt: now
  });
  site.history = site.history || [];
  site.history.unshift(stamp(`离线补传标记：${payload.siteMark.protectedStatus}`, `现场单号 ${payload.ticketNo}${markNote ? '，' + markNote : ''}`));
  if (payload.siteMark.protectedStatus === '暂停开放') {
    site.closure = {
      date: payload.survey.date,
      team,
      surveyor: payload.survey.surveyor,
      ticketNo: payload.ticketNo,
      surveyId: survey.id,
      closedAt: now
    };
  }

  const result = {
    surveyId: survey.id,
    siteId: site.id,
    protectedStatus: site.protectedStatus
  };
  const batch = {
    id: newId('syncBatches'),
    ticketNo: payload.ticketNo,
    team,
    siteId: site.id,
    survey: payload.survey,
    siteMark: payload.siteMark,
    contentHash: hash,
    outcome: 'applied',
    result,
    createdAt: now,
    updatedAt: now,
    history: [stamp('补传受理', `现场单号 ${payload.ticketNo}`)]
  };
  db.syncBatches.push(batch);
  return { batch, survey, site };
}

// 同号异文：首次结果原样保留，异文另存一份；两份并存待核对，样点档案不改动
function persistPendingReview(db, decision) {
  const { first, payload, hash, team } = decision;
  const now = new Date().toISOString();
  const batch = {
    id: newId('syncBatches'),
    ticketNo: payload.ticketNo,
    team,
    siteId: payload.survey.siteId,
    survey: payload.survey,
    siteMark: payload.siteMark,
    contentHash: hash,
    outcome: 'pending-review',
    duplicateOf: first.id,
    note: `与首次补传（单号 ${payload.ticketNo}）正文内容不一致，两份留档待核对，样点档案未改动`,
    createdAt: now,
    updatedAt: now,
    history: [stamp('异文待核对', `首次受理批次 ${first.id}`)]
  };
  db.syncBatches ||= [];
  db.syncBatches.push(batch);
  return batch;
}

// 冲突停写：仅留冲突痕迹（不写巡测、不动样点），便于后续追溯冲突来源
function persistConflict(db, decision) {
  const { conflict, payload, hash, team } = decision;
  const now = new Date().toISOString();
  db.syncBatches ||= [];
  const batch = {
    id: newId('syncBatches'),
    ticketNo: payload.ticketNo,
    team,
    siteId: payload.survey.siteId,
    survey: payload.survey,
    siteMark: payload.siteMark,
    contentHash: hash,
    outcome: 'conflict',
    conflict,
    createdAt: now,
    updatedAt: now,
    history: [stamp('整批停写', conflict.message)]
  };
  db.syncBatches.push(batch);
  return batch;
}

module.exports = { readDb, writeDb, stamp, persistApplied, persistPendingReview, persistConflict };

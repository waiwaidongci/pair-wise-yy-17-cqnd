const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
  } catch (networkError) {
    const err = new Error('NETWORK');
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || '请求失败');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

// ---- 离线补传：本机出箱，联网后按现场单号顺序整批续传 ----

const OUTBOX_KEY = 'cave-outbox-v1';

function genTicketNo() {
  const d = new Date();
  const day = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `XC-${day}-${Math.random().toString(16).slice(2, 5).toUpperCase()}`;
}

function outboxLoad() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || [];
  } catch {
    return [];
  }
}

function outboxSave(list) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
}

// 同现场单号的记录归到同一批，一起补传。
function outboxQueueSurvey(payload) {
  const ticketNo = (payload.ticketNo || '').trim() || genTicketNo();
  const item = {
    kind: 'survey',
    tempId: `t-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    payload: { ...payload, ticketNo }
  };
  const list = outboxLoad();
  let batch = list.find((entry) => entry.ticketNo === ticketNo && ['pending', 'error', 'conflict'].includes(entry.status));
  if (batch) {
    batch.items.push(item);
    batch.status = 'pending';
    batch.lastError = '';
  } else {
    batch = {
      tempId: `b-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ticketNo,
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: '',
      items: [item]
    };
    list.push(batch);
  }
  outboxSave(list);
  return batch;
}

const OUTBOX_STATUS = {
  pending: { label: '待上传', tone: 'warn' },
  uploading: { label: '上传中', tone: '' },
  review: { label: '待核对', tone: 'warn' },
  conflict: { label: '冲突停写', tone: 'bad' },
  error: { label: '待重传', tone: 'bad' }
};

const SYNC_STATUS = {
  applied: { label: '已补传', tone: 'ok' },
  replayed: { label: '重放沿用', tone: 'ok' },
  'pending-review': { label: '待核对', tone: 'warn' },
  conflict: { label: '冲突停写', tone: 'bad' }
};

function outboxBadge() {
  const pending = outboxLoad().filter((b) => ['pending', 'error', 'conflict'].includes(b.status)).length;
  return pending ? `<span class="badge">${pending}</span>` : '';
}

function renderOutboxBatch(batch) {
  const meta = OUTBOX_STATUS[batch.status] || { label: batch.status, tone: '' };
  const canRetry = ['error', 'conflict'].includes(b.status);
  return `<article class="card outbox-item">
    <div class="card-head">
      <h3>现场单号 ${escapeHtml(batch.ticketNo)}</h3>
      ${pill(meta.label, meta.tone)}
    </div>
    <div class="meta">${fmtDate(batch.createdAt)} · ${batch.items.length} 条记录</div>
    ${batch.lastError ? `<p class="conflict-reason">${escapeHtml(batch.lastError)}</p>` : ''}
    <div class="inline-actions">
      ${canRetry ? `<button class="ghost" data-retry-batch="${batch.tempId}">重新补传</button>` : ''}
      <button class="ghost" data-drop-batch="${batch.tempId}">移除</button>
    </div>
  </article>`;
}

function renderSyncBatch(batch) {
  const meta = SYNC_STATUS[batch.status] || { label: batch.status, tone: '' };
  const count = (batch.items || []).length;
  let detail = '';
  if (batch.status === 'conflict' && batch.conflictReason) {
    detail = `<p class="conflict-reason">${escapeHtml(batch.conflictReason)}</p>`;
  } else if (batch.status === 'pending-review') {
    detail = `<p class="conflict-reason">与首次补传内容不一致，两份记录均已留存待核对${batch.duplicateOf ? `（原批次 ${escapeHtml(batch.duplicateOf)}）` : ''}</p>`;
  } else if (batch.status === 'replayed') {
    detail = `<p class="meta">同号重放，沿用首次结果，未重复写入</p>`;
  } else if (batch.result) {
    detail = `<p class="meta">共同步 ${batch.result.applied || count} 条巡测记录</p>`;
  }
  return `<article class="card">
    <div class="card-head">
      <h3>现场单号 ${escapeHtml(batch.ticketNo)}</h3>
      ${pill(meta.label, meta.tone)}
    </div>
    <div class="meta">${fmtDate(batch.createdAt)} · ${count} 条记录</div>
    ${detail}
  </article>`;
}

function renderSyncView() {
  const outbox = outboxLoad().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const history = [...(state.db.syncBatches || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const offline = !navigator.onLine;
  return `<section class="view" id="sync">
    ${renderStats()}
    <div class="panel">
      <h2>离线补传 <span class="online-dot ${offline ? 'off' : 'on'}">${offline ? '当前离线' : '网络正常'}</span></h2>
      <p class="hint">深层区无信号时，巡测记录先保存在本机；恢复联网后按现场单号顺序整批补传，同号重放沿用首次结果，内容不同留两份待核对，冲突整批停写并保留本机记录。</p>
      <div class="actions"><button id="syncNowBtn" ${outbox.length ? '' : 'disabled'}>立即补传</button></div>
      <div class="list" id="outboxList">${outbox.length ? outbox.map(renderOutboxBatch).join('') : '<div class="empty">本机暂无待补传记录</div>'}</div>
    </div>
    <div class="panel">
      <h2>补传记录</h2>
      <div class="list">${history.length ? history.map(renderSyncBatch).join('') : '<div class="empty">暂无补传记录</div>'}</div>
    </div>
  </section>`;
}

async function uploadOutbox({ manual = false } = {}) {
  let list = outboxLoad();
  const queue = list
    .filter((b) => ['pending', 'error'].includes(b.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!queue.length) {
    if (manual) toast('没有待补传记录');
    return;
  }
  let stopped = false;
  for (const batch of queue) {
    batch.status = 'uploading';
    outboxSave(list);
    if (state.activeTab === 'sync') document.querySelector('#outboxList') && (document.querySelector('#outboxList').innerHTML = list.map(renderOutboxBatch).join(''));
    try {
      const res = await api('/api/sync', {
        method: 'POST',
        body: JSON.stringify({ ticketNo: batch.ticketNo, batchId: batch.tempId, items: batch.items.map((i) => ({ kind: i.kind, tempId: i.tempId, payload: i.payload })) })
      });
      batch.attempts += 1;
      if (res.status === 'applied' || res.status === 'replayed') {
        batch.status = 'done';
        batch.lastError = '';
      } else if (res.status === 'pending-review') {
        batch.status = 'review';
        batch.lastError = '内容与首次补传不一致，已留两份待核对';
      }
    } catch (err) {
      batch.attempts += 1;
      if (err.status === 409) {
        batch.status = 'conflict';
        batch.lastError = (err.body && err.body.error) || '样点已被关闭，整批停写';
      } else {
        batch.status = 'error';
        batch.lastError = err.message === 'NETWORK' ? '网络未恢复，记录保留在本机' : err.message;
      }
      stopped = true; // 整批停写：冲突或断网都不再继续后续批次
      outboxSave(list);
      break;
    }
    outboxSave(list);
  }
  // 已完成的批次从本机出箱移除，服务端已有存档
  list = outboxLoad().filter((b) => b.status !== 'done');
  outboxSave(list);
  await load();
  if (stopped) {
    const blocked = outboxLoad().find((b) => b.status === 'conflict' || b.status === 'error');
    toast(`补传已暂停：${blocked ? blocked.lastError : '请稍后重试'}`);
  } else {
    toast('补传完成');
  }
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}${view.id === 'sync' ? outboxBadge() : ''}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function refreshTabBadges() {
  const tab = $$('.tab').find((el) => el.dataset.tab === 'sync');
  if (!tab) return;
  const existing = tab.querySelector('.badge');
  if (existing) existing.remove();
  const badge = outboxBadge();
  if (badge) tab.insertAdjacentHTML('beforeend', badge);
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'sync') return renderSyncView();
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
  refreshTabBadges();
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const payload = values(form, view);
  const collection = form.dataset.create;
  // 巡测记录：断网或请求失败时进本机出箱，联网后按现场单号补传
  if (collection === 'surveys' && !navigator.onLine) {
    outboxQueueSurvey(payload);
    form.reset();
    render();
    toast('已存入本机离线记录，联网后按现场单号补传');
    return;
  }
  try {
    await api(`/api/${collection}`, { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    toast('已保存');
  } catch (err) {
    if (collection === 'surveys' && (err.status === 0 || err.status >= 500)) {
      outboxQueueSurvey(payload);
      form.reset();
      render();
      toast('网络异常，已存入本机离线记录，恢复后续传');
      return;
    }
    toast(err.message);
  }
  await load();
});

document.addEventListener('click', async (event) => {
  const retry = event.target.closest('[data-retry-batch]');
  const drop = event.target.closest('[data-drop-batch]');
  if (drop) {
    const list = outboxLoad().filter((b) => b.tempId !== drop.dataset.dropBatch);
    outboxSave(list);
    render();
    toast('已移除本机记录');
    return;
  }
  if (retry) {
    const list = outboxLoad();
    const batch = list.find((b) => b.tempId === retry.dataset.retryBatch);
    if (batch) {
      batch.status = 'pending';
      batch.lastError = '';
      outboxSave(list);
    }
    await uploadOutbox({ manual: true });
    return;
  }
  if (event.target.closest('#syncNowBtn')) {
    await uploadOutbox({ manual: true });
  }
});

window.addEventListener('online', () => {
  if (outboxLoad().some((b) => ['pending', 'error'].includes(b.status))) {
    uploadOutbox();
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));

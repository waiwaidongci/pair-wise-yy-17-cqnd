// 离线补传入口（页面入口职责独立，不改动看板/筛选原有逻辑）。
// 深层区断网时：巡测记录与样点标记按现场单号成对暂存本机；
// 回洞口联网后：队列按原始顺序（FIFO）自动续传，失败不丢、可手动重试。
(function () {
  const QUEUE_KEY = 'cave-sync-queue-v1';
  const DRILL_KEY = 'cave-sync-offline-drill';

  const running = { busy: false };

  function esc(value = '') {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadQueue() {
    try {
      const list = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveQueue(list) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  }

  function db() {
    return window.caveApp?.state?.db || {};
  }

  function siteLabel(siteId) {
    const site = (db().sites || []).find((entry) => entry.id === siteId);
    if (!site) return '未关联样点';
    return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
  }

  function siteOptions(selected = '') {
    return (db().sites || [])
      .map((site) => `<option value="${esc(site.id)}" ${site.id === selected ? 'selected' : ''}>${esc(siteLabel(site.id))}</option>`)
      .join('');
  }

  function statusMeta(status) {
    const map = {
      pending: { label: '待补传', tone: 'warn' },
      failed: { label: '补传失败', tone: 'bad' },
      conflict: { label: '冲突停写', tone: 'bad' },
      applied: { label: '补传成功', tone: 'ok' },
      replayed: { label: '沿用首次结果', tone: 'ok' },
      'pending-review': { label: '异文待核对', tone: 'warn' }
    };
    return map[status] || { label: status || '未知', tone: '' };
  }

  function pill(status) {
    const meta = statusMeta(status);
    return `<span class="pill ${meta.tone}">${esc(meta.label)}</span>`;
  }

  function fmt(value) {
    if (!value) return '';
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  }

  function formHtml() {
    const drill = localStorage.getItem(DRILL_KEY) === '1';
    return `
    <div class="panel sync-form-panel">
      <h2>深层区离线登记</h2>
      <p class="meta">断网期间巡测记录与样点标记按同一现场单号成对暂存手机，回洞口后在下方队列补传；样点档案以服务端受理结果为准，本地不会直接改动。</p>
      <form id="syncForm" class="form-grid">
        <label>现场单号<input name="ticketNo" required placeholder="如 XC-20260929-03"></label>
        <label>队伍<input name="team" required placeholder="如 甲班 / 一队"></label>
        <label class="wide">样点<select name="siteId" required>${siteOptions()}</select></label>
        <label>巡测人员<input name="surveyor" required></label>
        <label>日期<input type="date" name="date" required value="${today()}"></label>
        <label>温度<input type="number" step="0.1" name="temperature" required></label>
        <label>湿度<input type="number" name="humidity" required></label>
        <label>CO2<input type="number" name="co2" required></label>
        <label>滴水频率<input type="number" name="dripRate" required></label>
        <label>样点标记
          <select name="protectedStatus">
            <option>常规观察</option>
            <option>重点保护</option>
            <option>暂停开放</option>
          </select>
        </label>
        <label>照片链接<input name="photoUrl"></label>
        <label class="wide">游客干扰痕迹<textarea name="disturbance"></textarea></label>
        <label class="wide">标记说明（可选）<textarea name="markNote"></textarea></label>
        <div class="actions wide">
          <button type="submit">暂存本机（两份一起）</button>
        </div>
      </form>
      <div class="sync-drill">
        <label class="inline-check"><input type="checkbox" id="offlineDrill" ${drill ? 'checked' : ''}> 离线演练（勾选后即使联网也只暂存、不补传）</label>
      </div>
    </div>`;
  }

  function queueCard(item) {
    const open = ['pending', 'failed', 'conflict'].includes(item.status);
    const s = item.survey || {};
    const mark = item.siteMark || {};
    const detail = `
      <div class="detail">
        <div>队伍<br><strong>${esc(item.team || '-')}</strong></div>
        <div>样点<br><strong>${esc(siteLabel(s.siteId))}</strong></div>
        <div>日期<br><strong>${esc(s.date || '-')}</strong></div>
        <div>巡测员<br><strong>${esc(s.surveyor || '-')}</strong></div>
        <div>温/湿/CO2<br><strong>${esc(s.temperature)} / ${esc(s.humidity)} / ${esc(s.co2)}</strong></div>
        <div>样点标记<br><strong>${esc(mark.protectedStatus || '-')}</strong></div>
      </div>`;
    const banner = item.status === 'conflict' && item.conflict
      ? `<div class="sync-banner bad">冲突来源：${esc(item.conflict.team)}（巡测员 ${esc(item.conflict.surveyor || '未知')}）在 ${esc(item.conflict.date)} 的有效巡测，现场单号 ${esc(item.conflict.ticketNo)}，已将该样点关闭。整批未写入。</div>`
      : item.status === 'failed'
        ? `<div class="sync-banner bad">补传失败：${esc(item.error || '网络异常')}，记录保留，将按原顺序续传。</div>`
        : item.status === 'pending-review'
          ? `<div class="sync-banner warn">${esc(item.note || '与首次补传内容不同，两份留档待核对，样点档案未改动')}</div>`
          : '';
    const actions = `
      <div class="actions">
        ${open ? `<button data-sync-retry="${esc(item.localId)}" class="ghost">立即补传</button>` : ''}
        ${item.status === 'applied' || item.status === 'replayed' || item.status === 'pending-review'
          ? `<button data-sync-remove="${esc(item.localId)}" class="ghost">清除本地副本</button>`
          : ''}
        ${item.status === 'failed' || item.status === 'conflict'
          ? `<button data-sync-discard="${esc(item.localId)}" class="ghost danger-text">放弃该单（服务端无存档）</button>`
          : ''}
      </div>`;
    return `<article class="card sync-card ${open ? 'open' : ''}">
      <div class="card-head">
        <h3>${esc(item.ticketNo)}</h3>
        <div>${pill(item.status)}</div>
      </div>
      <div class="meta">入队时间 ${fmt(item.enqueuedAt)}${item.processedAt ? ` · 最近处理 ${fmt(item.processedAt)}` : ''}</div>
      ${detail}
      ${banner}
      ${actions}
    </article>`;
  }

  function queueHtml() {
    const list = loadQueue();
    const open = list.filter((item) => ['pending', 'failed', 'conflict'].includes(item.status));
    const done = list.filter((item) => !['pending', 'failed', 'conflict'].includes(item.status));
    const online = navigator.onLine && localStorage.getItem(DRILL_KEY) !== '1';
    const banner = open.length
      ? `<div class="sync-banner ${online ? 'ok' : 'warn'}">${online ? `已联网，${open.length} 单待按序补传` : `处于断网/离线演练状态，${open.length} 单已安全暂存本机，联网后自动续传`}</div>`
      : '<div class="sync-banner ok">本地待补队列已清空</div>';
    return `
    <div class="panel">
      <h2>本地补传队列</h2>
      ${banner}
      <div class="actions">
        <button id="syncFlush" ${!open.length ? 'disabled' : ''}>立即联网补传</button>
      </div>
      <h3 class="sync-sub">待补（按原始顺序续传）</h3>
      <div class="list">${open.length ? open.map(queueCard).join('') : '<div class="empty">暂无待补记录</div>'}</div>
      <h3 class="sync-sub">已处理（本地副本）</h3>
      <div class="list">${done.length ? done.map(queueCard).join('') : '<div class="empty">暂无已处理记录</div>'}</div>
    </div>`;
  }

  function archiveHtml() {
    const batches = (db().syncBatches || []).filter(
      (batch) => batch.outcome === 'pending-review' || batch.outcome === 'conflict'
    );
    const cards = batches
      .map((batch) => {
        const isConflict = batch.outcome === 'conflict';
        const banner = isConflict && batch.conflict
          ? `<div class="sync-banner bad">冲突来源：${esc(batch.conflict.team)} · ${esc(batch.conflict.surveyor || '未知')} · ${esc(batch.conflict.date)} · 对方单号 ${esc(batch.conflict.ticketNo)}</div>`
          : `<div class="sync-banner warn">${esc(batch.note || '同号内容不同，两份并存待核对')}</div>`;
        return `<article class="card">
          <div class="card-head"><h3>${esc(batch.ticketNo)}</h3>${pill(isConflict ? 'conflict' : 'pending-review')}</div>
          <div class="meta">队伍 ${esc(batch.team)} · 样点 ${esc(siteLabel(batch.siteId))} · 存档时间 ${fmt(batch.createdAt)}</div>
          ${banner}
        </article>`;
      })
      .join('');
    return `
    <div class="panel">
      <h2>服务端待核对存档</h2>
      <p class="meta">同号异文的两份记录、整批停写的冲突留痕都保存在服务端，样点档案未被改动。</p>
      <div class="list">${cards || '<div class="empty">暂无待核对存档</div>'}</div>
    </div>`;
  }

  function renderView() {
    return `<section class="view" id="syncView">
      <div class="sync-grid">
        ${formHtml()}
        <div class="sync-side">
          ${queueHtml()}
        </div>
      </div>
      ${archiveHtml()}
    </section>`;
  }

  function readForm(form) {
    const f = Object.fromEntries(new FormData(form).entries());
    return {
      ticketNo: String(f.ticketNo || '').trim(),
      team: String(f.team || '').trim(),
      survey: {
        siteId: f.siteId,
        surveyor: f.surveyor,
        date: f.date,
        temperature: Number(f.temperature || 0),
        humidity: Number(f.humidity || 0),
        co2: Number(f.co2 || 0),
        dripRate: Number(f.dripRate || 0),
        photoUrl: f.photoUrl || '',
        disturbance: f.disturbance || ''
      },
      siteMark: {
        siteId: f.siteId,
        protectedStatus: f.protectedStatus,
        note: f.markNote || ''
      }
    };
  }

  async function postBatch(bundle) {
    const res = await fetch('/api/sync/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  // 按入队原顺序逐条补传；网络失败立即停住（后面的单保持原序等待），单批业务冲突不影响其他单号
  async function flush() {
    if (running.busy) return;
    if (localStorage.getItem(DRILL_KEY) === '1') return;
    running.busy = true;
    const list = loadQueue();
    let anyApplied = false;
    for (const item of list) {
      if (!['pending', 'failed'].includes(item.status)) continue;
      item.status = 'pending';
      item.error = '';
      saveQueue(list);
      rerenderLocal();
      try {
        const { status, body } = await postBatch({ ticketNo: item.ticketNo, team: item.team, survey: item.survey, siteMark: item.siteMark });
        item.processedAt = new Date().toISOString();
        if (status === 201) {
          item.status = 'applied';
          item.result = body.result;
          anyApplied = true;
        } else if (status === 200 && body.outcome === 'replayed') {
          item.status = 'replayed';
          item.note = body.note;
          anyApplied = true;
        } else if (status === 200 && body.outcome === 'pending-review') {
          item.status = 'pending-review';
          item.note = body.note;
          anyApplied = true; // 服务端新增了待核对存档，需刷新存档面板
        } else if (status === 409) {
          item.status = 'conflict';
          item.error = body.error || '整批停写';
          item.conflict = body.conflict || null;
        } else {
          item.status = 'failed';
          item.error = body.error || `服务端异常（${status}）`;
        }
      } catch (error) {
        // 断网：停在当前位置保持原序，恢复后仍按原顺序续传；
        // 服务端已裁定的冲突/待核对属于单批结论，不阻塞队列后续单号
        item.status = 'failed';
        item.error = '网络不可达，记录保留，联网后续传';
        item.processedAt = new Date().toISOString();
        saveQueue(list);
        rerenderLocal();
        running.busy = false;
        return;
      }
      saveQueue(list);
      rerenderLocal();
    }
    running.busy = false;
    if (anyApplied && window.caveApp?.load) await window.caveApp.load();
  }

  function rerenderLocal() {
    const side = document.querySelector('#syncView .sync-side');
    if (side) side.innerHTML = queueHtml();
  }

  function mount() {
    const root = document.getElementById('syncView');
    if (!root) return;

    root.addEventListener('submit', (event) => {
      const form = event.target.closest('#syncForm');
      if (!form) return;
      event.preventDefault();
      const bundle = readForm(form);
      const list = loadQueue();
      const duplicated = list.some(
        (item) => item.ticketNo === bundle.ticketNo && ['pending', 'failed', 'conflict'].includes(item.status)
      );
      if (duplicated) {
        window.alert(`现场单号 ${bundle.ticketNo} 已在待补队列，禁止重复暂存；补传时服务端会按单号判重。`);
        return;
      }
      list.push({
        localId: `local-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        ...bundle,
        status: 'pending',
        enqueuedAt: new Date().toISOString()
      });
      saveQueue(list);
      form.reset();
      form.querySelector('[name="date"]').value = today();
      rerenderLocal();
      if (navigator.onLine && localStorage.getItem(DRILL_KEY) !== '1') flush();
    });

    root.addEventListener('click', async (event) => {
      const flushBtn = event.target.closest('#syncFlush');
      const retry = event.target.closest('[data-sync-retry]');
      const remove = event.target.closest('[data-sync-remove]');
      const discard = event.target.closest('[data-sync-discard]');
      if (flushBtn) return flush();
      if (retry) {
        const list = loadQueue();
        const item = list.find((entry) => entry.localId === retry.dataset.syncRetry);
        if (item && (item.status === 'conflict' || item.status === 'failed')) {
          item.status = 'failed';
          item.error = item.error || '手动重试';
          saveQueue(list);
        }
        return flush();
      }
      if (remove) {
        saveQueue(loadQueue().filter((entry) => entry.localId !== remove.dataset.syncRemove));
        return rerenderLocal();
      }
      if (discard) {
        if (!window.confirm('放弃后本地副本将删除，且服务端无该单存档。确认放弃？')) return;
        saveQueue(loadQueue().filter((entry) => entry.localId !== discard.dataset.syncDiscard));
        return rerenderLocal();
      }
    });

    root.addEventListener('change', (event) => {
      if (event.target.id === 'offlineDrill') {
        localStorage.setItem(DRILL_KEY, event.target.checked ? '1' : '0');
        rerenderLocal();
        if (!event.target.checked && navigator.onLine) flush();
      }
    });

    if (!window.__caveSyncOnlineBound) {
      window.addEventListener('online', () => {
        if (document.getElementById('syncView')) flush();
      });
      window.__caveSyncOnlineBound = true;
    }

    if (navigator.onLine && localStorage.getItem(DRILL_KEY) !== '1') {
      setTimeout(flush, 300);
    }
  }

  window.SyncView = { renderView, mount, flush };
})();

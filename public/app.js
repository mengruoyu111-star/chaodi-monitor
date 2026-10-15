/**
 * 抄底红线监测器 —— 前端
 * 纯原生 ES 模块，无任何构建步骤与第三方依赖。
 */

const $ = (id) => document.getElementById(id);

const TONE = {
  calm: '#64748b',
  low: '#4c9aff',
  mid: '#ffb020',
  high: '#ff8a4c',
  extreme: '#ff4d5e',
};

const state = {
  data: null,
  mode: 'unknown',   // local = 本地 Node 服务；static = 云端只读快照
  prevFlags: null,
  alertsEnabled: localStorage.getItem('chaodi.alerts') === '1',
  notifiedAt: 0,
};

const isStatic = () => state.mode === 'static';

/** 根据运行模式显隐界面元素 */
function applyMode() {
  const readOnly = isStatic();
  document.body.classList.toggle('static-mode', readOnly);
  $('modeBadge').hidden = !readOnly;
  $('readonlyNote').hidden = !readOnly;
  if (readOnly) {
    $('settingsBody').hidden = true;
    document.title = document.title.replace(/^\(\d+\/\d+\)\s*/, '');
  }
}

/* ------------------------------- 工具 ------------------------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = text;
  $('toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = '.3s';
    setTimeout(() => el.remove(), 320);
  }, 6000);
}

/** 用 WebAudio 合成提示音，免去音频文件 */
function beep(times = 3) {
  if (!state.alertsEnabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    for (let i = 0; i < times; i += 1) {
      const t0 = ctx.currentTime + i * 0.26;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(i === times - 1 ? 1180 : 880, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    }
    setTimeout(() => ctx.close(), times * 300 + 400);
  } catch { /* 忽略音频异常 */ }
}

function notify(title, body) {
  if (!state.alertsEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      tag: 'chaodi-redline',
      requireInteraction: false,
      icon: 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📉</text></svg>"),
    });
    setTimeout(() => n.close(), 20000);
  } catch { /* 忽略通知异常 */ }
}

/* ------------------------------ 渲染 ------------------------------ */
function renderStatus() {
  const s = state.data?.state ?? {};

  if (isStatic()) {
    // 只读快照：没有刷新能力，只展示构建时间
    $('statusPill').className = `status-pill ${s.status === 'error' ? 'err' : 'ok'}`;
    $('statusText').textContent = `快照 · ${state.data.builtAt ?? s.updatedAt ?? '—'}`;
    $('metaMarket').textContent = s.marketOpen ? '交易时段' : '非交易时段';
    $('metaUpdated').textContent = s.updatedAt ?? '—';
    $('metaNext').textContent = '由定时任务刷新';
    $('sourceMeta').textContent = `构建于 ${state.data.builtAt} · 耗时 ${state.data.buildElapsedMs}ms`;
    return;
  }

  const busy = s.status === 'refreshing';
  const err = s.status === 'error';
  $('statusPill').className = `status-pill ${busy ? 'busy' : err ? 'err' : 'ok'}`;
  $('statusText').textContent = busy
    ? '正在刷新…'
    : err
      ? '刷新失败'
      : `${s.marketOpen ? '盘中' : '盘后'} · ${s.updatedAt ?? '—'}`;
  $('metaMarket').textContent = s.marketOpen ? '交易时段' : '非交易时段';
  $('metaUpdated').textContent = s.updatedAt ?? '—';
  $('metaNext').textContent = s.nextRefreshAt
    ? new Date(s.nextRefreshAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '—';
  $('sourceMeta').textContent = state.data?.rawMeta
    ? `抓取于 ${state.data.rawMeta.fetchedAt} · 耗时 ${state.data.rawMeta.elapsedMs}ms`
    : '—';
}

function renderHero() {
  const r = state.data?.result;
  const summary = r?.summary;
  const hero = $('hero');
  if (!summary) {
    $('heroCount').textContent = '—';
    return;
  }
  const accent = TONE[summary.tone] ?? TONE.calm;
  hero.style.setProperty('--accent', accent);
  $('scoreRing').style.setProperty('--accent', accent);

  $('heroCount').textContent = summary.triggered;
  $('heroTotal').textContent = summary.total;
  $('heroLevel').textContent = summary.level;
  $('heroAction').textContent = summary.action;
  $('heroPosition').textContent = summary.position;

  const C = 2 * Math.PI * 52;
  $('ringFg').style.strokeDashoffset = String(C * (1 - summary.score / 100));
  $('scoreValue').textContent = summary.score;

  $('stripHint').textContent = summary.triggered >= 6
    ? `已达 ${summary.triggered} 条，满足动手原则下限`
    : `还需 ${6 - summary.triggered} 条才到 6 条动手下限`;
  document.title = `(${summary.triggered}/${summary.total}) 抄底红线监测器`;
}

function renderStrip() {
  const items = state.data?.result?.items ?? [];
  $('strip').innerHTML = items.map((it) => `
    <div class="strip-cell ${it.triggered === true ? 'hit' : it.triggered === null ? 'unknown' : ''}"
         title="${esc(it.name)}：${esc(it.valueText)} ${esc(it.thresholdText)}">
      <span class="num">${it.id}</span>
      <span class="lbl">${esc(it.short)}</span>
    </div>`).join('');
}

const MANUAL_KEYS = new Set(['rateHike', 'sentiment', 'tech', 'sizeRatio']);

function renderGrid() {
  const items = state.data?.result?.items ?? [];
  $('grid').innerHTML = items.map((it) => {
    const cls = it.triggered === true ? 'hit' : it.triggered === null ? 'unknown' : 'safe';
    const badge = it.triggered === true
      ? '<span class="badge hit">已触发红线</span>'
      : it.triggered === null
        ? '<span class="badge">无数据</span>'
        : '<span class="badge safe">未触发</span>';

    const rows = (it.rows ?? []).map((row) => `
      <div class="ind-row ${row.tone === 'warn' ? 'warn' : ''}">
        <span class="k">${esc(row.label)}</span><span class="val">${esc(row.value)}</span>
      </div>`).join('');

    return `
      <article class="ind ${cls}">
        <header class="ind-head">
          <span class="ind-idx">${it.id}</span>
          <div class="ind-title">
            <h3>${esc(it.name)}</h3>
            <span class="sub">${it.mode === 'manual' ? '手动维护' : '自动抓取'}</span>
          </div>
          ${badge}
        </header>
        <div class="ind-value">
          <span class="v">${esc(it.valueText)}</span>
          <span class="th">红线 ${esc(it.thresholdText)}</span>
        </div>
        <p class="ind-detail">${esc(it.detail)}</p>
        ${rows ? `<div class="ind-rows">${rows}</div>` : ''}
        <div class="ind-actions">${renderActions(it)}</div>
        <footer class="ind-foot">
          <span>${esc(it.source || '—')}</span>
          <span>${esc(it.observedAt || '')}</span>
        </footer>
      </article>`;
  }).join('');
}

function renderActions(it) {
  if (isStatic()) return ''; // 只读快照不提供任何写操作
  const btns = [];
  if (MANUAL_KEYS.has(it.key)) {
    const on = it.triggered === true;
    btns.push(`<button class="btn btn-mini" data-toggle="${it.key}" data-value="${on ? 'false' : 'true'}">${on ? '取消红线' : '标记为已触发'}</button>`);
  }
  if (it.key === 'vix1000') {
    const v = state.data?.config?.manual?.vix1000?.value;
    btns.push(`<button class="btn btn-mini" data-input="vix1000">${v ? `手动值 ${v}（点击修改）` : '手动录入数值'}</button>`);
  }
  if (it.key === 'sentiment') {
    const v = state.data?.config?.manual?.sentiment?.value;
    btns.push(`<button class="btn btn-mini" data-input="sentiment">${v !== null && v !== undefined ? `情绪值 ${v}（点击修改）` : '录入情绪指数'}</button>`);
  }
  if (it.key === 'pcr') {
    btns.push('<button class="btn btn-mini" data-scroll="settings">手动修正 PCR →</button>');
  }
  return btns.join('');
}

/* ------------------------------- 图表 ------------------------------- */
function renderChart() {
  const points = state.data?.history ?? [];
  const svg = $('chart');
  const W = 900;
  const H = 240;
  const PAD = { l: 34, r: 14, t: 16, b: 26 };

  if (points.length < 1) {
    svg.innerHTML = '';
    $('chartEmpty').hidden = false;
    $('chartRange').textContent = '—';
    return;
  }
  $('chartEmpty').hidden = true;

  const xs = (i) => (points.length === 1
    ? PAD.l + (W - PAD.l - PAD.r) / 2
    : PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const ys = (v) => PAD.t + (1 - v / 12) * (H - PAD.t - PAD.b);

  const parts = [];
  // 背景网格
  for (let v = 0; v <= 12; v += 3) {
    parts.push(`<line x1="${PAD.l}" y1="${ys(v)}" x2="${W - PAD.r}" y2="${ys(v)}" stroke="#1a2431" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.l - 8}" y="${ys(v) + 4}" text-anchor="end" fill="#64748b" font-size="11" font-family="monospace">${v}</text>`);
  }
  // 参考线 6 / 9
  parts.push(`<line x1="${PAD.l}" y1="${ys(6)}" x2="${W - PAD.r}" y2="${ys(6)}" stroke="#ffb020" stroke-width="1" stroke-dasharray="5 5" opacity=".65"/>`);
  parts.push(`<text x="${W - PAD.r}" y="${ys(6) - 5}" text-anchor="end" fill="#ffb020" font-size="11">6 条 · 底仓</text>`);
  parts.push(`<line x1="${PAD.l}" y1="${ys(9)}" x2="${W - PAD.r}" y2="${ys(9)}" stroke="#23c98b" stroke-width="1" stroke-dasharray="5 5" opacity=".65"/>`);
  parts.push(`<text x="${W - PAD.r}" y="${ys(9) - 5}" text-anchor="end" fill="#23c98b" font-size="11">9 条 · 动手</text>`);

  // 面积 + 折线
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.count).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(points.length - 1).toFixed(1)},${ys(0)} L${xs(0).toFixed(1)},${ys(0)} Z`;
  parts.push(`<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ff4d5e" stop-opacity=".35"/>
      <stop offset="100%" stop-color="#ff4d5e" stop-opacity="0"/>
    </linearGradient></defs>`);
  parts.push(`<path d="${area}" fill="url(#areaGrad)"/>`);
  parts.push(`<path d="${line}" fill="none" stroke="#ff4d5e" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);

  // 数据点（点多时只画最后一个）
  if (points.length <= 60) {
    points.forEach((p, i) => {
      parts.push(`<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.count).toFixed(1)}" r="3" fill="#0d1219" stroke="#ff4d5e" stroke-width="1.8"/>`);
    });
  }
  const last = points[points.length - 1];
  parts.push(`<circle cx="${xs(points.length - 1).toFixed(1)}" cy="${ys(last.count).toFixed(1)}" r="4.5" fill="#ff4d5e"/>`);
  parts.push(`<text x="${xs(points.length - 1) - 6}" y="${ys(last.count) - 10}" text-anchor="end" fill="#ff8f9b" font-size="12" font-family="monospace">${last.count}</text>`);

  // 首末日期
  parts.push(`<text x="${PAD.l}" y="${H - 6}" fill="#64748b" font-size="11" font-family="monospace">${esc(points[0].date)}</text>`);
  parts.push(`<text x="${W - PAD.r}" y="${H - 6}" text-anchor="end" fill="#64748b" font-size="11" font-family="monospace">${esc(last.date)}</text>`);

  svg.innerHTML = parts.join('');
  $('chartRange').textContent = `${points.length} 个记录点 · ${points[0].date} ~ ${last.date}`;
}

/* ------------------------------ 数据源 ------------------------------ */
function renderSources() {
  const meta = state.data?.rawMeta;
  const list = $('sourceList');
  if (!meta) {
    list.innerHTML = '<li><span class="name">尚未抓取</span></li>';
    return;
  }
  const counts = meta.counts ?? {};
  const rows = [
    { name: '东方财富 · 实时行情 / 日K线', ok: true, msg: `${state.data?.result?.items?.length ?? 0} 个指标已计算` },
    { name: '东方财富 · 融资融券余额', ok: (counts.marginRows ?? 0) > 0, msg: `${counts.marginRows ?? 0} 条历史` },
    { name: '期权论坛 · QVIX', ok: (counts.qvixRows ?? 0) > 0, msg: `${counts.qvixRows ?? 0} 行（中证1000 序列已停更）` },
    { name: '新浪 · 中金所期权链', ok: (counts.sinaIoMonths ?? 0) + (counts.sinaMoMonths ?? 0) > 0, msg: `IO ${counts.sinaIoMonths ?? 0} 月 / MO ${counts.sinaMoMonths ?? 0} 月` },
    { name: '东方财富 · 中金所期权链', ok: (counts.cffexChain ?? 0) > 0, msg: (counts.cffexChain ?? 0) > 0 ? `${counts.cffexChain} 个合约` : '本次被限流' },
    { name: '东方财富 · ETF 期权链', ok: (counts.etfChain ?? 0) > 0, msg: (counts.etfChain ?? 0) > 0 ? `${counts.etfChain} 个合约` : '本次被限流' },
  ];
  if (meta.impliedVol) {
    rows.push({ name: '中证1000 隐波（自算）', ok: true, msg: `剩 ${meta.impliedVol.days} 天 · ${meta.impliedVol.method}` });
  }
  for (const e of meta.errors ?? []) {
    rows.push({ name: e.source, ok: false, msg: e.message });
  }
  list.innerHTML = rows.map((r) => `
    <li>
      <span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '●' : '✕'}</span>
      <span class="name">${esc(r.name)}</span>
      <span class="msg">${esc(r.msg)}</span>
    </li>`).join('');
}

/* ------------------------------ 设置面板 ------------------------------ */
const THRESHOLD_FIELDS = [
  ['vix1000', '中证1000 VIX 红线'],
  ['margin', '融资余额红线（万亿）'],
  ['marginAlt', '融资余额空仓修正位（万亿）'],
  ['imBasis', 'IM 贴水红线（点）'],
  ['bigBear', '大阴线根数'],
  ['imPrice', 'IM 点位红线'],
  ['kc50', '科创50 红线'],
  ['sentiment', '韭圈情绪极值线'],
  ['sentimentCompensation', '情绪补偿阈值'],
  ['pcrLow', '单个 PCR 低估线'],
  ['pcrNeed', 'PCR 触发个数'],
];

const PARAM_FIELDS = [
  ['bigBear', 'windowDays', '大阴线观察窗口（交易日）'],
  ['bigBear', 'dropPct', '大阴线单日跌幅（%）'],
  ['volume', 'volMa', '成交量均线周期'],
  ['volume', 'shrinkRatio', '缩量比例（均量倍数）'],
  ['volume', 'shrinkDays', '最少缩量天数'],
  ['volume', 'expandRatio', '放量比例（均量倍数）'],
  ['volume', 'dropPct', '放量下跌幅度（%）'],
  ['volume', 'lookbackDays', '放量大跌回看天数'],
  ['sizeRatio', 'nearMaxRatio', '判定接近最高值的比例'],
];

function renderSettings() {
  const cfg = state.data?.config;
  if (!cfg) return;
  const sets = [];

  sets.push(`<div class="field-set"><h3>红线阈值</h3>${
    THRESHOLD_FIELDS.map(([k, label]) => `
      <div class="field"><label>${esc(label)}</label>
        <input type="number" step="any" data-threshold="${k}" value="${cfg.thresholds[k] ?? ''}"></div>`).join('')
  }</div>`);

  sets.push(`<div class="field-set"><h3>算法参数</h3>${
    PARAM_FIELDS.map(([g, k, label]) => `
      <div class="field"><label>${esc(label)}</label>
        <input type="number" step="any" data-param="${g}.${k}" value="${cfg.params[g][k] ?? ''}"></div>`).join('')
  }
    <div class="field"><label>大阴线幅度口径</label>
      <select data-param="bigBear.sizeBasis">
        <option value="pct"${cfg.params.bigBear.sizeBasis === 'pct' ? ' selected' : ''}>按涨跌幅</option>
        <option value="body"${cfg.params.bigBear.sizeBasis === 'body' ? ' selected' : ''}>按实体跌幅</option>
      </select></div>
    <div class="field"><label>PCR 方向</label>
      <select data-param="pcr.direction">
        <option value="below"${cfg.params.pcr.direction === 'below' ? ' selected' : ''}>低于阈值算低估</option>
        <option value="above"${cfg.params.pcr.direction === 'above' ? ' selected' : ''}>高于阈值算触发</option>
      </select></div>
  </div>`);

  const manualSpec = [
    ['sizeRatio', '大盘小盘比 MAX', '锁定为已触发（原文：触发即始终有效）'],
    ['rateHike', '6月4次加息率提升', '标记为已触发（需跟踪，可能回落）'],
    ['tech', '6大科技点位', '标记为已到位置'],
  ];
  sets.push(`<div class="field-set"><h3>手动指标</h3>${
    manualSpec.map(([k, label, hint]) => {
      const on = cfg.manual[k]?.triggered === true;
      return `<div class="field"><label title="${esc(hint)}">${esc(label)}</label>
        <span class="switch">
          <button data-manual="${k}" data-value="${on ? 'false' : 'true'}" class="${on ? 'on' : ''}">${on ? '已触发红线' : '未触发'}</button>
        </span></div>`;
    }).join('')
  }</div>`);

  sets.push(`<div class="field-set"><h3>手动数值</h3>
    <div class="field"><label>中证1000 VIX</label>
      <input type="number" step="any" data-manual-value="vix1000" value="${cfg.manual.vix1000?.value ?? ''}" placeholder="自动计算"></div>
    <div class="field"><label>韭圈情绪指数</label>
      <input type="number" step="any" data-manual-value="sentiment" value="${cfg.manual.sentiment?.value ?? ''}" placeholder="未录入"></div>
    <div class="field"><label>情绪补偿值</label>
      <input type="number" step="any" data-manual-value="sentiment.compensation" value="${cfg.manual.sentiment?.compensation ?? ''}" placeholder="无"></div>
  </div>`);

  sets.push(`<div class="field-set"><h3>PCR 手动修正（留空用自动值）</h3>${
    Object.keys(cfg.pcrValues ?? {}).map((k) => `
      <div class="field"><label>${esc(k)}</label>
        <input type="number" step="any" data-pcr="${esc(k)}" value="${cfg.pcrValues[k] ?? ''}" placeholder="自动"></div>`).join('')
  }</div>`);

  sets.push(`<div class="field-set"><h3>刷新与提醒</h3>
    <div class="field"><label>盘中刷新间隔（秒）</label>
      <input type="number" step="10" min="30" max="3600" data-refresh value="${cfg.refreshSeconds}"></div>
    <div class="field"><label>桌面通知</label>
      <span class="switch"><button data-alert="notify" data-value="${cfg.alerts.notify ? 'false' : 'true'}" class="${cfg.alerts.notify ? 'on' : ''}">${cfg.alerts.notify ? '开启' : '关闭'}</button></span></div>
    <div class="field"><label>声音提醒</label>
      <span class="switch"><button data-alert="sound" data-value="${cfg.alerts.sound ? 'false' : 'true'}" class="${cfg.alerts.sound ? 'on' : ''}">${cfg.alerts.sound ? '开启' : '关闭'}</button></span></div>
  </div>`);

  $('settingsGrid').innerHTML = sets.join('');
}

/* ------------------------------ 提醒逻辑 ------------------------------ */
function checkAlerts() {
  const items = state.data?.result?.items ?? [];
  if (!items.length) return;
  const flags = Object.fromEntries(items.map((i) => [i.key, i.triggered === true]));

  if (state.prevFlags) {
    const fresh = items.filter((i) => flags[i.key] && !state.prevFlags[i.key]);
    if (fresh.length) {
      const names = fresh.map((i) => i.name).join('、');
      const total = items.filter((i) => flags[i.key]).length;
      $('alertBannerText').textContent = `新触发红线：${names}　当前共 ${total}/12 条`;
      $('alertBanner').hidden = false;
      toast(`<b>新触发红线</b><br>${esc(names)}　当前共 ${total}/12 条`, 'hit');
      beep(Math.min(3, fresh.length + 1));
      notify(`新触发 ${fresh.length} 条红线（共 ${total}/12）`, names);
    }
  }
  state.prevFlags = flags;
  localStorage.setItem('chaodi.flags', JSON.stringify(flags));
}

/* ------------------------------ 交互 ------------------------------ */
async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function load({ silent = false } = {}) {
  try {
    const payload = await fetchState();
    state.data = payload;
    state.mode = payload.mode === 'static' ? 'static' : 'local';
    applyMode();
    renderAll();
    checkAlerts();
  } catch (err) {
    if (!silent) toast(`无法加载数据：${esc(err.message)}`);
    $('statusPill').className = 'status-pill err';
    $('statusText').textContent = isStatic() ? '快照加载失败' : '连接失败';
  }
}

/** 本地服务优先；拿不到就退回静态快照（云端托管时走这条路） */
async function fetchState() {
  if (state.mode !== 'static') {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch { /* 本地服务不在，转静态快照 */ }
    state.mode = 'static';
    applyMode();
  }
  const res = await fetch('./data/state.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`静态数据加载失败 HTTP ${res.status}`);
  return res.json();
}

function renderAll() {
  renderStatus();
  renderHero();
  renderStrip();
  renderGrid();
  renderChart();
  if (!isStatic()) renderSettings();
  renderSources();
}

async function refreshNow() {
  if (isStatic()) {
    toast('这是只读快照，不能手动刷新。');
    return;
  }
  const btn = $('btnRefresh');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  $('statusPill').className = 'status-pill busy';
  $('statusText').textContent = '正在刷新…';
  try {
    const res = await api('/api/refresh');
    state.data = res;
    renderAll();
    checkAlerts();
    toast('刷新完成');
  } catch (err) {
    toast(`刷新失败：${esc(err.message)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即刷新';
  }
}

async function patchConfig(patch, { message = '设置已保存' } = {}) {
  if (isStatic()) {
    toast('这是只读快照，不能修改设置。<br>要调阈值请在本地运行 <b>node server.mjs</b>。');
    return;
  }
  try {
    const res = await api('/api/config', patch, 'PATCH');
    state.data = res;
    renderAll();
    checkAlerts();
    if (message) toast(message);
  } catch (err) {
    toast(`保存失败：${esc(err.message)}`);
  }
}

function collectSettings() {
  const patch = { thresholds: {}, params: {}, manual: {}, pcrValues: {} };
  document.querySelectorAll('[data-threshold]').forEach((el) => {
    if (el.value !== '') patch.thresholds[el.dataset.threshold] = Number(el.value);
  });
  document.querySelectorAll('[data-param]').forEach((el) => {
    const [group, key] = el.dataset.param.split('.');
    patch.params[group] ??= {};
    const v = el.tagName === 'SELECT' ? el.value : Number(el.value);
    if (el.tagName === 'SELECT' || el.value !== '') patch.params[group][key] = v;
  });
  document.querySelectorAll('[data-manual-value]').forEach((el) => {
    const key = el.dataset.manualValue;
    const [group, sub] = key.includes('.') ? key.split('.') : [key, 'value'];
    patch.manual[group] ??= {};
    patch.manual[group][sub] = el.value === '' ? null : Number(el.value);
  });
  document.querySelectorAll('[data-pcr]').forEach((el) => {
    patch.pcrValues[el.dataset.pcr] = el.value === '' ? null : Number(el.value);
  });
  const rs = document.querySelector('[data-refresh]');
  if (rs && rs.value !== '') patch.refreshSeconds = Number(rs.value);
  return patch;
}

function bindEvents() {
  $('btnRefresh').addEventListener('click', refreshNow);

  $('btnNotify').addEventListener('click', async () => {
    state.alertsEnabled = !state.alertsEnabled;
    localStorage.setItem('chaodi.alerts', state.alertsEnabled ? '1' : '0');
    $('btnNotify').classList.toggle('on', state.alertsEnabled);
    $('btnNotify').textContent = state.alertsEnabled ? '🔔 提醒已开' : '🔕 提醒已关';
    if (state.alertsEnabled) {
      if ('Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch { /* 忽略 */ }
      }
      beep(1);
      toast('提醒已开启：新触发红线时会弹桌面通知并响铃');
    } else {
      toast('提醒已关闭');
    }
  });

  $('alertClose').addEventListener('click', () => { $('alertBanner').hidden = true; });

  $('settingsToggle').addEventListener('click', () => {
    const body = $('settingsBody');
    body.hidden = !body.hidden;
    $('settingsToggle').querySelector('.chev').classList.toggle('open', !body.hidden);
  });

  $('btnSave').addEventListener('click', () => patchConfig(collectSettings()));
  $('btnReset').addEventListener('click', async () => {
    if (isStatic()) return;
    if (!confirm('恢复所有阈值与手动标记为默认值？')) return;
    const res = await api('/api/config/reset');
    state.data = res;
    renderAll();
    toast('已恢复默认设置');
  });
  $('btnClearHistory').addEventListener('click', async () => {
    if (isStatic()) return;
    if (!confirm('清空历史趋势数据？此操作不可撤销。')) return;
    const res = await api('/api/history', null, 'DELETE');
    state.data = res;
    renderAll();
    toast('历史数据已清空');
  });

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      await patchConfig({ manual: { [t.dataset.toggle]: { triggered: t.dataset.value === 'true' } } }, { message: '已更新手动状态' });
      return;
    }
    const m = e.target.closest('[data-manual]');
    if (m) {
      await patchConfig({ manual: { [m.dataset.manual]: { triggered: m.dataset.value === 'true' } } }, { message: '已更新（记得点保存按钮同步设置面板）' });
      return;
    }
    const a = e.target.closest('[data-alert]');
    if (a) {
      await patchConfig({ alerts: { [a.dataset.alert]: a.dataset.value === 'true' } }, { message: '' });
      return;
    }
    const input = e.target.closest('[data-input]');
    if (input) {
      const key = input.dataset.input;
      const current = state.data?.config?.manual?.[key]?.value ?? '';
      const raw = prompt(key === 'sentiment' ? '请输入韭圈情绪指数数值：' : '请输入中证1000 VIX 数值（留空恢复自动计算）：', current);
      if (raw === null) return;
      await patchConfig({ manual: { [key]: { value: raw === '' ? null : Number(raw) } } }, { message: '已更新数值' });
      return;
    }
    const scroll = e.target.closest('[data-scroll]');
    if (scroll) {
      $('settingsBody').hidden = false;
      $('settingsToggle').querySelector('.chev').classList.add('open');
      $('settingsBody').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

/* ------------------------------ 启动 ------------------------------ */
function init() {
  if (state.alertsEnabled) {
    $('btnNotify').classList.add('on');
    $('btnNotify').textContent = '🔔 提醒已开';
  }
  try {
    state.prevFlags = JSON.parse(localStorage.getItem('chaodi.flags') ?? 'null');
  } catch { state.prevFlags = null; }

  bindEvents();
  if (location.hash === '#settings' && !isStatic()) {
    $('settingsBody').hidden = false;
    $('settingsToggle').querySelector('.chev').classList.add('open');
  }
  load();
  // 只读快照的数据在下次部署前不会变，不需要轮询
  if (!isStatic()) setInterval(() => load({ silent: true }), 30000);
  // 页面重新可见时立即拉一次
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ silent: true }); });
}

init();

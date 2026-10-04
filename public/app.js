/* 天文台排程前端：无框架，原生 JS。 */
'use strict';

const $ = (id) => document.getElementById(id);

const DEMO_TARGETS = [
  { id: 1, ra: 201.36, dec: -43.02, expMin: 30, minAlt: 20, priority: 5 }, // 半人马座 ω
  { id: 2, ra: 180.55, dec: 29.87, expMin: 40, minAlt: 25, priority: 4 }, // M81
  { id: 3, ra: 140.0, dec: -5.39, expMin: 25, minAlt: 25, priority: 3 },  // M42
  { id: 4, ra: 299.30, dec: 22.72, expMin: 30, minAlt: 25, priority: 2 }, // M27
  { id: 5, ra: 283.40, dec: 33.03, expMin: 20, minAlt: 20, priority: 3 }, // M57
  { id: 6, ra: 210.80, dec: 54.35, expMin: 20, minAlt: 20, priority: 1 }, // M81? M101
  { id: 7, ra: 245.41, dec: -26.43, expMin: 25, minAlt: 30, priority: 2 }, // M7 疏散星团
];

function pad2(n) { return String(n).padStart(2, '0'); }

/** Date -> datetime-local 字符串（按传入 Date 的 UTC 分量）。 */
function toLocalInput(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** datetime-local 值 + 显式 Z -> UTC ISO；非法返回 null。 */
function localInputToUtc(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  return `${v}:00Z`;
}

function setDefaultWindow() {
  // 默认今晚 UTC 22:00 到次日 UTC 06:00（8 小时）
  const d = new Date();
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22, 0));
  if (s.getTime() < d.getTime()) s.setUTCDate(s.getUTCDate() + 1);
  const e = new Date(s.getTime() + 8 * 3600 * 1000);
  $('startUtc').value = toLocalInput(s);
  $('endUtc').value = toLocalInput(e);
  updateWindowInfo();
}

function updateWindowInfo() {
  const s = localInputToUtc($('startUtc').value);
  const e = localInputToUtc($('endUtc').value);
  const el = $('windowInfo');
  if (!s || !e) { el.textContent = ''; return; }
  const mins = (Date.parse(e) - Date.parse(s)) / 60000;
  if (mins <= 0) el.innerHTML = '<span class="bad-text">结束时间必须晚于开始时间</span>';
  else if (mins > 720) el.innerHTML = `<span class="bad-text">时长 ${mins} 分钟，超过 720 分钟上限</span>`;
  else el.textContent = `窗口时长 ${mins} 分钟（${(mins / 60).toFixed(2)} 小时）`;
}

// ---------- 目标表格 ----------
function addTargetRow(t = {}) {
  const tbody = $('targetRows');
  const tr = document.createElement('tr');
  const mk = (key, attrs, val) =>
    `<td><input data-k="${key}" ${attrs} value="${val ?? ''}"/></td>`;
  tr.innerHTML =
    mk('id', 'type="number" min="1" step="1" required', t.id) +
    mk('ra', 'type="number" step="any" min="0" max="360"', t.ra) +
    mk('dec', 'type="number" step="any" min="-90" max="90"', t.dec) +
    mk('expMin', 'type="number" step="1" min="1"', t.expMin) +
    mk('minAlt', 'type="number" step="any" min="-90" max="90"', t.minAlt) +
    mk('priority', 'type="number" step="1" min="1"', t.priority) +
    `<td class="lock-col"><input type="datetime-local" step="60" data-k="lockAt" value="${t.lockAtInput || ''}"/></td>` +
    `<td><button type="button" class="btn btn-ghost btn-danger row-del">删除</button></td>`;
  tr.querySelector('.row-del').addEventListener('click', () => {
    tr.remove();
  });
  tbody.appendChild(tr);
}

function readTargets() {
  const rows = [...$('targetRows').querySelectorAll('tr')];
  return rows.map((tr) => {
    const get = (k) => tr.querySelector(`[data-k="${k}"]`).value.trim();
    const num = (v) => (v === '' ? NaN : Number(v));
    const lockRaw = get('lockAt');
    const out = {
      id: num(get('id')),
      ra: num(get('ra')),
      dec: num(get('dec')),
      expMin: num(get('expMin')),
      minAlt: num(get('minAlt')),
      priority: num(get('priority')),
      lockAt: localInputToUtc(lockRaw),
      lockRaw,
    };
    return out;
  });
}

// ---------- 提交 ----------
function buildRequest() {
  const targets = readTargets();
  return {
    latitude: Number($('latitude').value),
    longitude: Number($('longitude').value),
    startUtc: localInputToUtc($('startUtc').value),
    endUtc: localInputToUtc($('endUtc').value),
    slewMin: Number($('slewMin').value),
    targets: targets.map(({ lockRaw, ...rest }) =>
      rest.lockAt ? rest : { ...rest, lockAt: null }
    ),
  };
}

function showErrors(result) {
  $('resultPanel').classList.add('hidden');
  const panel = $('errorPanel');
  panel.classList.remove('hidden');
  const list = $('errorList');
  list.innerHTML = '';

  if (Array.isArray(result.errors)) {
    const h = document.createElement('div');
    h.className = 'error-item';
    h.innerHTML = '存在非法参数：';
    list.appendChild(h);
    for (const e of result.errors) {
      const div = document.createElement('div');
      div.className = 'error-item';
      div.innerHTML = `<span class="error-field">${e.field}</span> — ${e.message}`;
      list.appendChild(div);
    }
  }
  if (Array.isArray(result.lockViolations)) {
    const h = document.createElement('div');
    h.className = 'error-item';
    h.style.marginTop = '10px';
    h.innerHTML = '锁定目标存在冲突，<b>整次排程被拒绝</b>：';
    list.appendChild(h);
    for (const v of result.lockViolations) {
      const div = document.createElement('div');
      div.className = 'error-item';
      const who = v.targets
        ? `目标 ${v.targets.join(' 与 ')}`
        : `目标 ${v.id}`;
      div.innerHTML = `🚫 ${who}：<b>${v.reason}</b> — ${v.detail}`;
      list.appendChild(div);
    }
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fmtUtc(isoStr) {
  return isoStr.replace('T', ' ').replace('Z', ' UTC');
}

function renderTimeline(schedule, summary) {
  const host = $('timeline');
  host.innerHTML = '';
  const wStart = Date.parse(summary.windowStartUtc);
  const wEnd = Date.parse(summary.windowEndUtc);
  const wMin = (wEnd - wStart) / 60000;
  if (!schedule.length) {
    host.textContent = '没有可排入的目标。';
    return;
  }
  const track = document.createElement('div');
  track.className = 'tl-track';

  // 换台间隙虚线
  for (let i = 0; i < schedule.length - 1; i++) {
    const a = schedule[i];
    const b = schedule[i + 1];
    const gapStart = Date.parse(a.endUtc);
    const gapEnd = Date.parse(b.startUtc);
    const left = ((gapStart - wStart) / 60000 / wMin) * 100;
    const width = ((gapEnd - gapStart) / 60000 / wMin) * 100;
    if (width > 0.5) {
      const g = document.createElement('div');
      g.className = 'tl-gap';
      g.style.left = `${left}%`;
      g.style.width = `${width}%`;
      g.title = `换台 ${Math.round(width * wMin) / 1} 分钟`;
      track.appendChild(g);
    }
  }

  for (const item of schedule) {
    const s = Date.parse(item.startUtc);
    const e = Date.parse(item.endUtc);
    const left = ((s - wStart) / 60000 / wMin) * 100;
    const width = ((e - s) / 60000 / wMin) * 100;
    const b = document.createElement('div');
    b.className = 'tl-block' + (item.locked ? ' locked' : '');
    b.style.left = `${left}%`;
    b.style.width = `calc(${width}% - 2px)`;
    b.textContent = `#${item.id}`;
    b.title = `目标 ${item.id}｜${fmtUtc(item.startUtc)}–${item.endUtc.replace(/.*T/, '').replace('Z', '')} UTC`;
    track.appendChild(b);
  }
  host.appendChild(track);

  const scale = document.createElement('div');
  scale.className = 'tl-scale';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = new Date(wStart + (wMin * 60000 * i) / ticks);
    const span = document.createElement('span');
    span.textContent = `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
    scale.appendChild(span);
  }
  host.appendChild(scale);
}

function renderResult(result) {
  $('errorPanel').classList.add('hidden');
  const panel = $('resultPanel');
  panel.classList.remove('hidden');
  const { schedule, unscheduled, summary } = result;

  $('summary').innerHTML =
    `<span class="chip">📍 ${summary.latitude}°, ${summary.longitude}°</span>` +
    `<span class="chip">🕐 ${fmtUtc(summary.windowStartUtc)} → ${fmtUtc(summary.windowEndUtc)}</span>` +
    `<span class="chip">🔄 换台 ${summary.slewMin} 分钟</span>` +
    `<span class="chip">⭐ 优先级总和 <b>${summary.totalPriority}</b></span>` +
    `<span class="chip">🎯 排入 <b>${summary.scheduledCount}</b> 个（锁定 ${summary.lockedCount}）</span>`;

  renderTimeline(schedule, summary);

  const sbody = $('scheduleRows');
  sbody.innerHTML = '';
  schedule.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td>${fmtUtc(item.startUtc)}</td>` +
      `<td>${fmtUtc(item.endUtc)}</td>` +
      `<td><b>${item.id}</b></td>` +
      `<td>${item.expMin}</td>` +
      `<td>${item.priority}</td>` +
      `<td>${item.minAltitudeObserved.toFixed(2)}°</td>` +
      `<td>${item.locked ? '<span class="badge lock">锁定</span>' : '<span class="badge free">自动</span>'}</td>`;
    sbody.appendChild(tr);
  });

  const ub = $('unscheduledRows');
  ub.innerHTML = '';
  if (!unscheduled.length) {
    ub.innerHTML = '<tr><td colspan="3" class="good-text">全部目标均已排入 🎉</td></tr>';
  } else {
    for (const u of unscheduled) {
      const tr = document.createElement('tr');
      const cls = u.reason === '不可见' ? 'bad-text' : '';
      tr.innerHTML =
        `<td><b>${u.id}</b></td>` +
        `<td class="${cls}">${u.reason}</td>` +
        `<td>${u.detail}</td>`;
      ub.appendChild(tr);
    }
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runSchedule() {
  $('formMsg').textContent = '';
  const req = buildRequest();
  if (!req.startUtc || !req.endUtc) {
    $('formMsg').innerHTML = '<span class="bad-text">请填写合法的 UTC 起止时间</span>';
    return;
  }
  $('runBtn').disabled = true;
  $('runBtn').textContent = '计算中…';
  try {
    const resp = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) showErrors(data);
    else renderResult(data);
  } catch (err) {
    $('formMsg').innerHTML = `<span class="bad-text">请求失败：${err.message}</span>`;
  } finally {
    $('runBtn').disabled = false;
    $('runBtn').textContent = '生成排程';
  }
}

// ---------- 初始化 ----------
$('addTarget').addEventListener('click', () => addTargetRow());
$('clearAll').addEventListener('click', () => { $('targetRows').innerHTML = ''; });
$('fillDemo').addEventListener('click', () => {
  $('targetRows').innerHTML = '';
  DEMO_TARGETS.forEach(addTargetRow);
});
$('runBtn').addEventListener('click', runSchedule);
$('startUtc').addEventListener('change', updateWindowInfo);
$('endUtc').addEventListener('change', updateWindowInfo);

setDefaultWindow();
DEMO_TARGETS.forEach(addTargetRow);

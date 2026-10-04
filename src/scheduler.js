// 排程核心：输入校验、锁定目标校验、整分钟离散化、DP 优化与字典序重建。
//
// 优化目标（按字典序依次比较）：
//   1) 排入目标优先级总和最大
//   2) 排入目标数最多
//   3) 按开始时间先后排列的「目标编号序列」字典序最小
//   4) 「开始时刻序列（相对窗起点的整分钟数）」字典序最小
//
// 时间窗最长 12 小时（720 分钟），目标至多 16 个。

import { lst, norm360 } from './astro.js';
import { VisModel, DHA } from './visibility.js';

const MAX_WINDOW_MIN = 12 * 60;
const MAX_TARGETS = 16;
const EPS = 1e-6;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/**
 * 解析 UTC ISO 时间。
 * 仅接受日期（按 UTC）或带 Z / 偏移量的时间，拒绝不带时区的日期时间。
 */
export function parseUtc(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validate(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: [{ field: '_', message: '请求体必须是对象' }] };
  }

  const lat = input.latitude;
  const lon = input.longitude;
  if (!isNum(lat) || lat < -90 || lat > 90) {
    errors.push({ field: 'latitude', message: '纬度必须是 [-90, 90] 内的数字' });
  }
  if (!isNum(lon) || lon < -180 || lon > 180) {
    errors.push({ field: 'longitude', message: '经度必须是 [-180, 180] 内的数字' });
  }

  const start = parseUtc(input.startUtc);
  const end = parseUtc(input.endUtc);
  if (!start) errors.push({ field: 'startUtc', message: '起始时间须为带 Z（或偏移）的 UTC ISO 时间' });
  if (!end) errors.push({ field: 'endUtc', message: '结束时间须为带 Z（或偏移）的 UTC ISO 时间' });
  if (start && end && end.getTime() <= start.getTime()) {
    errors.push({ field: 'endUtc', message: '结束时间必须晚于起始时间' });
  }
  if (start && end && end.getTime() > start.getTime()) {
    const mins = (end - start) / 60000;
    if (mins > MAX_WINDOW_MIN + EPS) {
      errors.push({ field: 'endUtc', message: `时间窗长度 ${mins.toFixed(1)} 分钟超过上限 720 分钟（12 小时）` });
    }
  }

  if (!isInt(input.slewMin) || input.slewMin < 0) {
    errors.push({ field: 'slewMin', message: '换台分钟必须是非负整数' });
  }

  const rawTargets = input.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length < 1 || rawTargets.length > MAX_TARGETS) {
    errors.push({ field: 'targets', message: `目标数量必须为 1..${MAX_TARGETS} 个` });
  }

  const targets = [];
  if (Array.isArray(rawTargets)) {
    const ids = new Set();
    rawTargets.forEach((t, idx) => {
      const where = `targets[${idx}]`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        errors.push({ field: where, message: '目标必须是对象' });
        return;
      }
      let ok = true;
      if (!isInt(t.id) || t.id <= 0) {
        errors.push({ field: `${where}.id`, message: '编号必须是正整数' });
        ok = false;
      } else if (ids.has(t.id)) {
        errors.push({ field: `${where}.id`, message: `编号 ${t.id} 重复` });
        ok = false;
      } else {
        ids.add(t.id);
      }
      if (!isNum(t.ra) || t.ra < 0 || t.ra >= 360) {
        errors.push({ field: `${where}.ra`, message: '赤经必须是 [0, 360) 度内的数字' });
        ok = false;
      }
      if (!isNum(t.dec) || t.dec < -90 || t.dec > 90) {
        errors.push({ field: `${where}.dec`, message: '赤纬必须是 [-90, 90] 度内的数字' });
        ok = false;
      }
      if (!isInt(t.expMin) || t.expMin <= 0) {
        errors.push({ field: `${where}.expMin`, message: '曝光分钟必须是正整数' });
        ok = false;
      }
      if (!isNum(t.minAlt) || t.minAlt < -90 || t.minAlt > 90) {
        errors.push({ field: `${where}.minAlt`, message: '最低高度角必须是 [-90, 90] 度内的数字' });
        ok = false;
      }
      if (!isInt(t.priority) || t.priority <= 0) {
        errors.push({ field: `${where}.priority`, message: '优先级必须是正整数' });
        ok = false;
      }
      let lockAt = null;
      if (t.lockAt !== undefined && t.lockAt !== null && t.lockAt !== '') {
        lockAt = parseUtc(t.lockAt);
        if (!lockAt) {
          errors.push({ field: `${where}.lockAt`, message: '锁定时刻须为带 Z（或偏移）的 UTC ISO 时间' });
          ok = false;
        }
      }
      if (ok) {
        targets.push({
          idx,
          id: t.id,
          ra: t.ra,
          dec: t.dec,
          expMin: t.expMin,
          minAlt: t.minAlt,
          priority: t.priority,
          lockAt,
        });
      }
    });
  }

  if (errors.length) return { errors };
  return {
    errors: [],
    normalized: {
      lat,
      lon,
      start,
      end,
      slew: input.slewMin,
      targets,
    },
  };
}

function iso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 主入口。返回 ok / errors / lockViolations / schedule。 */
export function scheduleRequest(input) {
  const v = validate(input);
  if (v.errors.length) return { ok: false, errors: v.errors };
  const { lat, lon, start, end, slew, targets } = v.normalized;

  // ---- 时间网格：以窗起点所在整分钟为 k=0 ----
  const startMs = start.getTime();
  const endMs = end.getTime();
  const baseMs = Math.floor(startMs / 60000) * 60000;
  const base = new Date(baseMs);
  const Kgrid = Math.ceil((endMs - baseMs) / 60000 - EPS); // 最大有效 k
  const startK = Math.ceil((startMs - baseMs) / 60000 - EPS); // 窗内最早整分钟
  const lastStartFor = (exp) =>
    Math.floor((endMs - baseMs) / 60000 + EPS) - exp;

  // ---- 每个目标的可见性位图 ----
  const models = targets.map((t) => new VisModel(t, Kgrid, lat));
  const grids = targets.map((t, j) => {
    const h0 = norm360(lst(base, lon) - t.ra);
    return models[j].buildGrid(h0);
  });

  // ---- 锁定目标校验 ----
  const lockViolations = [];
  const locks = []; // {ti, id, k, exp, priority}
  targets.forEach((t, ti) => {
    if (!t.lockAt) return;
    const lm = t.lockAt.getTime();
    if (lm % 60000 !== 0) {
      lockViolations.push({ id: t.id, reason: '非整分钟', detail: '锁定时刻必须落在整分钟（秒为 00）' });
      return;
    }
    const k = (lm - baseMs) / 60000;
    if (lm < startMs - EPS || lm + t.expMin * 60000 > endMs + EPS) {
      lockViolations.push({ id: t.id, reason: '时间窗外', detail: '锁定曝光整体必须处于时间窗内' });
      return;
    }
    if (k < 0 || k > lastStartFor(t.expMin) || !grids[ti].fits[k]) {
      lockViolations.push({ id: t.id, reason: '不可见', detail: '锁定的开始时刻无法使整段曝光高度角不低于阈值' });
      return;
    }
    locks.push({ ti, id: t.id, k, exp: t.expMin, priority: t.priority });
  });

  // 锁定项之间的换台冲突
  locks.sort((a, b) => a.k - b.k || a.id - b.id);
  for (let i = 0; i < locks.length; i++) {
    for (let j = i + 1; j < locks.length; j++) {
      const a = locks[i];
      const b = locks[j];
      if (a.k + a.exp + slew > b.k) {
        lockViolations.push({
          targets: [a.id, b.id],
          reason: '锁定冲突',
          detail: `目标 ${a.id} 与目标 ${b.id} 的锁定曝光间隔不足 ${slew} 分钟换台时间`,
        });
      }
    }
  }

  if (lockViolations.length) {
    return { ok: false, lockViolations };
  }

  // ---- 非锁定目标 ----
  const free = targets
    .map((t, ti) => ({ ti, t, model: models[ti], grid: grids[ti] }))
    .filter((x) => !x.t.lockAt);
  const m = free.length;
  const full = (1 << m) - 1;

  // 静态可行性：fits + 窗内 + 不与锁定块冲突
  const lockOverlap = (k, exp) =>
    locks.some((L) => k + exp + slew > L.k && L.k + L.exp + slew > k);

  const staticOk = free.map((x) => {
    const arr = new Uint8Array(Kgrid + 1);
    const lastK = lastStartFor(x.t.expMin);
    for (let k = startK; k <= lastK; k++) {
      if (x.grid.fits[k] && !lockOverlap(k, x.t.expMin)) arr[k] = 1;
    }
    return arr;
  });

  // nextFeasible[i][t]：从偏移 t（含）起目标 i 最早的可行开始位置；无则 SENTINEL
  const SENTINEL = Kgrid + 1;
  const nf = free.map((x, fi) => {
    const next = new Int32Array(SENTINEL + 1).fill(SENTINEL);
    for (let t = Kgrid; t >= 0; t--) {
      next[t] = staticOk[fi][t] ? t : next[t + 1];
    }
    next[SENTINEL] = SENTINEL;
    return next;
  });

  // 下一个未处理锁定（起点 >= t）
  const nextLockIdx = (t) => {
    let lo = 0;
    let hi = locks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (locks[mid].k < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // ---- DP：memo key = mask * B + t ----
  const B = SENTINEL + 1;
  const memo = new Map();
  const keyOf = (mask, t) => mask * B + t;

  function solve(mask, t) {
    const key = keyOf(mask, t);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    let bp = 0;
    let bc = 0;
    const li = nextLockIdx(t);

    let bits = mask;
    while (bits) {
      const bi = bits & -bits;
      const fi = 31 - Math.clz32(bi);
      bits ^= bi;
      const k = nf[fi][t];
      const lastK = lastStartFor(free[fi].t.expMin);
      if (k <= lastK && (li >= locks.length || k < locks[li].k)) {
        const sub = solve(mask ^ bi, k + free[fi].t.expMin + slew);
        const p = free[fi].t.priority + sub.p;
        const c = 1 + sub.c;
        if (p > bp || (p === bp && c > bc)) {
          bp = p;
          bc = c;
        }
      }
    }

    // 空转到下一个锁定块
    if (li < locks.length) {
      const L = locks[li];
      const sub = solve(mask, L.k + L.exp + slew);
      if (sub.p > bp || (sub.p === bp && sub.c > bc)) {
        bp = sub.p;
        bc = sub.c;
      }
    }

    const res = { p: bp, c: bc };
    memo.set(key, res);
    return res;
  }

  const root = solve(full, startK);

  // ---- 字典序重建 ----
  // 最优事件序列（含锁定项）按「编号序列、开始时刻序列」字典序最小。
  // 每状态只记获胜动作；两个候选的优劣只需比较各自的下一个事件：
  //   先编号小者；编号相同（同一起点可能有多个锁定/作业？不会）再开始时刻小者。
  // 递归深度 ≤ 32，故按需递归比较即可，每状态 O(候选数)。
  // pick: {kind:'job', fi, k, mask2, t2} 或 {kind:'idle', li, t2}
  const traceMemo = new Map();
  const EMPTY = Symbol('empty');

  function choosePick(mask, t) {
    const key = keyOf(mask, t);
    const hit = traceMemo.get(key);
    if (hit !== undefined) return hit;

    const best = memo.get(key);
    const li = nextLockIdx(t);
    const feas = [];
    let bits = mask;
    while (bits) {
      const bi = bits & -bits;
      const fi = 31 - Math.clz32(bi);
      bits ^= bi;
      const k = nf[fi][t];
      const lastK = lastStartFor(free[fi].t.expMin);
      if (k <= lastK && (li >= locks.length || k < locks[li].k)) {
        const nt = k + free[fi].t.expMin + slew;
        const sub = solve(mask ^ bi, nt);
        const p = free[fi].t.priority + sub.p;
        const c = 1 + sub.c;
        if (p === best.p && c === best.c) {
          feas.push({ kind: 'job', fi, k, mask2: mask ^ bi, t2: nt });
        }
      }
    }
    if (li < locks.length) {
      const L = locks[li];
      const nt = L.k + L.exp + slew;
      const sub = solve(mask, nt);
      if (sub.p === best.p && sub.c === best.c) {
        feas.push({ kind: 'idle', li, mask, t2: nt });
      }
    }
    if (!feas.length) {
      traceMemo.set(key, EMPTY);
      return EMPTY;
    }

    // 候选的优劣由其下一个事件 (编号, 开始时刻) 决定，相同则递归比较后续状态。
    let winner = feas[0];
    for (let i = 1; i < feas.length; i++) {
      if (candLess(feas[i], winner)) winner = feas[i];
    }
    traceMemo.set(key, winner);
    return winner;
  }

  // 取某候选“后续状态”的获胜动作（下一个事件）。
  function tailPickOf(cand) {
    return cand.kind === 'job'
      ? choosePick(cand.mask2, cand.t2)
      : choosePick(cand.mask, cand.t2);
  }
  const headOfPick = (p) =>
    p.kind === 'job'
      ? [free[p.fi].t.id, p.k]
      : [locks[p.li].id, locks[p.li].k];

  // 两个候选各自给出的事件序列，字典序更小者为优。
  function candLess(a, b) {
    const [ia, ta] = headOfCand(a);
    const [ib, tb] = headOfCand(b);
    if (ia !== ib) return ia < ib;
    if (ta !== tb) return ta < tb;
    const pa = tailPickOf(a);
    const pb = tailPickOf(b);
    if (pa === EMPTY || pb === EMPTY) return pa === pb ? false : pa === EMPTY;
    return pickLess(pa, pb);
  }
  function headOfCand(cand) {
    return cand.kind === 'job'
      ? [free[cand.fi].t.id, cand.k]
      : [locks[cand.li].id, locks[cand.li].k];
  }
  // 比较两个获胜动作代表的（从该动作开始的）事件序列。
  function pickLess(pa, pb) {
    const [ia, ta] = headOfPick(pa);
    const [ib, tb] = headOfPick(pb);
    if (ia !== ib) return ia < ib;
    if (ta !== tb) return ta < tb;
    const ma = pa.kind === 'job' ? pa.mask2 : pa.mask;
    const mb = pb.kind === 'job' ? pb.mask2 : pb.mask;
    const na = choosePick(ma, pa.t2);
    const nb = choosePick(mb, pb.t2);
    if (na === EMPTY || nb === EMPTY) return na === nb ? false : na === EMPTY;
    return pickLess(na, nb);
  }

  // ---- 沿获胜动作链收集实际排入的非锁定目标 ----
  const chosenFree = new Set(); // target ti
  const freeItems = [];
  {
    let mask = full;
    let t = startK;
    for (let steps = 0; steps <= m + locks.length; steps++) {
      const cand = choosePick(mask, t);
      if (cand === EMPTY) break;
      if (cand.kind === 'job') {
        freeItems.push({ fi: cand.fi, k: cand.k });
        chosenFree.add(free[cand.fi].ti);
        mask = cand.mask2;
        t = cand.t2;
      } else {
        t = cand.t2;
      }
    }
  }

  const items = [];
  for (const { fi, k } of freeItems) {
    const x = free[fi];
    items.push({ k, locked: false, ti: x.ti });
  }
  for (const L of locks) {
    items.push({ k: L.k, locked: true, ti: L.ti });
  }
  items.sort((a, b) => a.k - b.k || targets[a.ti].id - targets[b.ti].id);

  const schedule = items.map((it) => {
    const tgt = targets[it.ti];
    const sDate = new Date(baseMs + it.k * 60000);
    const eDate = new Date(baseMs + (it.k + tgt.expMin) * 60000);
    const h0 = norm360(lst(base, lon) - tgt.ra);
    const minObserved = models[it.ti].minAltitudeOn(h0 + it.k * DHA, lat);
    return {
      id: tgt.id,
      startUtc: iso(sDate),
      endUtc: iso(eDate),
      startOffsetMin: it.k - startK,
      expMin: tgt.expMin,
      priority: tgt.priority,
      minAltitudeObserved: Number(minObserved.toFixed(3)),
      locked: it.locked,
    };
  });

  // ---- 未入选原因 ----
  // ---- 未入选原因 ----
  const fiByTi = new Map(free.map((x, fi) => [x.ti, fi]));
  const unscheduled = [];
  targets.forEach((tgt, ti) => {
    if (tgt.lockAt || chosenFree.has(ti)) return;
    const lastK = lastStartFor(tgt.expMin);
    let anyVisible = false;
    for (let k = startK; k <= lastK; k++) {
      if (grids[ti].fits[k]) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) {
      const mdl = models[ti];
      unscheduled.push({
        id: tgt.id,
        reason: '不可见',
        detail:
          mdl.neverVisible || mdl.arc + EPS >= 2 * mdl.Hmax
            ? '在该时间窗与地理纬度下，整段曝光无法始终达到最低高度角'
            : '窗内没有任何整分钟开始可使整段曝光高度角不低于阈值',
      });
      return;
    }
    let fitsWithLocks = false;
    const fi = fiByTi.get(ti);
    for (let k = startK; k <= lastK; k++) {
      if (staticOk[fi][k]) {
        fitsWithLocks = true;
        break;
      }
    }
    unscheduled.push({
      id: tgt.id,
      reason: '容量不足',
      detail: fitsWithLocks
        ? `时间窗/换台容量有限，排入它会降低优先级总和（优先级 ${tgt.priority}）`
        : '锁定目标占位后，没有可容纳整段曝光并满足换台间隔的位置',
    });
  });

  const lockedPrio = locks.reduce((s, L) => s + L.priority, 0);
  return {
    ok: true,
    schedule,
    unscheduled,
    summary: {
      totalPriority: root.p + lockedPrio,
      scheduledCount: schedule.length,
      lockedCount: locks.length,
      windowStartUtc: iso(start),
      windowEndUtc: iso(end),
      slewMin: slew,
      latitude: lat,
      longitude: lon,
    },
  };
}

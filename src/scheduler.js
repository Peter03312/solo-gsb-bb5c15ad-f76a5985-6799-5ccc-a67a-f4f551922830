'use strict';

const { minAltitudeInInterval } = require('./astro');

const MIN_MS = 60000;
const MAX_WINDOW_MS = 12 * 3600 * 1000; // 时间窗最长 12 小时
const MAX_TARGETS = 16;
const EPS = 1e-9; // 高度角比较容差（度）

/** 输入非法（坐标 / 时长 / 时间窗 / 目标字段等），整次拒绝 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'VALIDATION_ERROR';
  }
}

/** 锁定目标不可见或互相冲突，整次拒绝并指出目标 */
class LockedConflictError extends Error {
  constructor(message, targets) {
    super(message);
    this.status = 400;
    this.code = 'LOCKED_CONFLICT';
    this.targets = targets;
  }
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** 目标编号比较：均为数值时按数值，否则按字符串（确定性） */
function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === String(a).trim() && String(nb) === String(b).trim()) {
    return na - nb;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 校验并规范化请求体。
 * 返回 { lat, lon, w0Ms, w1Ms, slewMin, targets:[{id, ra, dec, durMin, minAlt, priority, lockStartMs|null}] }
 */
function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }

  const lat = toNumber(body.latitude);
  const lon = toNumber(body.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ValidationError('非法纬度：必须是 -90 到 90 之间的数值');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new ValidationError('非法经度：必须是 -180 到 180 之间的数值');
  }

  const w0Ms = Date.parse(body.windowStart);
  const w1Ms = Date.parse(body.windowEnd);
  if (!Number.isFinite(w0Ms) || !Number.isFinite(w1Ms)) {
    throw new ValidationError('非法时间窗：起止时间必须是可解析的 UTC 时间（ISO 8601，如 2026-10-04T18:00:00Z）');
  }
  if (!(w0Ms < w1Ms)) {
    throw new ValidationError('非法时间窗：开始时刻必须早于结束时刻');
  }
  if (w1Ms - w0Ms > MAX_WINDOW_MS) {
    throw new ValidationError('非法时间窗：时长最长 12 小时');
  }

  const slewMin = toNumber(body.slewMinutes);
  if (!Number.isInteger(slewMin) || slewMin < 0) {
    throw new ValidationError('非法换台时长：必须是非负整数分钟');
  }

  const rawTargets = body.targets;
  if (!Array.isArray(rawTargets)) {
    throw new ValidationError('非法目标列表：targets 必须是数组');
  }
  if (rawTargets.length > MAX_TARGETS) {
    throw new ValidationError(`非法目标列表：目标数量至多为 ${MAX_TARGETS} 个`);
  }

  const seen = new Set();
  const targets = rawTargets.map((t, i) => {
    const where = `第 ${i + 1} 个目标`;
    if (!t || typeof t !== 'object') throw new ValidationError(`${where}：必须是对象`);

    const id = t.id === null || t.id === undefined ? '' : String(t.id).trim();
    if (!id) throw new ValidationError(`${where}：编号不能为空`);
    if (seen.has(id)) throw new ValidationError(`目标编号重复：${id}`);
    seen.add(id);

    const ra = toNumber(t.ra);
    if (!Number.isFinite(ra) || ra < 0 || ra >= 360) {
      throw new ValidationError(`目标 ${id}：非法赤经，必须是 [0, 360) 内的度数`);
    }
    const dec = toNumber(t.dec);
    if (!Number.isFinite(dec) || dec < -90 || dec > 90) {
      throw new ValidationError(`目标 ${id}：非法赤纬，必须是 [-90, 90] 内的度数`);
    }
    const durMin = toNumber(t.exposureMinutes);
    if (!Number.isInteger(durMin) || durMin <= 0) {
      throw new ValidationError(`目标 ${id}：非法曝光时长，必须是正整数分钟`);
    }
    const minAlt = toNumber(t.minAltitude);
    if (!Number.isFinite(minAlt) || minAlt < -90 || minAlt > 90) {
      throw new ValidationError(`目标 ${id}：非法最低高度角，必须是 [-90, 90] 内的度数`);
    }
    const priority = toNumber(t.priority);
    if (!Number.isInteger(priority) || priority <= 0) {
      throw new ValidationError(`目标 ${id}：非法优先级，必须是正整数`);
    }

    let lockStartMs = null;
    if (t.lockStart !== null && t.lockStart !== undefined && t.lockStart !== '') {
      lockStartMs = Date.parse(t.lockStart);
      if (!Number.isFinite(lockStartMs)) {
        throw new ValidationError(`目标 ${id}：锁定开始时刻无法解析（需为 UTC 时间）`);
      }
      if (lockStartMs % MIN_MS !== 0) {
        throw new ValidationError(`目标 ${id}：锁定开始时刻必须对齐到整分钟`);
      }
    }

    return { id, ra, dec, durMin, minAlt, priority, lockStartMs };
  });

  return { lat, lon, w0Ms, w1Ms, slewMin, targets };
}

/**
 * 排程主流程。
 * 返回 { schedule, unscheduled, totalPriority, scheduledCount }
 * 锁定目标不可见 / 冲突时抛 LockedConflictError。
 */
function plan(input) {
  const { lat, lon, w0Ms, w1Ms, slewMin, targets } = input;
  const t0min = Math.ceil(w0Ms / MIN_MS); // 首个可排整分钟（分钟，自 Unix 纪元）
  const t1min = Math.floor(w1Ms / MIN_MS);
  const gridSize = t1min - t0min + 2; // 分钟网格大小（含哨兵位）

  // ---- 锁定目标：校验可见性与相互冲突，失败则整次拒绝 ----
  const locked = targets
    .filter((t) => t.lockStartMs !== null)
    .map((t) => ({
      ...t,
      startMin: t.lockStartMs / MIN_MS,
      endMin: (t.lockStartMs + t.durMin * MIN_MS) / MIN_MS,
    }))
    .sort((a, b) => a.startMin - b.startMin);

  for (const L of locked) {
    if (L.lockStartMs < w0Ms || L.lockStartMs + L.durMin * MIN_MS > w1Ms) {
      throw new LockedConflictError(`锁定目标 ${L.id} 的曝光区间不在时间窗内，整次排程被拒绝`, [L.id]);
    }
    const mn = minAltitudeInInterval(L.lockStartMs, L.lockStartMs + L.durMin * MIN_MS, lat, lon, L.ra, L.dec);
    if (mn < L.minAlt - EPS) {
      throw new LockedConflictError(
        `锁定目标 ${L.id} 在锁定时段内最低高度角 ${mn.toFixed(2)}° 低于阈值 ${L.minAlt}°，整次排程被拒绝`,
        [L.id]
      );
    }
  }
  const lockedBad = new Set();
  for (let i = 0; i + 1 < locked.length; i++) {
    if (locked[i].endMin + slewMin > locked[i + 1].startMin) {
      lockedBad.add(locked[i].id);
      lockedBad.add(locked[i + 1].id);
    }
  }
  if (lockedBad.size > 0) {
    throw new LockedConflictError(
      `锁定目标 ${[...lockedBad].join('、')} 的曝光区间（含换台间隔 ${slewMin} 分钟）互相冲突，整次排程被拒绝`,
      [...lockedBad]
    );
  }

  // ---- 自由目标：逐整分钟起点的可见性表 + “不早于某时刻的最早可行起点”表 ----
  const free = targets.filter((t) => t.lockStartMs === null);
  const n = free.length;
  const M = 1 << n;

  // nextStart[j][i]：目标 j 不早于 (t0min+i) 的最早可行整分钟起点（含锁定占用避让），不可行为 Infinity
  const nextStart = [];
  const astronomicallyVisible = []; // 纯天文可见性（不考虑容量与锁定占用），用于未入选原因
  for (let j = 0; j < n; j++) {
    const t = free[j];
    const durMs = t.durMin * MIN_MS;
    const lastStartMin = Math.floor((w1Ms - durMs) / MIN_MS);
    const ok = new Array(gridSize).fill(false);
    let anyVisible = false;
    for (let m = t0min; m <= lastStartMin; m++) {
      const visible =
        minAltitudeInInterval(m * MIN_MS, m * MIN_MS + durMs, lat, lon, t.ra, t.dec) >= t.minAlt - EPS;
      ok[m - t0min] = visible;
      if (visible) anyVisible = true;
    }
    astronomicallyVisible.push(anyVisible);

    const conflictsLocked = (m) => {
      const sMs = m * MIN_MS;
      const eMs = sMs + durMs;
      for (const L of locked) {
        const lsMs = L.startMin * MIN_MS;
        const leMs = L.endMin * MIN_MS;
        // 自由曝光须与锁定曝光间隔 >= slewMin：e+g <= Ls 或 s >= Le+g
        if (!(eMs + slewMin * MIN_MS <= lsMs || sMs >= leMs + slewMin * MIN_MS)) return true;
      }
      return false;
    };

    const arr = new Array(gridSize).fill(Infinity);
    let nxt = Infinity;
    for (let m = t1min; m >= t0min; m--) {
      const i = m - t0min;
      if (m <= lastStartMin && ok[i] && !conflictsLocked(m)) nxt = m;
      arr[i] = nxt;
    }
    nextStart.push(arr);
  }

  const earliestFrom = (j, cursorMin) => {
    const idx = cursorMin - t0min;
    if (idx < 0) return nextStart[j][0];
    if (idx >= gridSize) return Infinity;
    return nextStart[j][idx];
  };

  // ---- 子集 DP：f[mask] = 恰好排入 mask 中自由目标的最小结束时刻（分钟） ----
  const prioSum = new Float64Array(M); // 优先级可能很大，避免 32 位溢出
  const cnt = new Int32Array(M);
  const f = new Array(M).fill(Infinity);
  f[0] = t0min;
  for (let mask = 1; mask < M; mask++) {
    const lb = mask & -mask;
    const j = 31 - Math.clz32(lb);
    prioSum[mask] = prioSum[mask ^ lb] + free[j].priority;
    cnt[mask] = cnt[mask ^ lb] + 1;
    let best = Infinity;
    let mm = mask;
    while (mm) {
      const b = mm & -mm;
      const jj = 31 - Math.clz32(b);
      mm ^= b;
      const prev = f[mask ^ b];
      if (prev === Infinity) continue;
      const t = mask === b ? t0min : prev + slewMin; // 首个曝光前无需换台间隔
      const s = earliestFrom(jj, t);
      if (s === Infinity) continue;
      const end = s + free[jj].durMin;
      if (end < best) best = end;
    }
    f[mask] = best;
  }

  // ---- 最优目标：先优先级总和最大，再目标数最多 ----
  let bestP = 0;
  let bestC = 0;
  for (let mask = 0; mask < M; mask++) {
    if (f[mask] === Infinity) continue;
    if (prioSum[mask] > bestP || (prioSum[mask] === bestP && cnt[mask] > bestC)) {
      bestP = prioSum[mask];
      bestC = cnt[mask];
    }
  }

  // ---- 从给定时刻起，剩余目标可完成的 (优先级和, 数量) 组合（带缓存） ----
  const fullMask = M - 1;
  const pairCache = new Map(); // "cursor|remainMask" -> Set("p,c")
  function achievablePairs(cursorMin, remainMask) {
    const key = cursorMin + '|' + remainMask;
    let set = pairCache.get(key);
    if (set) return set;
    const h = new Array(M).fill(Infinity);
    h[0] = cursorMin;
    set = new Set();
    for (let mask = 0; mask < M; mask++) {
      if ((mask & ~remainMask) !== 0) continue;
      const cur = h[mask];
      if (cur === Infinity) continue;
      set.add(prioSum[mask] + ',' + cnt[mask]);
      let mm = remainMask & ~mask;
      while (mm) {
        const b = mm & -mm;
        const j = 31 - Math.clz32(b);
        mm ^= b;
        const s = earliestFrom(j, cur + slewMin);
        if (s === Infinity) continue;
        const end = s + free[j].durMin;
        if (end < h[mask | b]) h[mask | b] = end;
      }
    }
    pairCache.set(key, set);
    return set;
  }
  const canComplete = (cursorMin, remainMask, needP, needC) => {
    if (needP <= 0 || needC <= 0) return needP === 0 && needC === 0;
    return achievablePairs(cursorMin, remainMask).has(needP + ',' + needC);
  };

  // ---- 字典序贪心重构：在 (优先级和, 数量) 同为最优的方案中，
  //      使按开始顺序的 (编号序列, 开始时刻序列) 字典序最小 ----
  const seq = [];
  let cur = t0min;
  let started = false;
  let used = 0;
  let lockIdx = 0;
  let needP = bestP;
  let needC = bestC;

  while (needC > 0 || lockIdx < locked.length) {
    const earliest = started ? cur + slewMin : t0min;
    const candidates = [];

    // 候选 A：下一个锁定目标（其开始时刻固定，若轮到它成为序列下一项）
    if (lockIdx < locked.length) {
      const L = locked[lockIdx];
      if (L.startMin >= earliest && canComplete(L.endMin, fullMask & ~used, needP, needC)) {
        candidates.push({ id: L.id, lockedEntry: L });
      }
    }

    // 候选 B：排在下一个锁定目标之前的自由目标
    if (needC > 0) {
      for (let j = 0; j < n; j++) {
        if (used & (1 << j)) continue;
        const s = earliestFrom(j, earliest);
        if (s === Infinity) continue;
        if (lockIdx < locked.length && s + free[j].durMin + slewMin > locked[lockIdx].startMin) continue;
        if (canComplete(s + free[j].durMin, fullMask & ~used & ~(1 << j), needP - free[j].priority, needC - 1)) {
          candidates.push({ id: free[j].id, freeIndex: j, startMin: s });
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error('内部错误：无法重构最优排程');
    }
    candidates.sort((a, b) => compareIds(a.id, b.id));
    const c = candidates[0];

    if (c.lockedEntry) {
      const L = c.lockedEntry;
      seq.push({ id: L.id, startMin: L.startMin, durMin: L.durMin, locked: true, priority: L.priority });
      cur = L.endMin;
      lockIdx++;
    } else {
      const j = c.freeIndex;
      seq.push({ id: free[j].id, startMin: c.startMin, durMin: free[j].durMin, locked: false, priority: free[j].priority });
      used |= 1 << j;
      needP -= free[j].priority;
      needC -= 1;
      cur = c.startMin + free[j].durMin;
    }
    started = true;
  }

  // ---- 汇总输出 ----
  const iso = (min) => new Date(min * MIN_MS).toISOString();
  const schedule = seq.map((e) => ({
    id: e.id,
    start: iso(e.startMin),
    end: iso(e.startMin + e.durMin),
    locked: e.locked,
    priority: e.priority,
  }));

  const unscheduled = [];
  for (let j = 0; j < n; j++) {
    if (used & (1 << j)) continue;
    const t = free[j];
    if (!astronomicallyVisible[j]) {
      unscheduled.push({
        id: t.id,
        reason: 'invisible',
        message: '不可见：时间窗内不存在曝光全程高度角不低于阈值的整分钟起点（或曝光无法完整落入时间窗）',
      });
    } else {
      unscheduled.push({
        id: t.id,
        reason: 'capacity',
        message: '容量不足：目标可见，但受时间窗长度、换台间隔与更高优先级目标约束，无法排入',
      });
    }
  }

  const lockedPriority = locked.reduce((s, L) => s + L.priority, 0);
  return {
    schedule,
    unscheduled,
    totalPriority: bestP + lockedPriority,
    scheduledCount: bestC + locked.length,
    bestFreePriority: bestP,
    bestFreeCount: bestC,
  };
}

/** 入口：校验 + 排程 */
function planFromBody(body) {
  const input = validateInput(body);
  const result = plan(input);
  return {
    site: { latitude: input.lat, longitude: input.lon },
    window: { start: new Date(input.w0Ms).toISOString(), end: new Date(input.w1Ms).toISOString() },
    slewMinutes: input.slewMin,
    ...result,
  };
}

module.exports = { planFromBody, validateInput, plan, ValidationError, LockedConflictError };

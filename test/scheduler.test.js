'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planFromBody, ValidationError, LockedConflictError } = require('../src/scheduler');
const { altitudeDeg, minAltitudeInInterval, gmstDeg } = require('../src/astro');

// 通用构造：minAltitude = -90 表示“永远可见”，用于隔离纯排程逻辑
function baseBody(overrides = {}) {
  return {
    latitude: 40,
    longitude: 116.4,
    windowStart: '2026-10-04T12:00:00Z',
    windowEnd: '2026-10-04T20:00:00Z',
    slewMinutes: 0,
    targets: [],
    ...overrides,
  };
}

function tgt(id, exposureMinutes, priority, extra = {}) {
  return { id, ra: 10, dec: 40, exposureMinutes, minAltitude: -90, priority, ...extra };
}

// ---------- 输入校验 ----------

test('非法纬度被拒绝', () => {
  assert.throws(() => planFromBody(baseBody({ latitude: 91 })), ValidationError);
  assert.throws(() => planFromBody(baseBody({ latitude: -90.1 })), ValidationError);
  assert.throws(() => planFromBody(baseBody({ latitude: 'abc' })), ValidationError);
});

test('非法经度被拒绝', () => {
  assert.throws(() => planFromBody(baseBody({ longitude: 181 })), ValidationError);
  assert.throws(() => planFromBody(baseBody({ longitude: -180.5 })), ValidationError);
});

test('非法时间窗被拒绝：无序、超 12 小时、不可解析', () => {
  assert.throws(
    () => planFromBody(baseBody({ windowStart: '2026-10-04T20:00:00Z', windowEnd: '2026-10-04T12:00:00Z' })),
    /开始时刻必须早于结束时刻/
  );
  assert.throws(
    () => planFromBody(baseBody({ windowEnd: '2026-10-05T00:00:01Z' })),
    /最长 12 小时/
  );
  assert.throws(() => planFromBody(baseBody({ windowStart: 'not-a-time' })), ValidationError);
  // 恰好 12 小时合法
  const ok = planFromBody(baseBody({ windowEnd: '2026-10-05T00:00:00Z' }));
  assert.equal(ok.scheduledCount, 0);
});

test('非法换台时长被拒绝', () => {
  assert.throws(() => planFromBody(baseBody({ slewMinutes: -1 })), /非负整数/);
  assert.throws(() => planFromBody(baseBody({ slewMinutes: 1.5 })), /非负整数/);
});

test('非法目标字段被拒绝', () => {
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 0, 1)] })), /曝光时长/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', -5, 1)] })), /曝光时长/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 30, 0)] })), /优先级/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 30, 1, { ra: 360 })] })), /赤经/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 30, 1, { ra: -1 })] })), /赤经/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 30, 1, { dec: 91 })] })), /赤纬/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 30, 1, { minAltitude: 91 })] })), /最低高度角/);
  assert.throws(() => planFromBody(baseBody({ targets: [tgt('A', 30, 1), tgt('A', 20, 2)] })), /编号重复/);
});

test('目标数量超过 16 被拒绝', () => {
  const targets = Array.from({ length: 17 }, (_, i) => tgt('T' + i, 10, 1));
  assert.throws(() => planFromBody(baseBody({ targets })), /至多/);
  // 恰好 16 个合法
  const ok = planFromBody(baseBody({ targets: targets.slice(0, 16) }));
  assert.equal(ok.scheduledCount, 16);
});

test('锁定开始必须对齐整分钟', () => {
  assert.throws(
    () => planFromBody(baseBody({ targets: [tgt('A', 30, 1, { lockStart: '2026-10-04T13:00:30Z' })] })),
    /整分钟/
  );
});

// ---------- 优化目标：优先级总和最大 ----------

test('优先级总和最大优先于目标数量', () => {
  // A(120分, prio 5) vs B+C(各60分, prio 3+3=6) -> 选 B+C
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T14:00:00Z',
    targets: [tgt('A', 120, 5), tgt('B', 60, 3), tgt('C', 60, 3)],
  }));
  assert.deepEqual(r.schedule.map((e) => e.id), ['B', 'C']);
  assert.equal(r.totalPriority, 6);
  // 但 A(prio 10) 高于 B+C(6) 时选 A
  const r2 = planFromBody(baseBody({
    windowEnd: '2026-10-04T14:00:00Z',
    targets: [tgt('A', 120, 10), tgt('B', 60, 3), tgt('C', 60, 3)],
  }));
  assert.deepEqual(r2.schedule.map((e) => e.id), ['A']);
  assert.equal(r2.totalPriority, 10);
});

test('优先级总和相同时目标数最多', () => {
  // D(60分, prio 2) vs E+F(各30分, prio 1+1=2) -> 选 E+F（数量 2 > 1）
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T13:00:00Z',
    targets: [tgt('D', 60, 2), tgt('E', 30, 1), tgt('F', 30, 1)],
  }));
  assert.deepEqual(r.schedule.map((e) => e.id), ['E', 'F']);
  assert.equal(r.scheduledCount, 2);
});

test('同分时编号序列与开始时刻字典序最小，且整分钟开始', () => {
  // a、b 等价 -> 序列 ['a','b'] 字典序最小；起点应取最早整分钟
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T14:00:00Z',
    targets: [tgt('b', 60, 1), tgt('a', 60, 1)],
  }));
  assert.deepEqual(r.schedule.map((e) => e.id), ['a', 'b']);
  assert.equal(r.schedule[0].start, '2026-10-04T12:00:00.000Z');
  assert.equal(r.schedule[1].start, '2026-10-04T13:00:00.000Z');
  for (const e of r.schedule) {
    assert.equal(Date.parse(e.start) % 60000, 0);
  }
});

test('换台间隔约束生效', () => {
  // 2 小时窗 + 10 分钟换台：两个 60 分钟目标无法都排入
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T14:00:00Z',
    slewMinutes: 10,
    targets: [tgt('G', 60, 1), tgt('H', 60, 1)],
  }));
  assert.equal(r.schedule.length, 1);
  assert.equal(r.schedule[0].id, 'G'); // 同分取编号字典序最小
  assert.equal(r.unscheduled[0].id, 'H');
  assert.equal(r.unscheduled[0].reason, 'capacity');
  // 放宽到 2 小时 10 分 + 换台 10 分：两者皆可，间隔恰好 10 分钟
  const r2 = planFromBody(baseBody({
    windowEnd: '2026-10-04T14:10:00Z',
    slewMinutes: 10,
    targets: [tgt('G', 60, 1), tgt('H', 60, 1)],
  }));
  assert.deepEqual(r2.schedule.map((e) => e.id), ['G', 'H']);
  assert.equal(r2.schedule[1].start, '2026-10-04T13:10:00.000Z');
});

test('每个目标至多排一次', () => {
  const r = planFromBody(baseBody({ targets: [tgt('A', 30, 5)] }));
  assert.equal(r.schedule.filter((e) => e.id === 'A').length, 1);
});

test('数值编号按数值序取字典序最小', () => {
  // 编号 2 与 10：数值序 2 < 10（而非字符串序 "10" < "2"）
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T14:00:00Z',
    targets: [tgt('10', 60, 1), tgt('2', 60, 1)],
  }));
  assert.deepEqual(r.schedule.map((e) => e.id), ['2', '10']);
});

test('锁定目标参与整体序列的字典序比较', () => {
  // 锁定 A 在 13:00；自由 Z 排在 A 前（12:00）则序列首项为 Z，
  // 排在 A 后则序列首项为 A。'A' < 'Z'，故最优序列为 A 先、Z 紧随其后。
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T15:00:00Z',
    targets: [
      tgt('A', 60, 1, { lockStart: '2026-10-04T13:00:00Z' }),
      tgt('Z', 30, 1),
    ],
  }));
  assert.deepEqual(r.schedule.map((e) => e.id), ['A', 'Z']);
  assert.equal(r.schedule[1].start, '2026-10-04T14:00:00.000Z');
});

// ---------- 锁定目标 ----------

test('锁定目标按指定整分钟排入，自由目标环绕其排程', () => {
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T15:00:00Z',
    slewMinutes: 10,
    targets: [
      tgt('J', 30, 5, { lockStart: '2026-10-04T13:00:00Z' }),
      tgt('K', 60, 1),
    ],
  }));
  // K 在 J 前放不下（需 60+10 <= 60 分钟空隙），只能排在 J 之后 10 分钟
  assert.deepEqual(r.schedule.map((e) => e.id), ['J', 'K']);
  assert.equal(r.schedule[0].start, '2026-10-04T13:00:00.000Z');
  assert.equal(r.schedule[0].locked, true);
  assert.equal(r.schedule[1].start, '2026-10-04T13:40:00.000Z');
  assert.equal(r.totalPriority, 6);
});

test('锁定目标不可见时整次拒绝并指出目标', () => {
  assert.throws(
    () => planFromBody(baseBody({
      targets: [tgt('L', 30, 1, { minAltitude: 89, dec: -80, lockStart: '2026-10-04T13:00:00Z' })],
    })),
    (e) => e instanceof LockedConflictError && e.targets.includes('L') && /低于阈值/.test(e.message)
  );
});

test('锁定目标超出时间窗时整次拒绝', () => {
  assert.throws(
    () => planFromBody(baseBody({
      targets: [tgt('L', 30, 1, { lockStart: '2026-10-04T11:30:00Z' })],
    })),
    (e) => e instanceof LockedConflictError && e.targets.includes('L')
  );
});

test('锁定目标互相冲突（含换台间隔）时整次拒绝并指出双方', () => {
  assert.throws(
    () => planFromBody(baseBody({
      slewMinutes: 10,
      targets: [
        tgt('X', 60, 1, { lockStart: '2026-10-04T13:00:00Z' }),
        tgt('Y', 60, 1, { lockStart: '2026-10-04T14:05:00Z' }), // 间隔仅 5 分钟 < 10
      ],
    })),
    (e) => e instanceof LockedConflictError && e.targets.includes('X') && e.targets.includes('Y')
  );
});

// ---------- 可见性与未入选原因 ----------

test('始终低于高度阈值的目标记为不可见', () => {
  const r = planFromBody(baseBody({
    targets: [tgt('LOW', 30, 1, { dec: -80, minAltitude: 10 })],
  }));
  assert.equal(r.schedule.length, 0);
  assert.equal(r.unscheduled.length, 1);
  assert.equal(r.unscheduled[0].reason, 'invisible');
});

test('可见但容量不足的目标记为容量不足', () => {
  const r = planFromBody(baseBody({
    windowEnd: '2026-10-04T13:00:00Z',
    targets: [tgt('BIG', 60, 5), tgt('SMALL', 60, 1)],
  }));
  assert.deepEqual(r.schedule.map((e) => e.id), ['BIG']);
  assert.equal(r.unscheduled[0].id, 'SMALL');
  assert.equal(r.unscheduled[0].reason, 'capacity');
});

test('时间窗带秒时起点仍对齐整分钟且不越界', () => {
  const r = planFromBody(baseBody({
    windowStart: '2026-10-04T12:00:30Z',
    windowEnd: '2026-10-04T13:00:29Z',
    targets: [tgt('A', 59, 1)],
  }));
  assert.equal(r.schedule.length, 1);
  assert.equal(r.schedule[0].start, '2026-10-04T12:01:00.000Z'); // 首个不早于窗起的整分钟
  assert.equal(r.schedule[0].end, '2026-10-04T13:00:00.000Z'); // 结束不晚于窗止
});

// ---------- 天文计算 ----------

test('中天高度角公式正确', () => {
  const t = Date.parse('2026-10-04T16:00:00Z');
  const lat = 40, lon = 116.4, dec = 25;
  const ra = (gmstDeg(t) + lon) % 360; // 令目标此刻上中天
  const alt = altitudeDeg(t, lat, lon, ra, dec);
  assert.ok(Math.abs(alt - (90 - Math.abs(lat - dec))) < 1e-6, `alt=${alt}`);
});

test('区间最低高度角解析解与采样一致', () => {
  const lat = 40, lon = 116.4;
  const cases = [
    { ra: 10, dec: 40 }, { ra: 83.8, dec: -5.4 }, { ra: 300, dec: 60 }, { ra: 180, dec: -60 },
  ];
  const t0 = Date.parse('2026-10-04T12:00:00Z');
  for (const { ra, dec } of cases) {
    const t1 = t0 + 3600000;
    const t2 = t1 + 2 * 3600000;
    const analytic = minAltitudeInInterval(t1, t2, lat, lon, ra, dec);
    let sampled = Infinity;
    for (let t = t1; t <= t2; t += 20000) {
      sampled = Math.min(sampled, altitudeDeg(t, lat, lon, ra, dec));
    }
    assert.ok(analytic <= sampled + 1e-9, `解析最小值不应高于采样最小值: ${analytic} vs ${sampled}`);
    assert.ok(analytic > sampled - 0.05, `解析最小值不应明显低于采样最小值: ${analytic} vs ${sampled}`);
  }
});

test('曝光跨越下中天时整段高度校验生效', () => {
  // 目标 dec=-80 在 lat=40 处最高约 -30°，任何 60 分钟曝光都不可能 >= -20°
  const r = planFromBody(baseBody({
    targets: [tgt('LOW', 60, 1, { dec: -80, minAltitude: -20 })],
  }));
  assert.equal(r.schedule.length, 0);
  assert.equal(r.unscheduled[0].reason, 'invisible');
});

// 排程核心自测：node test/selftest.js
import { scheduleRequest } from '../src/scheduler.js';
import { altitude, gmst, lst } from '../src/astro.js';

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

const W0 = '2026-10-04T22:00:00Z';
const WH = '2026-10-05T06:00:00Z'; // 8 小时
const W2 = '2026-10-04T23:59:00Z'; // 119 分钟
const mk = (id, over) => ({
  id, ra: 0, dec: 90, expMin: 20, minAlt: 0, priority: 1, ...over,
});

console.log('A. 天文计算');
{
  // J2000.0 历元 GMST 已知约为 280.4606°
  const g = gmst(new Date('2000-01-01T12:00:00Z'));
  assert(approx(g, 280.4606, 0.01), `J2000 GMST=${g.toFixed(4)}° ≈ 280.4606°`);
  // 天北极在任意时刻高度角恒等于纬度
  const a = altitude(new Date(W0), 40, 116, 0, 90);
  assert(approx(a, 40, 1e-9), `北极星高度角=${a}≈纬度 40°`);
  // LST 每分钟约增加 0.2507°
  const l1 = lst(new Date(W0), 116);
  const l2 = lst(new Date('2026-10-04T22:01:00Z'), 116);
  const dl = (l2 - l1 + 360) % 360;
  assert(approx(dl, 0.2506845, 1e-4), `LST 1 分钟增量=${dl.toFixed(5)}°`);
}

console.log('B. 非法参数必须拒绝');
{
  const r1 = scheduleRequest({ latitude: 91, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0, targets: [mk(1)] });
  assert(!r1.ok && r1.errors.some((e) => e.field === 'latitude'), '纬度 91 被拒绝');
  const r2 = scheduleRequest({ latitude: 0, longitude: 200, startUtc: W0, endUtc: WH, slewMin: 0, targets: [mk(1)] });
  assert(!r2.ok && r2.errors.some((e) => e.field === 'longitude'), '经度 200 被拒绝');
  const r3 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: WH, endUtc: W0, slewMin: 0, targets: [mk(1)] });
  assert(!r3.ok && r3.errors.some((e) => e.field === 'endUtc'), '结束早于开始被拒绝');
  const r4 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: W0, endUtc: '2026-10-05T10:01:00Z', slewMin: 0, targets: [mk(1)] });
  assert(!r4.ok && r4.errors.some((e) => /720/.test(e.message)), '超过 12 小时窗口被拒绝');
  const r5 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: W0, endUtc: WH, slewMin: -1, targets: [mk(1)] });
  assert(!r5.ok && r5.errors.some((e) => e.field === 'slewMin'), '负换台时间被拒绝');
  const r6 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: W0, endUtc: '2026-10-04 23:00', slewMin: 0, targets: [mk(1)] });
  assert(!r6.ok && r6.errors.some((e) => e.field === 'endUtc'), '不带时区的时间被拒绝');
  const many = Array.from({ length: 17 }, (_, i) => mk(i + 1));
  const r7 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0, targets: many });
  assert(!r7.ok && r7.errors.some((e) => e.field === 'targets'), '17 个目标被拒绝');
  const r8 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0, targets: [mk(1, { ra: 360 })] });
  assert(!r8.ok, 'RA=360 被拒绝');
  const r9 = scheduleRequest({ latitude: 0, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0, targets: [mk(1, { priority: 0 })] });
  assert(!r9.ok, '优先级 0 被拒绝');
}

console.log('C. 容量：能排多少排多少，且整分钟开始/结束对齐窗边界');
{
  // 窗恰好 120 分钟，曝光 30，换台 0：可排 4 个（k=0,30,60,90，最后结束于 k=120）
  const ts = [mk(1, { expMin: 30 }), mk(2, { expMin: 30 }), mk(3, { expMin: 30 }), mk(4, { expMin: 30 }), mk(5, { expMin: 30 })];
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-05T00:00:00Z', slewMin: 0, targets: ts });
  assert(r.ok, `排程成功（scheduled=${r?.schedule?.length}）`);
  if (r.ok) {
    assert(r.schedule.length === 4, `排入 4 个，实际 ${r.schedule.length}`);
    assert(r.schedule[0].startUtc === W0, '第一个在窗整分钟起点开始');
    assert(r.schedule[r.schedule.length - 1].endUtc === '2026-10-05T00:00:00Z', '最后一个在窗整分钟终点结束');
  }
}

console.log('D. 优先级总和优先，其次数量');
{
  // 70 分钟窗，换台 0：
  // #1 60min p2；#2 30min p4；#3 30min p4；#4 15min p1
  // 最优 = 2+3+4（p=9, n=3，占用 75? 30+30+15=75>70）→ 2+3（p=8,n=2）
  // 调整 #4=10min：2+3+4=70 → p=9,n=3
  const ts = [
    mk(1, { expMin: 60, priority: 2 }),
    mk(2, { expMin: 30, priority: 4 }),
    mk(3, { expMin: 30, priority: 4 }),
    mk(4, { expMin: 10, priority: 1 }),
  ];
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-04T23:10:00Z', slewMin: 0, targets: ts });
  assert(r.ok, '排程成功');
  if (r.ok) {
    const ids = r.schedule.map((x) => x.id);
    assert(r.summary.totalPriority === 9, `优先级总和=9，实际 ${r.summary.totalPriority}`);
    assert(r.schedule.length === 3, `数量=3，实际 ${r.schedule.length}`);
    assert(JSON.stringify(ids) === JSON.stringify([2, 3, 4]), `编号序列 [2,3,4]，实际 [${ids}]`);
    assert(r.unscheduled.length === 1 && r.unscheduled[0].id === 1, '未入选 #1 且原因为容量不足');
    assert(r.unscheduled[0].reason === '容量不足', `原因=${r.unscheduled[0].reason}`);
  }
}

console.log('E. 锁定项互相冲突 / 不可见 → 整次拒绝并指出目标');
{
  const ts = [
    mk(1, { lockAt: '2026-10-04T22:00:00Z' }),
    mk(2, { lockAt: '2026-10-04T22:20:00Z' }), // 换台 0 时恰好衔接；换台 15 时冲突
  ];
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0, targets: ts });
  // slew=0 时不冲突；改用 slew=15
  const r2 = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 15, targets: ts });
  assert(r.ok, '换台 0 时两个锁定兼容');
  assert(!r2.ok && r2.lockViolations?.some((v) => v.targets && v.targets.includes(1) && v.targets.includes(2)),
    '换台 15 时锁定冲突被拒绝并指出两个目标');
  // 锁在窗外
  const r3 = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0,
    targets: [mk(1, { expMin: 20, lockAt: '2026-10-05T05:50:00Z' })] });
  assert(!r3.ok && r3.lockViolations[0].id === 1 && r3.lockViolations[0].reason === '时间窗外', '锁定曝光越窗被拒绝');
  // 锁定非整分钟
  const r4 = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 0,
    targets: [mk(1, { lockAt: '2026-10-04T22:00:30Z' })] });
  assert(!r4.ok && r4.lockViolations[0].reason === '非整分钟', '非整分钟锁定被拒绝');
  // 锁定时目标不可见（南天 -80°，在北纬 40° 永不下升？始终在地平下）
  const r5 = scheduleRequest({ latitude: 40, longitude: 116, startUtc: W0, endUtc: WH, slewMin: 0,
    targets: [mk(1, { ra: 180, dec: -80, minAlt: 0, lockAt: W0 })] });
  assert(!r5.ok && r5.lockViolations[0].reason === '不可见', '不可见锁定被拒绝');
}

console.log('F. 非锁定不可见目标给出原因，锁定目标仍排入');
{
  const r = scheduleRequest({ latitude: 40, longitude: 116, startUtc: W0, endUtc: WH, slewMin: 10,
    targets: [
      mk(1, { ra: 0, dec: 90 }),
      mk(9, { ra: 180, dec: -80, minAlt: 0, priority: 9 }),
    ] });
  assert(r.ok, '排程成功');
  if (r.ok) {
    assert(r.schedule.length === 1 && r.schedule[0].id === 1, '仅北极星排入');
    assert(r.unscheduled.length === 1 && r.unscheduled[0].id === 9 && r.unscheduled[0].reason === '不可见',
      '南天目标标注不可见');
  }
}

console.log('G. 换台间隔强制留足');
{
  const ts = [mk(1, { expMin: 20 }), mk(2, { expMin: 20 })];
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-04T22:55:00Z', slewMin: 15, targets: ts });
  assert(r.ok && r.schedule.length === 2, '两个目标均可排');
  if (r.ok && r.schedule.length === 2) {
    const gap = (Date.parse(r.schedule[1].startUtc) - Date.parse(r.schedule[0].endUtc)) / 60000;
    assert(gap === 15, `相邻曝光间隔=${gap} 分钟 = 换台 15`);
  }
  const r2 = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-04T22:54:00Z', slewMin: 15, targets: ts });
  assert(r2.ok && r2.schedule.length === 1, '差 1 分钟窗口只能排 1 个');
}

console.log('H. 字典序：必要时空转以取得更小的编号序列');
{
  // 全窗可见（极近北极），换台 0，窗 120 分钟。
  // #1: 60min，#2: 60min。#1 在 k=0 排会占满前 60，#2 只能 k=60 → 序列 [1,2]
  // 但 #2 从 k=0、#1 从 k=60 同样可行 → 序列 [2,1]；字典序 [1,2] 更小 → 期望 [1,2]
  // 再制造需要空转的场景：#2 60min、#1 60min，#1 不可在 k<60 开始（人为：给 #1 exp=60 不可行早期？
  // 恒可见无法构造）。改用 minAlt 限制不可靠，这里直接验证同优先级下小编号优先。
  const ts = [mk(2, { expMin: 60 }), mk(1, { expMin: 60 })];
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-05T00:00:00Z', slewMin: 0, targets: ts });
  assert(r.ok, '排程成功');
  if (r.ok) {
    const ids = r.schedule.map((x) => x.id);
    const ks = r.schedule.map((x) => x.startOffsetMin);
    assert(JSON.stringify(ids) === JSON.stringify([1, 2]), `编号序列 [1,2]，实际 [${ids}]`);
    assert(JSON.stringify(ks) === JSON.stringify([0, 60]), `开始序列 [0,60]，实际 [${ks}]`);
  }
}

console.log('H2. 必要时空转越过锁定块，以取得编号序列字典序最小的最优解');
{
  // 窗 120 分钟，换台 0，恒可见。#7 锁定 k=40..50。#1、#2 均 35 分钟：
  //   - #1 立刻排(k=0..35) 后，锁定 40..50，之后仅剩 70 分钟，#2(35) 可排
  //     → 序列 [1,7,2]
  //   - 直接空转到锁定后：#1(50..85)、#2(85..120) → 序列 [7,1,2]
  // 两者均排入全部 3 个目标，字典序 [1,7,2] 更小 → 第一个事件应是 #1。
  // 把 #1 改成 45 分钟：立即排(0..45)与锁定(40..50)冲突，立即排不可行，
  // 3 目标全排只能空转到锁定之后 → 第一个事件必须是 #7。
  const cases = [
    { exp1: 35, expect: [1, 7, 2], note: '立即排 #1 给出更小编号序列' },
    { exp1: 45, expect: [2, 7, 1], note: '#1 立即排与锁定冲突；先排 #2、空转越过锁定后排 #1' },
  ];
  for (const c of cases) {
    const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-05T00:00:00Z', slewMin: 0,
      targets: [
        mk(1, { expMin: c.exp1 }),
        mk(2, { expMin: 35 }),
        mk(7, { expMin: 10, lockAt: '2026-10-04T22:40:00Z' }),
      ] });
    assert(r.ok, `排程成功（exp1=${c.exp1}）`);
    if (r.ok) {
      const ids = r.schedule.map((x) => x.id);
      assert(r.schedule.length === 3, `排入 3 个（exp1=${c.exp1}），实际 ${r.schedule.length}`);
      assert(JSON.stringify(ids) === JSON.stringify(c.expect),
        `${c.note}：期望 [${c.expect}]，实际 [${ids}]`);
    }
  }
}

console.log('I. 编号序列相同则开始时刻序列字典序最小（尽早开始）');
{
  const ts = [mk(1, { expMin: 20, priority: 3 }), mk(2, { expMin: 20, priority: 1 })];
  // 窗 120 分钟：两个都排，#1 应尽早（k=0）
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: '2026-10-05T00:00:00Z', slewMin: 10, targets: ts });
  assert(r.ok, '排程成功');
  if (r.ok) {
    assert(r.schedule[0].id === 1 && r.schedule[0].startOffsetMin === 0, '高优先级 #1 尽早开始');
  }
}

console.log('J. 锁定与自动目标交错，锁定时间固定');
{
  const r = scheduleRequest({ latitude: 89.9, longitude: 0, startUtc: W0, endUtc: WH, slewMin: 10,
    targets: [
      mk(1, { expMin: 20 }),
      mk(7, { expMin: 20, lockAt: '2026-10-04T23:00:00Z' }),
      mk(2, { expMin: 20 }),
    ] });
  assert(r.ok, '排程成功');
  if (r.ok) {
    assert(r.schedule.length === 3, `排入 3 个，实际 ${r.schedule.length}`);
    const locked = r.schedule.find((x) => x.id === 7);
    assert(locked.locked && locked.startUtc === '2026-10-04T23:00:00Z', '锁定项时刻固定');
    const gapsOk = r.schedule.slice(1).every((x, i) =>
      (Date.parse(x.startUtc) - Date.parse(r.schedule[i].endUtc)) / 60000 >= 10);
    assert(gapsOk, '与锁定项相邻处也满足换台间隔');
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

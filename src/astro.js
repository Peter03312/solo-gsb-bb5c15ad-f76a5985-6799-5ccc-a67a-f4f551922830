'use strict';

/**
 * 天文计算：由测站经纬度与 UTC 时刻计算目标（赤经/赤纬，度）的地平高度角。
 * 使用 GMST 近似公式（忽略章动、光行差与大气折射，对业余观测排程足够）。
 */

const DEG = Math.PI / 180;
const MS_PER_DAY = 86400000;
// GMST 公式常数（IERS 近似）：GMST = GMST0 + GMST_RATE * d（d 为自 J2000.0 的 UT 天数）
const GMST0 = 280.46061837;
const GMST_RATE = 360.98564736629; // 度 / 平太阳日

/** 格林尼治平恒星时（度，0..360） */
function gmstDeg(timeMs) {
  const jd = timeMs / MS_PER_DAY + 2440587.5;
  const d = jd - 2451545.0;
  let g = (GMST0 + GMST_RATE * d) % 360;
  if (g < 0) g += 360;
  return g;
}

/** 时角（度，0..360），东经为正 */
function hourAngleDeg(timeMs, lonDeg, raDeg) {
  let ha = (gmstDeg(timeMs) + lonDeg - raDeg) % 360;
  if (ha < 0) ha += 360;
  return ha;
}

/** 某一时刻的地平高度角（度） */
function altitudeDeg(timeMs, latDeg, lonDeg, raDeg, decDeg) {
  const ha = hourAngleDeg(timeMs, lonDeg, raDeg) * DEG;
  const lat = latDeg * DEG;
  const dec = decDeg * DEG;
  const s = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

/**
 * 区间 [t1Ms, t2Ms] 内高度角的最小值（解析法，O(1)）。
 * 高度角随时角 H 的余弦单调变化，最小值只可能出现在区间端点
 * 或下中天（H = 180°）处。
 */
function minAltitudeInInterval(t1Ms, t2Ms, latDeg, lonDeg, raDeg, decDeg) {
  let mn = Math.min(
    altitudeDeg(t1Ms, latDeg, lonDeg, raDeg, decDeg),
    altitudeDeg(t2Ms, latDeg, lonDeg, raDeg, decDeg)
  );
  const ha1 = hourAngleDeg(t1Ms, lonDeg, raDeg);
  const omegaDegPerMs = GMST_RATE / MS_PER_DAY; // 时角推进速率
  let delta = (180 - ha1) % 360;
  if (delta < 0) delta += 360;
  const tLowerCulmination = t1Ms + delta / omegaDegPerMs;
  if (tLowerCulmination > t1Ms && tLowerCulmination < t2Ms) {
    mn = Math.min(mn, altitudeDeg(tLowerCulmination, latDeg, lonDeg, raDeg, decDeg));
  }
  return mn;
}

module.exports = { gmstDeg, hourAngleDeg, altitudeDeg, minAltitudeInInterval };

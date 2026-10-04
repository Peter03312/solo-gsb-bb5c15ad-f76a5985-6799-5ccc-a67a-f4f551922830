// 天文计算：GMST、地方恒星时、目标高度角
// 角度一律以度为单位，时间以 Date / Julian Date 表示。

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
export const SOLAR2SIDEREAL = 1.00273790935; // 平太阳日 -> 恒星日比例

/** 把任意角度规整到 [0, 360)。 */
export function norm360(a) {
  return ((a % 360) + 360) % 360;
}

/** Julian Date（UT，以日为单位）。 */
export function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Greenwich Mean Sidereal Time（度），Meeus 公式，忽略历元微小项，
 * 对单晚（≤12 小时）排程精度远高于 1 角分。
 */
export function gmst(date) {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525;
  const gmstSec =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * T +
    0.093104 * T * T -
    6.2e-6 * T * T * T;
  // 86400 平太阳秒对应 360 度恒星时
  return norm360((gmstSec / 86400) * 360);
}

/** 地方恒星时 LST（度）。lon 东经为正、西经为负。 */
export function lst(date, lon) {
  return norm360(gmst(date) + lon);
}

/**
 * 某时刻目标高度角（度）。
 * @param ra  赤经（度，0..360）
 * @param dec 赤纬（度）
 */
export function altitude(date, lat, lon, ra, dec) {
  const h = norm360(lst(date, lon) - ra) * RAD;
  const sinAlt =
    Math.sin(lat * RAD) * Math.sin(dec * RAD) +
    Math.cos(lat * RAD) * Math.cos(dec * RAD) * Math.cos(h);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

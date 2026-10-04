// 目标可见性模型。
//
// 时间窗离散为整分钟网格，偏移 k = (t - base)/60000。
// H 随时间连续变化（恒星时速率 ≈ 360.9856°/太阳日 ≈ 0.250684°/分钟），
// 故一次曝光对应连续的小时角弧线。可见条件采用解析判据（弧线端点），
// 不做时间采样，避免漏判。

const DHA = 1.00273790935 * 0.25; // 每分钟小时角变化（度），向西为正
const EPS = 1e-7;

export { DHA };

/**
 * 单个目标在一个时间窗内的可见性。
 * @param target {ra, dec, expMin, minAlt}
 * @param K      网格分钟数；可开始曝光的位置为 k = 0..K-expMin
 * @param latDeg 纬度（度）
 */
export class VisModel {
  constructor(target, K, latDeg) {
    this.exp = target.expMin;
    this.minAlt = target.minAlt;
    this.K = K;

    const phi = (latDeg * Math.PI) / 180;
    const d = (target.dec * Math.PI) / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    this._sinD = Math.sin(d);
    this._cosD = Math.cos(d);

    // 过中天最大高度角；恒低于阈值则永远不可见
    const sinPeak = sinPhi * this._sinD + cosPhi * this._cosD;
    this.peakAlt =
      (Math.asin(Math.max(-1, Math.min(1, sinPeak))) * 180) / Math.PI;
    this.neverVisible = this.peakAlt + EPS < target.minAlt;

    if (!this.neverVisible) {
      // |H| <= Hmax 时单点高度角 >= minAlt
      const sinA = Math.sin((target.minAlt * Math.PI) / 180);
      const cosHmax = (sinA - sinPhi * this._sinD) / (cosPhi * this._cosD);
      this.Hmax =
        cosHmax >= 1 - EPS
          ? 180
          : (Math.acos(Math.max(-1, Math.min(1, cosHmax))) * 180) / Math.PI;
      this.arc = this.exp * DHA; // 一次曝光扫过的小时角（度）
    }
  }

  /** 把连续 H 规整到 (-180,180]（上中天 H=0）。 */
  static wrap(H) {
    return ((((H + 180) % 360) + 360) % 360) - 180;
  }

  /**
   * @param Hstart 曝光开始时的连续小时角（度）
   * @returns 整段曝光高度角是否始终 >= minAlt
   */
  arcFits(Hstart) {
    if (this.neverVisible) return false;
    if (this.arc + EPS >= 2 * this.Hmax) return false; // 可见窗口短于曝光
    const H1 = VisModel.wrap(Hstart);
    const H2raw = H1 + this.arc;
    const H2 = VisModel.wrap(H2raw);
    // 弧线必须连续落在上中天一侧（不经过下中天 ±180）
    const wrapped = Math.abs(H2raw) > 180 + EPS;
    if (wrapped) return false;
    return Math.max(Math.abs(H1), Math.abs(H2)) <= this.Hmax + EPS;
  }

  /** 某时刻目标单点高度角是否 >= minAlt。 */
  pointFits(H) {
    if (this.neverVisible) return false;
    return Math.abs(VisModel.wrap(H)) <= this.Hmax + EPS;
  }

  /**
   * 逐分钟位图。
   * @param H0 base 时刻的连续小时角（度）
   * @returns {{fits: Uint8Array, point: Uint8Array}}
   */
  buildGrid(H0) {
    const fits = new Uint8Array(this.K + 1);
    const point = new Uint8Array(this.K + 1);
    if (this.neverVisible) return { fits, point };
    for (let k = 0; k <= this.K; k++) {
      const H = H0 + k * DHA;
      point[k] = this.pointFits(H) ? 1 : 0;
      if (k <= this.K - this.exp) fits[k] = this.arcFits(H) ? 1 : 0;
    }
    return { fits, point };
  }

  /** 曝光全程最低高度角（度），用于结果展示。Hstart 连续，lon/lat 仅这里需要。 */
  minAltitudeOn(Hstart, latDeg) {
    if (this.neverVisible) return NaN;
    const phi = (latDeg * Math.PI) / 180;
    const sinAlt = (h) =>
      Math.sin(phi) * this._sinD +
      Math.cos(phi) * this._cosD * Math.cos((h * Math.PI) / 180);
    const H1 = VisModel.wrap(Hstart);
    const H2raw = H1 + this.arc;
    // 连续弧线的高度角极值在端点（中天在弧内时为最高点，最低仍取端点）
    const worst = Math.min(sinAlt(H1), sinAlt(VisModel.wrap(H2raw)));
    return (Math.asin(Math.max(-1, Math.min(1, worst))) * 180) / Math.PI;
  }
}

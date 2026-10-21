// Statistik untuk menguji apakah hasil backtest lebih dari sekadar keberuntungan.
// Referensi: Bailey & López de Prado (2012) "The Sharpe Ratio Efficient Frontier" (PSR) dan
// (2014) "The Deflated Sharpe Ratio" (DSR, koreksi untuk banyaknya strategi yang diuji).

const EULER = 0.5772156649015329;

// CDF normal standar (Abramowitz-Stegun 7.1.26 lewat erf).
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Invers CDF normal (algoritma Acklam), galat relatif < 1.2e-9.
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface Moments {
  n: number;
  mean: number;
  sd: number;
  skew: number;
  kurt: number; // bukan excess (normal = 3)
}

export function moments(xs: ArrayLike<number>): Moments {
  const n = xs.length;
  if (n < 2) return { n, mean: 0, sd: 0, skew: 0, kurt: 3 };
  let m = 0;
  for (let i = 0; i < n; i++) m += xs[i];
  m /= n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const sd = Math.sqrt(m2);
  return { n, mean: m, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / m2 ** 2 : 3 };
}

// Sharpe per periode (tidak disetahunkan).
export function sharpe(xs: ArrayLike<number>): number {
  const m = moments(xs);
  return m.sd > 0 ? m.mean / m.sd : 0;
}

// Probabilistic Sharpe Ratio: peluang Sharpe sebenarnya > srStar, memperhitungkan
// panjang sampel, skew dan fat tail.
export function psr(xs: ArrayLike<number>, srStar = 0): number {
  const m = moments(xs);
  if (m.n < 3 || m.sd === 0) return 0;
  const sr = m.mean / m.sd;
  const denom = Math.sqrt(Math.max(1e-12, 1 - m.skew * sr + ((m.kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - srStar) * Math.sqrt(m.n - 1)) / denom);
}

// Sharpe yang diharapkan dari kandidat TERBAIK bila semua kandidat sebenarnya tanpa edge.
// trials = jumlah kandidat yang diuji, srVariance = varians Sharpe antar kandidat.
export function expectedMaxSharpe(trials: number, srVariance: number): number {
  if (trials < 2 || srVariance <= 0) return 0;
  return Math.sqrt(srVariance) * ((1 - EULER) * normInv(1 - 1 / trials) + EULER * normInv(1 - 1 / (trials * Math.E)));
}

// Deflated Sharpe Ratio = PSR terhadap ambang "juara karena untung-untungan".
export function dsr(xs: ArrayLike<number>, trials: number, srVariance: number): number {
  return psr(xs, expectedMaxSharpe(trials, srVariance));
}

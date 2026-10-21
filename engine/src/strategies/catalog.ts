import { atr, ema, priorMax, priorMin, rollingStd, rsi, sma } from '../lib/indicators';
import { weekStart } from '../lib/time';
import type { Dataset, Params, PortfolioStrategy, Series, SingleStrategy, Strategy } from './types';

// Semua lookback dalam satuan bar. Default interval 1h: 24 = 1 hari, 168 = 1 minggu.

const donchian: SingleStrategy = {
  id: 'donchian',
  name: 'Donchian Breakout',
  family: 'breakout',
  kind: 'single',
  description:
    'Masuk saat harga menembus high/low N bar terakhir, keluar saat menembus channel separuhnya. Ala Turtle: menunggang tren besar, siap rugi kecil berkali-kali.',
  grid: [
    { n: 24, exit: 12 },
    { n: 72, exit: 36 },
    { n: 168, exit: 72 },
  ],
  label: (p) => `Donchian ${p.n}/${p.exit}`,
  signal(s, p) {
    const hi = priorMax(s.h, p.n);
    const lo = priorMin(s.l, p.n);
    const hiX = priorMax(s.h, p.exit);
    const loX = priorMin(s.l, p.exit);
    const out = new Float64Array(s.c.length);
    let state = 0;
    for (let i = p.n; i < s.c.length; i++) {
      const c = s.c[i];
      if (c > hi[i]) state = 1;
      else if (c < lo[i]) state = -1;
      else if (state === 1 && c < loX[i]) state = 0;
      else if (state === -1 && c > hiX[i]) state = 0;
      out[i] = state;
    }
    return out;
  },
};

const emaTrend: SingleStrategy = {
  id: 'ema-trend',
  name: 'EMA Trend + ATR Trail',
  family: 'trend',
  kind: 'single',
  description:
    'Arah mengikuti persilangan EMA cepat/lambat. Trailing stop k x ATR mengunci profit; setelah kena stop, tunggu persilangan berikutnya.',
  grid: [
    { fast: 12, slow: 72, k: 3 },
    { fast: 24, slow: 168, k: 3 },
    { fast: 24, slow: 72, k: 4 },
    { fast: 48, slow: 336, k: 5 },
  ],
  label: (p) => `EMA ${p.fast}/${p.slow} · ${p.k}ATR`,
  signal(s, p) {
    const f = ema(s.c, p.fast);
    const sl = ema(s.c, p.slow);
    const a = atr(s.h, s.l, s.c, 24);
    const out = new Float64Array(s.c.length);
    let dir = 0;
    let state = 0;
    let extreme = 0;
    for (let i = p.slow; i < s.c.length; i++) {
      const c = s.c[i];
      const d = f[i] > sl[i] ? 1 : -1;
      if (d !== dir) {
        dir = d;
        state = d;
        extreme = c;
      }
      if (state === 1) {
        extreme = Math.max(extreme, c);
        if (c < extreme - p.k * a[i]) state = 0;
      } else if (state === -1) {
        extreme = Math.min(extreme, c);
        if (c > extreme + p.k * a[i]) state = 0;
      }
      out[i] = state;
    }
    return out;
  },
};

const supertrend: SingleStrategy = {
  id: 'supertrend',
  name: 'Supertrend',
  family: 'trend',
  kind: 'single',
  description: 'Band ATR yang mengikuti harga. Selalu di pasar: long di atas band, short di bawahnya. Agresif dan cepat berbalik arah.',
  grid: [
    { period: 10, mult: 3 },
    { period: 22, mult: 3 },
    { period: 48, mult: 4 },
  ],
  label: (p) => `Supertrend ${p.period}×${p.mult}`,
  signal(s, p) {
    const a = atr(s.h, s.l, s.c, p.period);
    const out = new Float64Array(s.c.length);
    let upper = NaN;
    let lower = NaN;
    let dir = 1;
    for (let i = p.period; i < s.c.length; i++) {
      const mid = (s.h[i] + s.l[i]) / 2;
      const bu = mid + p.mult * a[i];
      const bl = mid - p.mult * a[i];
      const prevC = s.c[i - 1];
      upper = Number.isNaN(upper) || bu < upper || prevC > upper ? bu : upper;
      lower = Number.isNaN(lower) || bl > lower || prevC < lower ? bl : lower;
      if (dir === 1 && s.c[i] < lower) dir = -1;
      else if (dir === -1 && s.c[i] > upper) dir = 1;
      out[i] = dir;
    }
    return out;
  },
};

const squeeze: SingleStrategy = {
  id: 'squeeze',
  name: 'Volatility Squeeze',
  family: 'breakout',
  kind: 'single',
  description:
    'Tunggu Bollinger menyempit (volatilitas di 20% terbawah), lalu ikut arah tembusan band. Keluar saat harga kembali ke garis tengah.',
  grid: [
    { period: 20, k: 2 },
    { period: 48, k: 2 },
  ],
  label: (p) => `Squeeze BB${p.period}`,
  signal(s, p) {
    const mid = sma(s.c, p.period);
    const sd = rollingStd(s.c, p.period);
    const n = s.c.length;
    const bw = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) bw[i] = (2 * p.k * sd[i]) / mid[i];
    const look = p.period * 6;
    const out = new Float64Array(n);
    let state = 0;
    let armed = 0; // sisa bar setelah squeeze terdeteksi
    for (let i = look; i < n; i++) {
      let below = 0;
      let valid = 0;
      for (let j = i - look; j < i; j++) {
        if (!Number.isNaN(bw[j])) {
          valid++;
          if (bw[j] < bw[i]) below++;
        }
      }
      if (valid > 0 && below / valid < 0.2) armed = p.period;
      else if (armed > 0) armed--;
      const up = mid[i] + p.k * sd[i];
      const dn = mid[i] - p.k * sd[i];
      const c = s.c[i];
      if (state === 0 && armed > 0) {
        if (c > up) state = 1;
        else if (c < dn) state = -1;
      } else if (state === 1 && c < mid[i]) state = 0;
      else if (state === -1 && c > mid[i]) state = 0;
      out[i] = state;
    }
    return out;
  },
};

const rsiRevert: SingleStrategy = {
  id: 'rsi-revert',
  name: 'RSI Snapback',
  family: 'reversion',
  kind: 'single',
  description: 'Lawan arah saat RSI ekstrem (panic sell / FOMO), tutup saat RSI kembali ke 50. Untung di pasar sideways, rawan di tren kuat.',
  grid: [
    { period: 14, lo: 25, hi: 75 },
    { period: 14, lo: 30, hi: 70 },
    { period: 7, lo: 20, hi: 80 },
  ],
  label: (p) => `RSI${p.period} ${p.lo}/${p.hi}`,
  signal(s, p) {
    const r = rsi(s.c, p.period);
    const out = new Float64Array(s.c.length);
    let state = 0;
    for (let i = p.period + 1; i < s.c.length; i++) {
      if (r[i] < p.lo) state = 1;
      else if (r[i] > p.hi) state = -1;
      else if (state === 1 && r[i] > 50) state = 0;
      else if (state === -1 && r[i] < 50) state = 0;
      out[i] = state;
    }
    return out;
  },
};

const tsMomentum: SingleStrategy = {
  id: 'ts-momentum',
  name: 'Time-Series Momentum',
  family: 'momentum',
  kind: 'single',
  description: 'Long jika return N bar terakhir positif, short jika negatif. Dievaluasi ulang tiap 24 bar. Efek momentum 1–4 minggu di kripto terdokumentasi di riset akademik.',
  grid: [
    { lookback: 72, every: 24 },
    { lookback: 168, every: 24 },
    { lookback: 336, every: 24 },
  ],
  label: (p) => `TSMOM ${p.lookback}`,
  signal(s, p) {
    const out = new Float64Array(s.c.length);
    let state = 0;
    for (let i = p.lookback; i < s.c.length; i++) {
      if ((i - p.lookback) % p.every === 0) state = Math.sign(s.c[i] / s.c[i - p.lookback] - 1);
      out[i] = state;
    }
    return out;
  },
};

const xsMomentum: PortfolioStrategy = {
  id: 'xs-momentum',
  name: 'Cross-Sectional Rotation',
  family: 'momentum',
  kind: 'portfolio',
  minCoins: 6,
  description:
    'Tiap Senin, urutkan semua koin berdasarkan return N bar terakhir. Mode momentum: long K terkuat, short K terlemah. Mode reversal: kebalikannya. Netral terhadap arah pasar.',
  grid: [
    { lookback: 168, k: 2, mode: 1 },
    { lookback: 168, k: 3, mode: 1 },
    { lookback: 336, k: 2, mode: 1 },
    { lookback: 336, k: 3, mode: 1 },
    { lookback: 168, k: 2, mode: -1 },
    { lookback: 168, k: 3, mode: -1 },
  ],
  label: (p) => `${p.mode === 1 ? 'XS Momentum' : 'XS Reversal'} ${p.lookback}·K${p.k}`,
  weights(d: Dataset, coins: string[], p: Params) {
    const n = d.t.length;
    const out: Record<string, Float64Array> = {};
    for (const c of coins) out[c] = new Float64Array(n);
    const k = Math.min(p.k, Math.floor(coins.length / 2));
    let current: Record<string, number> = {};
    for (let i = p.lookback; i < n; i++) {
      const rebalance = weekStart(d.t[i]) !== weekStart(d.t[i - 1]);
      if (rebalance) {
        const ranked = coins
          .map((c) => ({ c, r: d.series[c].c[i] / d.series[c].c[i - p.lookback] - 1 }))
          .filter((x) => Number.isFinite(x.r))
          .sort((a, b) => b.r - a.r);
        current = {};
        if (ranked.length >= 2 * k && k > 0) {
          const w = 1 / (2 * k);
          for (const x of ranked.slice(0, k)) current[x.c] = w * p.mode;
          for (const x of ranked.slice(-k)) current[x.c] = -w * p.mode;
        }
      }
      for (const c of coins) out[c][i] = current[c] ?? 0;
    }
    return out;
  },
};

export const STRATEGIES: Strategy[] = [donchian, emaTrend, supertrend, squeeze, rsiRevert, tsMomentum, xsMomentum];

export function getStrategy(id: string): Strategy {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`Strategi tidak dikenal: ${id}`);
  return s;
}

export type { Series };

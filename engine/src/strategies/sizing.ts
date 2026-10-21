import { realizedVol } from '../lib/indicators';
import type { Dataset, Strategy } from './types';
import type { Params } from './types';

export interface SizingOptions {
  targetVol: number;
  maxLeverage: number;
  barsPerYear: number;
  volWindow?: number;
  // Hysteresis: posisi hanya diubah bila selisih > band x posisi sekarang (atau arah berubah).
  band?: number;
}

function hysteresis(raw: Float64Array, band: number): Float64Array {
  const out = new Float64Array(raw.length);
  let prev = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r === 0 || prev === 0 || Math.sign(r) !== Math.sign(prev) || Math.abs(r - prev) > band * Math.abs(prev)) prev = r;
    out[i] = prev;
  }
  return out;
}

// Ubah sinyal arah menjadi leverage per bar dengan volatility targeting.
export function sizeSignal(signal: Float64Array, closes: Float64Array, o: SizingOptions): Float64Array {
  const vol = realizedVol(closes, o.volWindow ?? 168, o.barsPerYear);
  const raw = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const v = vol[i];
    if (!signal[i] || !Number.isFinite(v) || v <= 0) continue;
    raw[i] = signal[i] * Math.min(o.maxLeverage, o.targetVol / v);
  }
  return hysteresis(raw, o.band ?? 0.25);
}

// Bobot portofolio (gross <= 1) -> leverage per koin. Boost sqrt(n) mengkompensasi diversifikasi,
// lalu total gross dipotong ke maxLeverage.
export function sizePortfolio(
  weights: Record<string, Float64Array>,
  d: Dataset,
  o: SizingOptions,
): Record<string, Float64Array> {
  const coins = Object.keys(weights);
  const n = d.t.length;
  const vols: Record<string, Float64Array> = {};
  for (const c of coins) vols[c] = realizedVol(d.series[c].c, o.volWindow ?? 168, o.barsPerYear);
  const raw: Record<string, Float64Array> = {};
  for (const c of coins) raw[c] = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let active = 0;
    for (const c of coins) if (weights[c][i]) active++;
    if (!active) continue;
    const boost = Math.sqrt(active);
    let gross = 0;
    for (const c of coins) {
      const w = weights[c][i];
      const v = vols[c][i];
      if (!w || !Number.isFinite(v) || v <= 0) continue;
      raw[c][i] = w * boost * Math.min(o.maxLeverage, o.targetVol / v);
      gross += Math.abs(raw[c][i]);
    }
    if (gross > o.maxLeverage) {
      const k = o.maxLeverage / gross;
      for (const c of coins) raw[c][i] *= k;
    }
  }
  const out: Record<string, Float64Array> = {};
  for (const c of coins) out[c] = hysteresis(raw[c], o.band ?? 0.25);
  return out;
}

// Posisi (leverage per koin per bar) untuk satu kombinasi strategi + parameter + universe.
export function strategyPositions(
  s: Strategy,
  p: Params,
  d: Dataset,
  universe: string[],
  o: SizingOptions,
): Record<string, Float64Array> {
  if (s.kind === 'single') {
    const coin = universe[0];
    const series = d.series[coin];
    return { [coin]: sizeSignal(s.signal(series, p), series.c, o) };
  }
  return sizePortfolio(s.weights(d, universe, p), d, o);
}

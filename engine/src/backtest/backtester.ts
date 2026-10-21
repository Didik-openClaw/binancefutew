import { WEEK, weekStart } from '../lib/time';
import type { Dataset } from '../strategies/types';

export interface CostModel {
  feeRate: number; // taker fee per sisi, mis. 0.0005
  slippage: number; // perkiraan slippage per sisi
  // Funding per bar per koin (positif = long membayar short). Opsional.
  funding?: Record<string, Float64Array>;
}

export interface BacktestResult {
  equity: Float64Array; // ekuitas relatif, mulai 1
  entries: Uint8Array; // 1 jika bar ini membuka/membalik posisi
  traded: Float64Array; // perubahan leverage (turnover) per bar
  exposure: number; // rata-rata gross leverage
  turnover: number; // total perubahan leverage
  liquidated: boolean;
}

// Posisi pos[c][i] diputuskan pada close bar i dan menghasilkan return dari close i ke close i+1.
export function backtest(d: Dataset, positions: Record<string, Float64Array>, cost: CostModel): BacktestResult {
  const n = d.t.length;
  const coins = Object.keys(positions);
  const equity = new Float64Array(n);
  const entries = new Uint8Array(n);
  const tradedBars = new Float64Array(n);
  const perSide = cost.feeRate + cost.slippage;
  let eq = 1;
  let gross = 0;
  let turnover = 0;
  let liquidated = false;
  equity[0] = 1;
  for (let i = 1; i < n; i++) {
    if (liquidated) {
      equity[i] = 0;
      continue;
    }
    let pnl = 0;
    for (const c of coins) {
      const pos = positions[c][i - 1];
      if (!pos) continue;
      const closes = d.series[c].c;
      pnl += pos * (closes[i] / closes[i - 1] - 1);
      const f = cost.funding?.[c]?.[i];
      if (f) pnl -= pos * f;
    }
    eq *= 1 + pnl;
    let traded = 0;
    for (const c of coins) {
      const prev = positions[c][i - 1];
      const cur = positions[c][i];
      const delta = Math.abs(cur - prev);
      if (delta) {
        traded += delta;
        if (cur !== 0 && (prev === 0 || Math.sign(cur) !== Math.sign(prev))) entries[i] = 1;
      }
      gross += Math.abs(cur);
    }
    eq -= eq * traded * perSide;
    turnover += traded;
    tradedBars[i] = traded;
    if (eq <= 0) {
      eq = 0;
      liquidated = true;
    }
    equity[i] = eq;
  }
  return { equity, entries, traded: tradedBars, exposure: gross / Math.max(1, n - 1), turnover, liquidated };
}

export interface WeekSlice {
  start: number;
  first: number; // indeks bar pertama
  last: number; // indeks bar terakhir
  complete: boolean;
}

export function weekSlices(t: number[], barMs: number): WeekSlice[] {
  const out: WeekSlice[] = [];
  for (let i = 0; i < t.length; i++) {
    const ws = weekStart(t[i]);
    const cur = out[out.length - 1];
    if (!cur || cur.start !== ws) out.push({ start: ws, first: i, last: i, complete: false });
    else cur.last = i;
  }
  for (const w of out) w.complete = t[w.last] + barMs >= w.start + WEEK && t[w.first] === w.start;
  return out;
}

// Return per minggu: ekuitas di bar terakhir minggu k dibanding bar terakhir minggu k-1.
export function weeklyReturns(equity: Float64Array, weeks: WeekSlice[]): number[] {
  return weeks.map((w, k) => {
    const base = k === 0 ? equity[w.first] : equity[weeks[k - 1].last];
    return base > 0 ? equity[w.last] / base - 1 : 0;
  });
}

export function weeklySum(xs: ArrayLike<number>, weeks: WeekSlice[]): number[] {
  return weeks.map((w) => {
    let n = 0;
    for (let i = w.first; i <= w.last; i++) n += xs[i];
    return n;
  });
}

export const weeklyEntries = (entries: Uint8Array, weeks: WeekSlice[]) => weeklySum(entries, weeks);

// Return harian (hari UTC) per minggu: daily[k] = return tiap hari dalam minggu k.
export function dailyByWeek(equity: Float64Array, t: number[], weeks: WeekSlice[]): number[][] {
  const DAY = 86_400_000;
  return weeks.map((w, k) => {
    const out: number[] = [];
    let base = k === 0 ? equity[w.first] : equity[weeks[k - 1].last];
    for (let i = w.first; i <= w.last; i++) {
      const lastOfDay = i === w.last || Math.floor(t[i + 1] / DAY) !== Math.floor(t[i] / DAY);
      if (lastOfDay) {
        out.push(base > 0 ? equity[i] / base - 1 : 0);
        base = equity[i];
      }
    }
    return out;
  });
}

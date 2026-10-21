import type { Candle } from '../../../shared/types';
import { intervalMs } from '../lib/time';
import type { Dataset, Series } from '../strategies/types';

// Sejajarkan candle beberapa koin ke satu indeks waktu. Koin dengan cakupan < minCoverage dibuang;
// bar yang hilang diisi close sebelumnya (forward fill).
export function buildDataset(
  raw: Record<string, Candle[]>,
  interval: string,
  opts: { synthetic?: boolean; minCoverage?: number; benchmark?: string } = {},
): Dataset {
  const barMs = intervalMs(interval);
  const coins = Object.keys(raw).filter((c) => raw[c].length > 0);
  if (!coins.length) throw new Error('Dataset kosong');
  const anchor = opts.benchmark && raw[opts.benchmark]?.length ? opts.benchmark : coins[0];
  const end = Math.max(...coins.map((c) => raw[c][raw[c].length - 1].t));
  const start = raw[anchor][0].t;
  const t: number[] = [];
  for (let x = start; x <= end; x += barMs) t.push(x);
  const minCoverage = opts.minCoverage ?? 0.97;
  const series: Record<string, Series> = {};
  const kept: string[] = [];
  for (const c of coins) {
    const byT = new Map(raw[c].map((k) => [k.t, k]));
    let hits = 0;
    for (const x of t) if (byT.has(x)) hits++;
    if (hits / t.length < minCoverage) continue;
    const n = t.length;
    const s: Series = {
      t,
      o: new Float64Array(n),
      h: new Float64Array(n),
      l: new Float64Array(n),
      c: new Float64Array(n),
      v: new Float64Array(n),
    };
    let last: Candle | undefined = raw[c].find((k) => k.t >= start);
    for (let i = 0; i < n; i++) {
      const k = byT.get(t[i]);
      if (k) last = k;
      const src = k ?? last!;
      const flat = !k;
      s.o[i] = flat ? src.c : src.o;
      s.h[i] = flat ? src.c : src.h;
      s.l[i] = flat ? src.c : src.l;
      s.c[i] = src.c;
      s.v[i] = flat ? 0 : src.v;
    }
    series[c] = s;
    kept.push(c);
  }
  return {
    interval,
    barsPerYear: (365 * 86_400_000) / barMs,
    t,
    coins: kept,
    series,
    synthetic: opts.synthetic ?? false,
  };
}

// Ambil N bar terakhir (untuk sinyal live).
export function tailDataset(d: Dataset, bars: number): Dataset {
  const from = Math.max(0, d.t.length - bars);
  const t = d.t.slice(from);
  const series: Record<string, Series> = {};
  for (const c of d.coins) {
    const s = d.series[c];
    series[c] = { t, o: s.o.slice(from), h: s.h.slice(from), l: s.l.slice(from), c: s.c.slice(from), v: s.v.slice(from) };
  }
  return { ...d, t, series };
}

import { describe, expect, it } from 'vitest';
import { backtest, weekSlices, weeklyReturns } from '../src/backtest/backtester';
import { compound, maxDrawdownFromReturns } from '../src/backtest/metrics';
import { buildCandidates, type Candidate, GATES, RULES, runTournament, selectPicks } from '../src/backtest/tournament';
import { dsr, expectedMaxSharpe, normCdf, normInv, psr } from '../src/backtest/stats';
import { gaussian, mulberry32 } from '../src/lib/rng';
import { STRATEGIES as ALL } from '../src/strategies/catalog';
import { buildDataset } from '../src/data/dataset';
import { syntheticCandles } from '../src/demo/synthetic';
import { atr, ema, priorMax, priorMin, rsi } from '../src/lib/indicators';
import { HOUR, weekStart, WEEK } from '../src/lib/time';
import { RISK_PROFILES } from '../src/risk/profiles';
import { STRATEGIES } from '../src/strategies/catalog';
import { strategyPositions } from '../src/strategies/sizing';
import type { Dataset } from '../src/strategies/types';

const END = Date.UTC(2026, 9, 19, 23); // Senin 19 Okt 2026, 23:00 UTC

function dataset(weeks = 20, seed = 3): Dataset {
  return buildDataset(syntheticCandles({ seed, bars: weeks * 168, endTime: END }), '1h', { synthetic: true, benchmark: 'BTC' });
}

describe('indikator', () => {
  it('priorMax/priorMin = max/min jendela sebelumnya (brute force)', () => {
    const xs = Array.from({ length: 300 }, (_, i) => Math.sin(i / 7) * 10 + ((i * 37) % 11));
    const hi = priorMax(xs, 20);
    const lo = priorMin(xs, 20);
    for (let i = 20; i < xs.length; i++) {
      const w = xs.slice(i - 20, i);
      expect(hi[i]).toBe(Math.max(...w));
      expect(lo[i]).toBe(Math.min(...w));
    }
    expect(Number.isNaN(hi[19])).toBe(true);
  });

  it('ema, rsi, atr dalam rentang wajar', () => {
    const d = dataset(4);
    const s = d.series.BTC;
    const r = rsi(s.c, 14);
    for (let i = 15; i < r.length; i++) expect(r[i]).toBeGreaterThanOrEqual(0), expect(r[i]).toBeLessThanOrEqual(100);
    const a = atr(s.h, s.l, s.c, 14);
    for (let i = 14; i < a.length; i++) expect(a[i]).toBeGreaterThan(0);
    const e = ema([1, 1, 1, 1], 3);
    expect([...e]).toEqual([1, 1, 1, 1]);
  });
});

describe('tanpa lookahead', () => {
  // Mengubah data masa depan tidak boleh mengubah posisi yang sudah diputuskan.
  it.each(STRATEGIES.map((s) => [s.id, s] as const))('%s', (_id, s) => {
    const d = dataset(12);
    const cut = d.t.length - 200;
    const future: Dataset = structuredClone(d);
    for (const c of future.coins) {
      const ser = future.series[c];
      for (let i = cut + 1; i < ser.c.length; i++) {
        ser.c[i] *= 1.5;
        ser.h[i] *= 1.6;
        ser.l[i] *= 1.4;
        ser.o[i] *= 1.5;
      }
    }
    const opts = { targetVol: 0.9, maxLeverage: 4, barsPerYear: d.barsPerYear };
    for (const p of s.grid) {
      const universe = s.kind === 'single' ? ['ETH'] : d.coins;
      const a = strategyPositions(s, p, d, universe, opts);
      const b = strategyPositions(s, p, future, universe, opts);
      for (const c of Object.keys(a)) for (let i = 0; i <= cut; i++) expect(b[c][i]).toBe(a[c][i]);
    }
  });
});

describe('backtester', () => {
  it('posisi bar t mendapat return bar t+1, dikurangi biaya saat berubah', () => {
    const d = dataset(2);
    const n = d.t.length;
    const pos = new Float64Array(n).fill(1);
    pos[0] = 0;
    const bt = backtest(d, { BTC: pos }, { feeRate: 0.001, slippage: 0 });
    const c = d.series.BTC.c;
    // Masuk di close bar 1 (biaya 0.1%), lalu ikut harga sampai akhir.
    const expected = (1 - 0.001) * (c[n - 1] / c[1]);
    expect(bt.equity[n - 1]).toBeCloseTo(expected, 10);
    expect(bt.entries[1]).toBe(1);
  });

  it('likuidasi menghentikan kurva di nol', () => {
    const d = dataset(2);
    const pos = new Float64Array(d.t.length).fill(-1e6);
    const bt = backtest(d, { BTC: pos }, { feeRate: 0, slippage: 0 });
    expect(bt.liquidated).toBe(true);
    expect(bt.equity[d.t.length - 1]).toBe(0);
  });

  it('minggu dimulai Senin 00:00 UTC', () => {
    const mon = Date.UTC(2026, 9, 19);
    expect(weekStart(mon)).toBe(mon);
    expect(weekStart(mon - 1)).toBe(mon - WEEK);
    expect(new Date(weekStart(Date.UTC(2026, 9, 22, 13))).getUTCDay()).toBe(1);
  });

  it('return mingguan menyusun total return', () => {
    const d = dataset(5);
    const pos = new Float64Array(d.t.length).fill(0.5);
    const bt = backtest(d, { ETH: pos }, { feeRate: 0, slippage: 0 });
    const weeks = weekSlices(d.t, HOUR);
    const wr = weeklyReturns(bt.equity, weeks);
    expect(compound(wr) + 1).toBeCloseTo(bt.equity[d.t.length - 1] / bt.equity[0], 9);
  });

  it('max drawdown', () => {
    expect(maxDrawdownFromReturns([0.1, -0.5, 0.2])).toBeCloseTo(0.5);
  });
});

describe('turnamen mingguan', () => {
  const d = dataset(24, 11);
  const opts = {
    profile: RISK_PROFILES.bold,
    lookbackWeeks: 8,
    walkForwardWeeks: 10,
    benchmark: 'BTC',
    cost: { feeRate: 0.00045, slippage: 0.0003 },
  };

  it('pemilihan minggu k tidak melihat return minggu k', () => {
    const { candidates } = buildCandidates(d, opts);
    const k = 15;
    const rule = RULES.find((r) => r.id === 'L8-H4')!;
    const before = selectPicks(candidates, k, rule, opts);
    const tampered = candidates.map((c) => ({
      ...c,
      weekly: c.weekly.map((r, i) => (i >= k ? r + (c.id.length % 7) * 0.5 : r)),
      daily: c.daily.map((w, i) => (i >= k ? w.map((x) => x + 0.3) : w)),
    }));
    const after = selectPicks(tampered, k, rule, opts);
    expect(after.picks.map((p) => p.candidate.id)).toEqual(before.picks.map((p) => p.candidate.id));
    expect(after.level).toBe(before.level);
  });

  it('seluruh pipeline (gerbang + pilihan aturan bersarang) tidak melihat masa depan', () => {
    const base = runTournament(d, opts, END);
    const cutWeek = base.report.policy.weeks[base.report.policy.weeks.length - 3].weekStart;
    const future: Dataset = structuredClone(d);
    const cut = future.t.findIndex((t) => t >= cutWeek);
    for (const c of future.coins) for (let i = cut; i < future.t.length; i++) future.series[c].c[i] *= 1 + 0.2 * Math.sin(i);
    const changed = runTournament(future, opts, END);
    const early = (r: typeof base) => r.report.policy.weeks.filter((w) => w.weekStart < cutWeek).map((w) => [w.pickedId, w.rule, w.level, w.ret.toFixed(10)]);
    expect(early(changed)).toEqual(early(base));
  });

  it('menghasilkan pilihan dengan bobot total 1 dan laporan walk-forward', () => {
    const run = runTournament(d, opts, END);
    expect(run.picks.length).toBeGreaterThan(0);
    expect(run.picks.length).toBeLessThanOrEqual(RISK_PROFILES.bold.strategySlots);
    expect(run.picks.reduce((a, p) => a + p.weight, 0)).toBeCloseTo(1);
    expect(new Set(run.picks.map((p) => p.candidate.diversityKey)).size).toBe(run.picks.length);
    expect(run.report.policy.weeks.length).toBe(10);
    const e = run.report.entries;
    for (let i = 1; i < e.length; i++) {
      // Yang lolos saringan selalu di atas; di dalam kelompok yang sama urut skor.
      expect(Number(e[i - 1].gate.passed)).toBeGreaterThanOrEqual(Number(e[i].gate.passed));
      if (e[i - 1].gate.passed === e[i].gate.passed) expect(e[i - 1].score).toBeGreaterThanOrEqual(e[i].score);
    }
    expect(run.report.rules.filter((r) => r.chosen).length).toBe(1);
    const q = run.report.qualification;
    expect(q.funnel[0].remaining).toBe(q.tested);
    for (let i = 1; i < q.funnel.length; i++) expect(q.funnel[i].remaining).toBeLessThanOrEqual(q.funnel[i - 1].remaining);
    expect(q.qualified).toBe(e.filter((x) => x.gate.passed).length);
    // Minggu yang sedang berjalan (belum lengkap) tidak ikut dinilai.
    expect(run.report.policy.weeks.every((w) => w.weekStart < weekStart(END))).toBe(true);
  });

  it('profil ekstrem lebih terkonsentrasi daripada seimbang', () => {
    const bold = runTournament(d, { ...opts, profile: RISK_PROFILES.extreme }, END);
    const calm = runTournament(d, { ...opts, profile: RISK_PROFILES.balanced }, END);
    expect(bold.picks.length).toBe(1);
    expect(calm.picks.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...bold.picks.map((p) => p.weight))).toBeGreaterThanOrEqual(Math.max(...calm.picks.map((p) => p.weight)));
  });
});

describe('statistik', () => {
  it('distribusi normal', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normInv(0.01)).toBeCloseTo(-2.326348, 5);
  });

  it('PSR/DSR: edge nyata lolos, noise tidak, DSR lebih ketat dari PSR', () => {
    const z = gaussian(mulberry32(42));
    const edge = Array.from({ length: 90 }, () => 0.006 + 0.01 * z());
    const noise = Array.from({ length: 90 }, () => 0.02 * z());
    expect(psr(edge)).toBeGreaterThan(0.99);
    expect(psr(noise)).toBeLessThan(0.95);
    expect(dsr(edge, 200, 0.01)).toBeLessThanOrEqual(psr(edge));
    expect(expectedMaxSharpe(1000, 0.01)).toBeGreaterThan(expectedMaxSharpe(10, 0.01));
  });
});

describe('saringan kualifikasi', () => {
  const opts = { profile: RISK_PROFILES.bold, lookbackWeeks: 12, walkForwardWeeks: 4, benchmark: 'BTC', cost: { feeRate: 0.0005, slippage: 0.0003 } };
  const rule = RULES.find((r) => r.id === 'L12-H4')!;
  const fake = (id: string, mu: number, sd: number, seed: number): Candidate => {
    const z = gaussian(mulberry32(seed));
    const daily = Array.from({ length: 16 }, () => Array.from({ length: 7 }, () => mu + sd * z()));
    return {
      id,
      strategy: ALL[0],
      params: {},
      universe: [id],
      label: id,
      diversityKey: id,
      familyKey: id,
      daily,
      weekly: daily.map((w) => w.reduce((a, r) => a * (1 + r), 1) - 1),
      weeklyEntries: daily.map(() => 2),
      weeklyTurnover: daily.map(() => 1),
      exposure: 1,
    };
  };

  it('kandidat dengan edge nyata lolos saringan Ketat di antara 80 kandidat noise', () => {
    const cands = [...Array.from({ length: 80 }, (_, i) => fake(`noise${i}`, 0, 0.02, i + 1)), fake('edge', 0.006, 0.01, 999)];
    const sel = selectPicks(cands, 16, rule, opts);
    expect(sel.level).toBe(0);
    expect(sel.picks[0].candidate.id).toBe('edge');
  });

  it('tanpa edge, saringan dilonggarkan bertahap dan tetap menemukan juara', () => {
    const cands = Array.from({ length: 80 }, (_, i) => fake(`noise${i}`, 0, 0.02, i + 1));
    const sel = selectPicks(cands, 16, rule, opts);
    expect(sel.level).toBeGreaterThan(0);
    expect(sel.picks.length).toBeGreaterThan(0);
    expect(GATES[sel.level].label).not.toBe('Ketat');
  });
});
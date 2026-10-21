import { describe, expect, it } from 'vitest';
import { backtest, weekSlices, weeklyReturns } from '../src/backtest/backtester';
import { compound, maxDrawdownFromReturns } from '../src/backtest/metrics';
import { runTournament, selectPicks, buildCandidates } from '../src/backtest/tournament';
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
    const before = selectPicks(candidates, k, opts).map((p) => p.candidate.id);
    const tampered = candidates.map((c) => ({ ...c, weekly: c.weekly.map((r, i) => (i >= k ? r + (c.id.length % 7) * 0.5 : r)) }));
    const after = selectPicks(tampered, k, opts).map((p) => p.candidate.id);
    expect(after).toEqual(before);
  });

  it('menghasilkan pilihan dengan bobot total 1 dan laporan walk-forward', () => {
    const run = runTournament(d, opts, END);
    expect(run.picks.length).toBeGreaterThan(0);
    expect(run.picks.length).toBeLessThanOrEqual(RISK_PROFILES.bold.strategySlots);
    expect(run.picks.reduce((a, p) => a + p.weight, 0)).toBeCloseTo(1);
    expect(new Set(run.picks.map((p) => p.candidate.diversityKey)).size).toBe(run.picks.length);
    expect(run.report.policy.weeks.length).toBe(10);
    expect(run.report.entries[0].score).toBeGreaterThanOrEqual(run.report.entries[1].score);
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

import { describe, expect, it } from 'vitest';
import { auditLedger, replayCopy, type ReplayInputs } from '../src/backtest/copyReplay';
import type { Candle } from '../../shared/types';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);

function candles(prices: number[]): Candle[] {
  return prices.map((p, i) => ({ t: T0 + i * H, o: i ? prices[i - 1] : p, h: p, l: p, c: p, v: 1 }));
}
const fill = (t: number, side: 'A' | 'B', start: number, sz: number, px: number, closedPnl = 0) => ({
  coin: 'BTC', px: String(px), sz: String(sz), side, time: t, dir: side === 'B' ? 'Open Long' : 'Close Long', startPosition: String(start), closedPnl: String(closedPnl), fee: '0', oid: 1, hash: '',
});
const opts = { startEquity: 1000, copyMultiplier: 1.5, maxPositionLeverage: 4, maxGrossLeverage: 6, feeRate: 0.00045, slippage: 0.0003, latencyPenalty: 0.0005, minOrderUsd: 12, band: 0.15, killSwitch: 0.25, entryPolicy: 'mirror' as const };

describe('replay copy trading', () => {
  it('menyalin proporsi leader dan ekuitas akhir cocok dengan audit ledger', () => {
    const prices = [100, 100, 104, 108, 110, 110, 110];
    const inp: ReplayInputs = {
      leader: '0xabc',
      from: T0,
      to: T0 + 6 * H,
      fills: [fill(T0 + 1 * H + 60_000, 'B', 0, 1, 100), fill(T0 + 4 * H + 60_000, 'A', 1, 1, 110, 10)],
      leaderEquity: [[T0, 1000]],
      openAtEnd: {},
      candles: { BTC: candles(prices) },
      funding: {},
    };
    const r = replayCopy(inp, opts);
    expect(r.trades.length).toBe(2);
    // Leader 0.1x -> follower 0.1 x 1.5 = 0.15x dari $1000 = $150 notional.
    expect(r.trades[0].notional).toBeCloseTo(150, 0);
    const audit = auditLedger(1000, r.trades, { BTC: 110 });
    expect(audit.equity).toBeCloseTo(r.stats.endEquity, 8);
    expect(Object.keys(audit.positions)).toEqual([]);
    // Untung ~1.5 x 10 dikurangi slippage, keterlambatan & fee.
    expect(r.stats.totalReturn).toBeGreaterThan(0.012);
    expect(r.stats.totalReturn).toBeLessThan(0.015);
  });

  it('posisi leader yang sudah terbuka diikuti sejak awal (mirror) atau dilewati (new-only)', () => {
    const inp: ReplayInputs = {
      leader: '0xabc',
      from: T0,
      to: T0 + 3 * H,
      fills: [],
      leaderEquity: [[T0, 1000]],
      openAtEnd: { BTC: 2 },
      candles: { BTC: candles([100, 100, 90, 90]) },
      funding: {},
    };
    expect(replayCopy(inp, opts).trades.length).toBe(1);
    expect(replayCopy(inp, { ...opts, entryPolicy: 'new-only' }).trades.length).toBe(0);
  });

  it('kill switch menutup semua posisi saat rugi siklus >= 25%', () => {
    const prices = [100, 100, 95, 85, 75, 70, 65];
    const inp: ReplayInputs = {
      leader: '0xabc',
      from: T0,
      to: T0 + 6 * H,
      fills: [fill(T0 + 1 * H, 'B', 0, 30, 100)], // leader 3x -> follower 4.5x, dibatasi 4x
      leaderEquity: [[T0, 1000]],
      openAtEnd: {},
      candles: { BTC: candles(prices) },
      funding: {},
    };
    const r = replayCopy(inp, opts);
    expect(r.trades[0].notional).toBeLessThanOrEqual(4000 * 1.001);
    expect(r.stats.killSwitchHits).toBe(1);
    expect(r.trades[r.trades.length - 1].reason).toBe('kill switch');
    // Setelah kill switch tidak ada posisi: ekuitas datar.
    const tail = r.equity.slice(-2).map((p) => p.equity);
    expect(tail[0]).toBeCloseTo(tail[1], 8);
  });

  it('funding long dibayar per jam', () => {
    const inp: ReplayInputs = {
      leader: '0xabc',
      from: T0,
      to: T0 + 3 * H,
      fills: [],
      leaderEquity: [[T0, 1000]],
      openAtEnd: { BTC: 5 },
      candles: { BTC: candles([100, 100, 100, 100]) },
      funding: { BTC: [{ t: T0 + H + 1, rate: 0.001 }] },
    };
    const r = replayCopy(inp, opts);
    // Follower 0.5 x 1.5 = 0.75x -> $750 notional x 0.1% = $0.75 funding.
    expect(r.stats.funding).toBeCloseTo(0.75, 1);
  });
});

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

describe('arus dana akun unified', () => {
  it('menghitung deposit, penarikan, kiriman stablecoin, dan belanja spot; mengabaikan token non-stable & pindah antar-dex', async () => {
    const { stableFlows } = await import('../src/data/hyperliquidInfo');
    const me = '0xMe';
    const u = (time: number, delta: Record<string, unknown>) => ({ time, hash: String(time), delta: delta as { type: string } });
    const flows = stableFlows(
      me,
      [
        u(1, { type: 'deposit', usdc: '500' }),
        u(2, { type: 'withdraw', usdc: '99', fee: '1' }),
        u(3, { type: 'send', user: '0xme', destination: '0x2000000000000000000000000000000000000000', token: 'USDC', amount: '200', fee: '0' }),
        u(4, { type: 'spotTransfer', user: '0xother', destination: '0xme', token: 'USDC', amount: '50', fee: '0' }),
        u(5, { type: 'spotTransfer', user: '0xother', destination: '0xme', token: 'HYPE', amount: '10', fee: '0' }),
        u(6, { type: 'send', user: '0xme', destination: '0xme', token: 'USDC', amount: '70', fee: '0' }),
        u(7, { type: 'accountClassTransfer', usdc: '1000', toPerp: true }),
      ],
      [{ coin: '@107', px: '40', sz: '2', side: 'B', time: 8, dir: 'Buy', closedPnl: '0', fee: '0.01', feeToken: 'HYPE', oid: 1, hash: '' }],
    );
    expect(flows).toEqual([
      [1, 500],
      [2, -100],
      [3, -200],
      [4, 50],
      [8, -80],
    ]);
  });
});

describe('uji salin historis', () => {
  const W = 168;
  const weeks = 12;
  // Tiap minggu harga naik 100 -> 102 lalu kembali; leader beli di jam 1, jual di jam 83.
  const prices = Array.from({ length: weeks * W + 1 }, (_, i) => {
    const h = i % W;
    return h <= 84 ? 100 + (2 * h) / 84 : 102 - (2 * (h - 84)) / 84;
  });
  const swing = (fromWeek: number) =>
    Array.from({ length: weeks - fromWeek }, (_, k) => {
      const w = (fromWeek + k) * W * H;
      return [fill(T0 + w + 1 * H, 'B', 0, 1, prices[(fromWeek + k) * W + 1]), fill(T0 + w + 83 * H, 'A', 1, 1, prices[(fromWeek + k) * W + 83])];
    }).flat();
  const inputs = (address: string, fromWeek: number): ReplayInputs => ({
    leader: address,
    from: T0,
    to: T0 + weeks * W * H,
    fills: swing(fromWeek),
    leaderEquity: [[T0, 1000]],
    openAtEnd: {},
    candles: { BTC: candles(prices) },
    funding: {},
  });
  const view = (address: string, score: number) => ({
    address, label: address, accountValue: 1000, weekRoi: 0.1, monthRoi: 0.2, allTimePnl: 0, winRate: 1, maxDrawdown: 0.1, fillsPerDay: 1, holdHours: 80, scalpShare: 0, positiveDays: 0.6, score, weight: 0.5, status: 'copying' as const, openPositions: 0,
  });

  it('lolos bila konsisten berminggu-minggu; trader yang baru aktif ditolak walau skor scout lebih tinggi', async () => {
    const { vetLeaders, VET_DEFAULTS } = await import('../src/scout/vet');
    const o = { ...VET_DEFAULTS, days: weeks * 7, replay: opts };
    const data: Record<string, ReplayInputs> = { '0xsteady': inputs('0xsteady', 0), '0xnew': inputs('0xnew', weeks - 2) };
    const r = await vetLeaders([view('0xnew', 0.9), view('0xsteady', 0.5)], o, async (a) => data[a], 1, 0.5);
    const steady = r.leaders.find((l) => l.address === '0xsteady')!;
    const fresh = r.leaders.find((l) => l.address === '0xnew')!;
    expect(steady.vet?.pass).toBe(true);
    expect(steady.vet?.weeksUp).toBe(weeks);
    expect(steady.status).toBe('copying');
    expect(steady.weight).toBe(1);
    expect(fresh.status).toBe('rejected');
    expect(fresh.reason).toMatch(/aktif hanya 2 dari 12 minggu/);
    expect(r.leaders[0].address).toBe('0xsteady');
    expect(r.passed).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { capTargets, computeTargets, planOrders } from '../src/copy/mirror';
import { Engine } from '../src/copy/engine';
import { loadConfig } from '../src/config';
import { fromBinanceSymbol, toBinanceSymbol } from '../src/data/symbols';
import { DemoWorld } from '../src/demo/world';
import { PaperBroker } from '../src/exchanges/paper';
import type { PriceFeed } from '../src/exchanges/types';
import { HOUR, WEEK, weekStart } from '../src/lib/time';
import { RISK_PROFILES } from '../src/risk/profiles';
import { RiskManager } from '../src/risk/riskManager';
import { type DeepMetrics, fillMetrics, holdingProfile, parseLeaderboard, portfolioDrawdown, prefilter, rankLeaders, runScout, type ParsedRow } from '../src/scout/hyperliquidScout';
import { Store } from '../src/store';

const plan = { minOrderUsd: 10, band: 0.1, roundQty: (_: string, q: number) => Math.round(q * 1e6) / 1e6, minNotional: () => 10 };

describe('mirror leader', () => {
  it('ukuran = proporsi eksposur leader x modal sleeve x multiplier', () => {
    const t = computeTargets({
      equity: 10_000,
      allocation: { strategy: 0.5, copy: 0.5 },
      copyMultiplier: 1.5,
      leaders: [
        // Leader $1M dengan long BTC $2M (2x) dan short ETH $500k (0.5x).
        { snapshot: { id: 'A', equity: 1_000_000, ts: 0, positions: { BTC: { size: 20, px: 100_000 }, ETH: { size: -125, px: 4000 } } }, weight: 1 },
      ],
      strategyLeverage: { BTC: 1 },
      supports: () => true,
    });
    // copy: 2 x 5000 x 1.5 = 15000; strategi: 1 x 5000 = 5000
    expect(t.notional.BTC).toBeCloseTo(20_000);
    expect(t.notional.ETH).toBeCloseTo(-0.5 * 5000 * 1.5);
    expect(t.sources.BTC).toEqual(['A', 'strategy']);
  });

  it('koin yang tidak ada di venue dilewati; koin baseline dikecualikan', () => {
    const t = computeTargets({
      equity: 1000,
      allocation: { strategy: 0, copy: 1 },
      copyMultiplier: 1,
      leaders: [{ snapshot: { id: 'A', equity: 100, ts: 0, positions: { FOO: { size: 1, px: 50 }, BTC: { size: 0.001, px: 100_000 }, SOL: { size: 1, px: 100 } } }, weight: 1, exclude: new Set(['SOL']) }],
      strategyLeverage: {},
      supports: (c) => c !== 'FOO',
    });
    expect(t.skipped).toEqual(['FOO']);
    expect(Object.keys(t.notional)).toEqual(['BTC']);
  });

  it('cap per koin dan gross', () => {
    const r = capTargets({ BTC: 50_000, ETH: -30_000, SOL: 10_000 }, 10_000, { maxPositionLeverage: 4, maxGrossLeverage: 6 });
    const gross = Object.values(r.notional).reduce((a, v) => a + Math.abs(v), 0);
    expect(gross).toBeCloseTo(60_000);
    expect(r.notional.BTC).toBeCloseTo(40_000 * (60 / 80));
    expect(r.scaled).toBe(true);
  });

  it('flip arah = tutup penuh (reduceOnly) dulu lalu buka arah baru', () => {
    const orders = planOrders({ BTC: -2000 }, { BTC: { size: 0.03, entryPx: 100_000 } }, { BTC: 100_000 }, plan);
    expect(orders).toEqual([
      { coin: 'BTC', side: 'sell', qty: 0.03, reduceOnly: true, refPx: 100_000 },
      { coin: 'BTC', side: 'sell', qty: 0.02, reduceOnly: false, refPx: 100_000 },
    ]);
  });

  it('selisih kecil diabaikan, target nol menutup, pengurangan duluan', () => {
    const orders = planOrders(
      { BTC: 3050, ETH: 0, SOL: 500, XRP: 2000 },
      { BTC: { size: 0.03, entryPx: 1 }, ETH: { size: 1, entryPx: 1 }, SOL: { size: 10, entryPx: 1 } },
      { BTC: 100_000, ETH: 4000, SOL: 100, XRP: 2 },
      plan,
    );
    expect(orders.map((o) => `${o.coin}:${o.side}:${o.reduceOnly}`)).toEqual(['ETH:sell:true', 'SOL:sell:true', 'XRP:buy:false']);
    expect(orders[1].qty).toBeCloseTo(5);
  });
});

describe('kill switch', () => {
  it('terpicu saat rugi minggu >= batas lalu reset Senin berikutnya', () => {
    const t0 = Date.UTC(2026, 9, 19, 1);
    const rm = new RiskManager(RISK_PROFILES.bold, RiskManager.fresh(10_000, t0));
    expect(rm.update(8_000, t0 + HOUR)).toBe('ok');
    expect(rm.update(7_400, t0 + 2 * HOUR)).toBe('halt');
    expect(rm.update(7_500, t0 + 3 * HOUR)).toBe('halted');
    expect(rm.s.haltedUntil).toBe(weekStart(t0) + WEEK);
    expect(rm.update(7_500, weekStart(t0) + WEEK + HOUR)).toBe('ok');
    expect(rm.s.weekStartEquity).toBe(7_500);
  });
});

describe('paper broker', () => {
  const feed = (px: Record<string, number>): PriceFeed => ({ markPrices: async () => px, listCoins: async () => Object.keys(px) });

  it('PnL realisasi, average entry, flip posisi, fee', async () => {
    const prices = { BTC: 100 };
    const b = new PaperBroker('hyperliquid', feed(prices), { startEquity: 1000, feeRate: 0.001, slippage: 0 });
    await b.marketOrder({ coin: 'BTC', side: 'buy', qty: 2, reduceOnly: false, refPx: 100 });
    prices.BTC = 110;
    await b.marketOrder({ coin: 'BTC', side: 'buy', qty: 2, reduceOnly: false, refPx: 110 });
    expect((await b.positions()).BTC.entryPx).toBeCloseTo(105);
    prices.BTC = 120;
    const close = await b.marketOrder({ coin: 'BTC', side: 'sell', qty: 6, reduceOnly: false, refPx: 120 });
    expect(close.realizedPnl).toBeCloseTo(4 * 15);
    const pos = (await b.positions()).BTC;
    expect(pos.size).toBeCloseTo(-2);
    expect(pos.entryPx).toBeCloseTo(120);
    const fees = (2 * 100 + 2 * 110 + 6 * 120) * 0.001;
    expect(await b.equity()).toBeCloseTo(1000 + 60 - fees);
    await expect(b.marketOrder({ coin: 'BTC', side: 'sell', qty: 1, reduceOnly: true, refPx: 120 })).rejects.toThrow();
  });
});

describe('scout Hyperliquid', () => {
  const row = (addr: string, av: number, week: number, month: number, vlm: number) => ({
    ethAddress: addr,
    accountValue: String(av),
    displayName: null,
    windowPerformances: [
      ['day', { pnl: '0', roi: '0', vlm: '0' }],
      ['week', { pnl: String(week * av), roi: String(week), vlm: String(vlm) }],
      ['month', { pnl: String(month * av), roi: String(month), vlm: '0' }],
      ['allTime', { pnl: '1000', roi: '1', vlm: '0' }],
    ] as [string, { pnl: string; roi: string; vlm: string }][],
  });
  const opts = { minAccountValue: 25_000, maxWeeklyTurnover: 200, maxFillsPerDay: 150, maxDrawdown: 0.45, deepDive: 10, slots: 2, concentration: 0.5 };

  it('saringan awal membuang akun kecil, ROI negatif, dan turnover ala market maker', () => {
    const parsed = parseLeaderboard([
      row('0xAAA', 100_000, 0.2, 0.5, 1e6),
      row('0xBBB', 5_000, 0.9, 0.9, 1e5), // akun kecil
      row('0xCCC', 100_000, -0.1, 0.5, 1e6), // minggu rugi
      row('0xDDD', 100_000, 0.1, 0.2, 1e9), // turnover 10.000x
    ]);
    expect(prefilter(parsed, opts).map((r) => r.address)).toEqual(['0xaaa']);
  });

  it('metrik fill & drawdown portofolio', () => {
    const f = (pnl: number) => ({ coin: 'BTC', px: '1', sz: '1', side: 'B' as const, time: 0, dir: 'Close Long', closedPnl: String(pnl), fee: '0', oid: 1, hash: '' });
    const m = fillMetrics([f(100), f(-50), f(30), { ...f(0), dir: 'Open Long' }], 7);
    expect(m.winRate).toBeCloseTo(2 / 3);
    expect(m.profitFactor).toBeCloseTo(130 / 50);
    expect(m.topTradeShare).toBe(1); // 100 dari net 80 -> dibatasi 1
    const dd = portfolioDrawdown([
      ['month', { accountValueHistory: [[0, '1000'], [1, '1200'], [2, '900']], pnlHistory: [[0, '0'], [1, '200'], [2, '-100']], vlm: '0' }],
    ]);
    expect(dd).toBeCloseTo(1 - 900 / 1200);
  });

  it('bobot leader terpilih berjumlah 1, yang ditolak berbobot 0', () => {
    const parsed = parseLeaderboard([row('0x1', 1e5, 0.3, 0.6, 1e6), row('0x2', 1e5, 0.2, 0.3, 1e6), row('0x3', 1e5, 0.1, 0.1, 1e6)]);
    const m = { winRate: 0.6, profitFactor: 2, fillsPerDay: 5, closingTrades: 10, topTradeShare: 0.3, maxDrawdown: 0.1, openPositions: 2, coins: ['BTC'], holdHours: 20, scalpShare: 0.02, positiveDays: 0.6 };
    const v = rankLeaders(
      [
        { row: parsed[0], m },
        { row: parsed[1], m },
        { row: parsed[2], m, reason: 'x' },
      ],
      opts,
    );
    expect(v.filter((l) => l.status === 'copying').reduce((a, l) => a + l.weight, 0)).toBeCloseTo(1);
    expect(v.find((l) => l.address === '0x3')!.weight).toBe(0);
    expect(v[0].address).toBe('0x1');
  });
});

describe('simbol', () => {
  it('Hyperliquid <-> Binance', () => {
    expect(toBinanceSymbol('BTC')).toBe('BTCUSDT');
    expect(toBinanceSymbol('kPEPE')).toBe('1000PEPEUSDT');
    expect(fromBinanceSymbol('1000BONKUSDT')).toBe('kBONK');
    expect(fromBinanceSymbol('1000000MOGUSDT')).toBe('1000000MOG');
    expect(fromBinanceSymbol('BTCUSDC')).toBeNull();
  });
});

describe('engine end-to-end (dunia demo)', () => {
  it('menjalankan seleksi mingguan, menyalin leader, dan mencatat trade', async () => {
    const start = Date.UTC(2026, 9, 12, 0);
    const world = new DemoWorld({ seed: 5, start, historyWeeks: 40, futureWeeks: 2 });
    const cfg = { ...loadConfig({ MODE: 'demo' }), universe: await world.listCoins(), manualLeaders: [] };
    const broker = new PaperBroker('hyperliquid', world, { startEquity: 10_000, feeRate: 0.00045, slippage: 0.0003, clock: world.clock });
    const engine = new Engine({ cfg, broker, store: new Store(null), market: world, clock: world.clock, leaderSource: world.leaderSource, scout: world.scout, synthetic: true });
    await engine.start();
    for (let i = 0; i < 30; i++) {
      await engine.tick();
      world.advance(HOUR);
    }
    const s = engine.snapshot();
    expect(s.playbook?.appliedAt).toBeTruthy();
    expect(s.tournament?.entries.length).toBeGreaterThan(10);
    expect(s.leaders.some((l) => l.status === 'copying')).toBe(true);
    expect(s.trades.length).toBeGreaterThan(0);
    expect(s.account.leverage).toBeLessThanOrEqual(RISK_PROFILES.bold.maxGrossLeverage + 0.5);
    expect(s.equityCurve.length).toBeGreaterThan(20);
    // Statement: ekuitas hasil hitung ulang ledger (trade + funding) sama dengan ekuitas broker.
    await engine.audit(world.clock());
    const st = engine.snapshot().statement!;
    expect(st.reconciled).toBe(true);
    expect(Math.abs(st.diff)).toBeLessThan(0.01);
    expect(st.tradeCount).toBe(s.trades.length);
    expect(engine.snapshot().fundingLog.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('leader bermasalah', () => {
  it('data basi membekukan order; mati > 5x batas -> leader dikeluarkan dengan peringatan', async () => {
    const start = Date.UTC(2026, 9, 12, 0);
    const world = new DemoWorld({ seed: 5, start, historyWeeks: 40, futureWeeks: 2 });
    const cfg = { ...loadConfig({ MODE: 'demo' }), universe: await world.listCoins(), manualLeaders: [], leaderStaleSeconds: 600, allocStrategy: 0 };
    let failing = false;
    const broker = new PaperBroker('hyperliquid', world, { startEquity: 10_000, feeRate: 0.00045, slippage: 0.0003, clock: world.clock });
    const engine = new Engine({
      cfg,
      broker,
      store: new Store(null),
      market: world,
      clock: world.clock,
      leaderSource: (a, l) => {
        const src = world.leaderSource(a, l);
        return { ...src, fetch: () => (failing ? Promise.reject(new Error('timeout')) : src.fetch()) };
      },
      // Paksa satu leader disalin supaya jalur copy teruji.
      scout: async (o) => {
        const r = await world.scout(o);
        return { ...r, leaders: r.leaders.map((l, i) => (i === 0 ? { ...l, status: 'copying' as const, weight: 1, reason: undefined } : { ...l, status: 'rejected' as const, weight: 0 })) };
      },
      synthetic: true,
    });
    await engine.start();
    await engine.tick();
    world.advance(HOUR);
    await engine.tick(); // fetch sukses terakhir
    failing = true;
    // Masih dalam batas 10 menit: snapshot terakhir boleh dipakai.
    for (let i = 0; i < 2; i++) {
      world.advance(5 * 60_000);
      await engine.tick();
    }
    const before = engine.snapshot().trades.length;
    // Lewat batas -> beku: tidak ada order baru walau jam berjalan.
    for (let i = 0; i < 2; i++) {
      world.advance(5 * 60_000);
      await engine.tick();
    }
    const s1 = engine.snapshot();
    expect(s1.trades.length).toBe(before);
    expect(s1.alerts.map((a) => a.message).join('\n')).toContain('ditahan');
    // > 50 menit -> leader dikeluarkan.
    for (let i = 0; i < 8; i++) {
      world.advance(5 * 60_000);
      await engine.tick();
    }
    expect(engine.snapshot().alerts.some((a) => a.message.includes('tidak lagi disalin'))).toBe(true);
  }, 60_000);
});

describe('scout: cari sampai dapat', () => {
  const opts = { minAccountValue: 25_000, maxWeeklyTurnover: 200, maxFillsPerDay: 150, maxDrawdown: 0.45, deepDive: 100, slots: 2, concentration: 0.5 };
  const good: DeepMetrics = { winRate: 0.6, profitFactor: 2, fillsPerDay: 6, closingTrades: 12, topTradeShare: 0.3, maxDrawdown: 0.15, openPositions: 2, coins: ['BTC'], holdHours: 20, scalpShare: 0.05, positiveDays: 0.6 };
  const row = (i: number, weekRoi: number): ParsedRow => ({
    address: `0x${i.toString(16).padStart(40, '0')}`,
    label: `t${i}`,
    accountValue: 100_000,
    week: { pnl: weekRoi * 100_000, roi: weekRoi, vlm: 1e6 },
    month: { pnl: 20_000, roi: 0.2, vlm: 4e6 },
    allTime: { pnl: 50_000, roi: 0.5, vlm: 1e7 },
  });

  it('lama pegang posisi & porsi scalping direkonstruksi dari fill', () => {
    const f = (time: number, side: 'A' | 'B', start: number, pnl: number) => ({ coin: 'BTC', px: '1', sz: '1', side, time, dir: '', startPosition: String(start), closedPnl: String(pnl), fee: '0', oid: 1, hash: '' });
    const H = 3_600_000;
    const p = holdingProfile([f(0, 'B', 0, 0), f(5 * 60_000, 'A', 1, 10), f(10 * H, 'A', 0, 0), f(13 * H, 'B', -1, 30)]);
    expect(p.scalpShare).toBeCloseTo(10 / 40);
    expect(p.holdHours).toBeCloseTo(3);
  });

  it('win rate dihitung per trade, bukan per fill (take-profit bertahap tidak menggelembungkan win rate)', () => {
    const f = (time: number, side: 'A' | 'B', start: number, sz: number, pnl: number) => ({ coin: 'ETH', px: '1', sz: String(sz), side, time, dir: '', startPosition: String(start), closedPnl: String(pnl), fee: '0', oid: 1, hash: '' });
    const H = 3_600_000;
    const m = fillMetrics(
      [
        // Trade 1: long 3, ditutup untung dalam 3 potongan.
        f(0, 'B', 0, 3, 0),
        f(1 * H, 'A', 3, 1, 5),
        f(2 * H, 'A', 2, 1, 5),
        f(3 * H, 'A', 1, 1, 5),
        // Trade 2: long 1, ditutup rugi besar.
        f(4 * H, 'B', 0, 1, 0),
        f(9 * H, 'A', 1, 1, -40),
      ],
      7,
    );
    expect(m.winRate).toBeCloseTo(0.5); // per fill akan terlihat 3/4
    expect(m.closingTrades).toBe(2);
    expect(m.profitFactor).toBeCloseTo(15 / 40);
  });

  it('10 kandidat teratas ditolak (scalper) -> lanjut menggali sampai slot terisi', async () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => row(i, 0.5 - i * 0.01)), ...Array.from({ length: 30 }, (_, i) => row(100 + i, 0.2 - i * 0.001))];
    const scalper = { ...good, scalpShare: 0.9 };
    const r = await runScout(opts, { leaderboard: async () => rows, deepDive: async (a) => (parseInt(a, 16) < 100 ? scalper : good) }, () => {}, 0);
    expect(r.summary.analyzed).toBe(20);
    expect(r.summary.rounds).toBe(1);
    expect(r.leaders.filter((l) => l.status === 'copying').length).toBe(2);
    expect(r.leaders.filter((l) => l.status === 'rejected').every((l) => l.reason?.includes('scalping'))).toBe(true);
  });

  it('tidak ada yang lolos saringan ketat -> saringan awal dilonggarkan', async () => {
    // Semua ROI 7 hari hanya 1% (< 3%): baru masuk di saringan Standar.
    const rows = Array.from({ length: 5 }, (_, i) => row(i, 0.01));
    const r = await runScout(opts, { leaderboard: async () => rows, deepDive: async () => good }, () => {}, 0);
    expect(r.summary.level).toBe(1);
    expect(r.summary.qualified).toBe(5);
    expect(r.leaders.filter((l) => l.status === 'copying').length).toBe(2);
  });

  it('batas deepDive dihormati', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i, 0.3));
    const r = await runScout({ ...opts, deepDive: 7 }, { leaderboard: async () => rows, deepDive: async () => ({ ...good, closingTrades: 0 }) }, () => {}, 0);
    expect(r.summary.analyzed).toBe(7);
    expect(r.summary.qualified).toBe(0);
  });
});
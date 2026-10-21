import type { Candle } from '../../../shared/types';
import { backtest } from '../backtest/backtester';
import { maxDrawdown } from '../backtest/metrics';
import { buildDataset, tailDataset } from '../data/dataset';
import type { MarketHistory } from '../data/market';
import type { PriceFeed } from '../exchanges/types';
import { mulberry32 } from '../lib/rng';
import { HOUR, WEEK } from '../lib/time';
import { type DeepMetrics, type ParsedRow, runScout, type ScoutOptions, type ScoutResult, type ScoutSource } from '../scout/hyperliquidScout';
import type { LeaderSnapshot, LeaderSource } from '../sources/leaders';
import { getStrategy } from '../strategies/catalog';
import { strategyPositions } from '../strategies/sizing';
import type { Dataset } from '../strategies/types';
import { DEMO_COINS, syntheticCandles } from './synthetic';

// Dunia SINTETIS untuk mode demo: harga, leader, dan leaderboard buatan dengan jam virtual.
// Semua dijalankan lewat kode engine yang sama dengan mode paper/live.

interface DemoTrader {
  name: string;
  strategy: string;
  params: Record<string, number>;
  coins: string[];
  leverage: number;
  startEquity: number;
  fillsPerDay: number;
  holdHours: number;
  winRate: number;
  topTradeShare: number;
  // Edge buatan: porsi posisi yang mengikuti arah harga 24 jam ke depan. Hanya di dunia demo,
  // supaya bisa diuji apakah scout menemukan trader yang benar-benar punya keunggulan.
  edge: number;
}

const STYLES: { strategy: string; params: Record<string, number>; hold: number }[] = [
  { strategy: 'supertrend', params: { period: 22, mult: 3 }, hold: 30 },
  { strategy: 'ts-momentum', params: { lookback: 168, every: 24 }, hold: 60 },
  { strategy: 'donchian', params: { n: 72, exit: 36 }, hold: 40 },
  { strategy: 'rsi-revert', params: { period: 14, lo: 30, hi: 70 }, hold: 9 },
  { strategy: 'ema-trend', params: { fast: 24, slow: 168, k: 3 }, hold: 70 },
  { strategy: 'ema-trend', params: { fast: 12, slow: 72, k: 3 }, hold: 26 },
  { strategy: 'donchian', params: { n: 24, exit: 12 }, hold: 14 },
  { strategy: 'ts-momentum', params: { lookback: 72, every: 24 }, hold: 36 },
];

const NAMES = ['atlas', 'meridian', 'corsair', 'vesper', 'halcyon', 'solace', 'tidewater', 'orrery', 'lumen', 'cobalt', 'sable', 'kestrel', 'marlow', 'quill', 'ember', 'northwind', 'aurelian', 'juniper'];

// Populasi trader sintetis: sebagian besar tanpa edge, sebagian kecil punya edge buatan.
function makeTraders(seed: number): DemoTrader[] {
  const r = mulberry32(seed * 7 + 3);
  const edges = [0, 0, 0, 0, 0, 0.02, 0.04, 0.06, 0.08];
  return NAMES.map((name, i) => {
    const style = STYLES[i % STYLES.length];
    const pool = [...DEMO_COINS.map((c) => c.coin)];
    const coins: string[] = [];
    const n = 1 + Math.floor(r() * 3);
    while (coins.length < n) coins.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    const edge = edges[Math.floor(r() * edges.length)];
    return {
      name: `${name}.demo`,
      strategy: style.strategy,
      params: style.params,
      coins,
      leverage: 1 + r() * 1.6,
      startEquity: Math.exp(Math.log(60_000) + r() * Math.log(50)),
      fillsPerDay: 2 + r() * 16,
      holdHours: style.hold * (0.7 + r() * 0.6),
      winRate: Math.min(0.75, 0.42 + edge * 1.5 + r() * 0.15),
      topTradeShare: 0.25 + r() * 0.3,
      edge,
    };
  });
}

// Contoh trader yang harus ditolak scout.
const DISTRACTORS: { row: Omit<ParsedRow, 'address'>; m: DeepMetrics }[] = [
  {
    row: { label: 'scalper.demo', accountValue: 230_000, week: { pnl: 41_000, roi: 0.22, vlm: 2.4e7 }, month: { pnl: 64_000, roi: 0.38, vlm: 9e7 }, allTime: { pnl: 120_000, roi: 1.1, vlm: 4e8 } },
    m: { winRate: 0.71, profitFactor: 2.4, fillsPerDay: 96, closingTrades: 310, topTradeShare: 0.05, maxDrawdown: 0.09, openPositions: 2, coins: ['BTC', 'ETH'], holdHours: 0.05, scalpShare: 0.78, positiveDays: 0.8 },
  },
  {
    row: { label: 'onehit.demo', accountValue: 61_000, week: { pnl: 38_000, roi: 1.65, vlm: 2.1e6 }, month: { pnl: 29_000, roi: 0.9, vlm: 3e6 }, allTime: { pnl: 22_000, roi: 0.5, vlm: 5e6 } },
    m: { winRate: 0.5, profitFactor: 6, fillsPerDay: 1.1, closingTrades: 4, topTradeShare: 0.97, maxDrawdown: 0.38, openPositions: 1, coins: ['SUI'], holdHours: 50, scalpShare: 0, positiveDays: 0.4 },
  },
  {
    row: { label: 'mm-vault.demo', accountValue: 4_800_000, week: { pnl: 96_000, roi: 0.02, vlm: 1.8e9 }, month: { pnl: 410_000, roi: 0.09, vlm: 8e9 }, allTime: { pnl: 6_100_000, roi: 1.4, vlm: 9e10 } },
    m: { winRate: 0.61, profitFactor: 1.3, fillsPerDay: 4200, closingTrades: 9000, topTradeShare: 0.01, maxDrawdown: 0.03, openPositions: 38, coins: ['BTC', 'ETH'], holdHours: 0.2, scalpShare: 0.6, positiveDays: 0.9 },
  },
];

function fakeAddress(seed: number) {
  const r = mulberry32(seed);
  let s = '0x';
  for (let i = 0; i < 40; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

export class DemoWorld implements MarketHistory, PriceFeed {
  private candles: Record<string, Candle[]>;
  private full: Dataset;
  readonly barMs = HOUR;
  clockMs: number;
  readonly traders: (DemoTrader & { address: string })[];

  constructor(opts: { seed: number; start: number; historyWeeks: number; futureWeeks: number }) {
    const bars = (opts.historyWeeks + opts.futureWeeks) * 168;
    const endTime = Math.floor(opts.start / HOUR) * HOUR + opts.futureWeeks * WEEK;
    this.candles = syntheticCandles({ seed: opts.seed, bars, endTime });
    this.full = buildDataset(this.candles, '1h', { synthetic: true, benchmark: 'BTC' });
    this.clockMs = opts.start;
    this.traders = makeTraders(opts.seed).map((t, i) => ({ ...t, address: fakeAddress(opts.seed * 100 + i) }));
  }

  clock = () => this.clockMs;

  advance(ms: number) {
    this.clockMs += ms;
    if (this.clockMs > this.full.t[this.full.t.length - 1]) throw new Error('Demo kehabisan data masa depan');
  }

  // Indeks bar terakhir yang sudah close pada jam virtual.
  private closedIndex(at = this.clockMs) {
    return Math.floor((at - this.full.t[0]) / this.barMs) - 1;
  }

  private visible(bars?: number): Dataset {
    const last = this.closedIndex();
    const sliced = tailDataset({ ...this.full, t: this.full.t.slice(0, last + 1), series: this.sliceSeries(last + 1) }, bars ?? last + 1);
    return sliced;
  }

  private sliceSeries(n: number) {
    const out: Dataset['series'] = {};
    for (const c of this.full.coins) {
      const s = this.full.series[c];
      out[c] = { t: s.t.slice(0, n), o: s.o.subarray(0, n), h: s.h.subarray(0, n), l: s.l.subarray(0, n), c: s.c.subarray(0, n), v: s.v.subarray(0, n) };
    }
    return out;
  }

  // ---- MarketHistory
  async dataset(coins: string[], _interval: string, weeks: number) {
    const d = this.visible(weeks * 168);
    const keep = coins.filter((c) => d.series[c]);
    return { d: { ...d, coins: keep }, funding: undefined, failed: coins.filter((c) => !d.series[c]) };
  }

  async recent(coins: string[], _interval: string, bars: number) {
    const d = this.visible(bars);
    return { ...d, coins: coins.filter((c) => d.series[c]) };
  }

  // ---- PriceFeed: harga mark diinterpolasi di dalam bar yang sedang berjalan.
  async markPrices(coins: string[]) {
    const i = this.closedIndex() + 1;
    const frac = (this.clockMs - this.full.t[i]) / this.barMs;
    const out: Record<string, number> = {};
    for (const c of coins) {
      const s = this.full.series[c];
      if (!s) continue;
      const prev = s.c[i - 1];
      out[c] = prev + (s.c[i] - prev) * Math.min(1, Math.max(0, frac));
    }
    return out;
  }

  async listCoins() {
    return DEMO_COINS.map((c) => c.coin);
  }

  // ---- Leader virtual
  private traderCache = new Map<string, { bar: number; lev: Record<string, number>; equity: Float64Array }>();

  private traderState(t: DemoTrader & { address: string }) {
    const bar = this.closedIndex();
    const hit = this.traderCache.get(t.address);
    if (hit && hit.bar === bar) return hit;
    const d = this.visible();
    const sizing = { targetVol: 0.45, maxLeverage: 3, barsPerYear: d.barsPerYear };
    const pos: Record<string, Float64Array> = {};
    const s = getStrategy(t.strategy);
    for (const coin of t.coins) {
      const p = strategyPositions(s, t.params, d, [coin], sizing)[coin];
      const fc = this.full.series[coin].c;
      pos[coin] = p.map((x, i) => {
        const ahead = fc[Math.min(fc.length - 1, i + 24)] / fc[i] - 1;
        const blended = (1 - t.edge) * x + t.edge * Math.sign(ahead) * 1.5;
        return (blended * t.leverage) / t.coins.length;
      });
    }
    const bt = backtest(d, pos, { feeRate: 0.00045, slippage: 0.0002 });
    const lev: Record<string, number> = {};
    for (const coin of t.coins) lev[coin] = pos[coin][pos[coin].length - 1];
    const state = { bar, lev, equity: bt.equity };
    this.traderCache.set(t.address, state);
    return state;
  }

  leaderSource = (address: string, label?: string): LeaderSource => {
    const t = this.traders.find((x) => x.address === address);
    return {
      id: address,
      label: label ?? address,
      fetch: async (): Promise<LeaderSnapshot> => {
        if (!t) return { id: address, equity: 0, positions: {}, ts: this.clockMs };
        const st = this.traderState(t);
        const equity = this.accountValue(t, st.equity, st.equity.length - 1);
        const marks = await this.markPrices(t.coins);
        const positions: LeaderSnapshot['positions'] = {};
        for (const [coin, lev] of Object.entries(st.lev)) if (lev) positions[coin] = { size: (lev * equity) / marks[coin], px: marks[coin] };
        return { id: address, equity, positions, ts: this.clockMs };
      },
    };
  };

  // startEquity = nilai akun 30 hari lalu, supaya angka akun tetap wajar walau riwayat sintetis panjang.
  private accountValue(t: DemoTrader, eq: Float64Array, n: number) {
    const base = eq[Math.max(0, n - 720)] || 1;
    return (t.startEquity * eq[n]) / base;
  }

  // Sumber scout versi demo: leaderboard & metrik dihitung dari kurva ekuitas trader virtual,
  // lalu dinilai dengan fungsi scout asli (saringan, penolakan, skor, pencarian bertahap).
  private traderRow(t: DemoTrader & { address: string }): { row: ParsedRow; m: DeepMetrics } {
    const st = this.traderState(t);
    const eq = st.equity;
    const n = this.closedIndex();
    const at = (bars: number) => eq[Math.max(0, n - bars)];
    const weekRoi = eq[n] / at(168) - 1;
    const monthRoi = eq[n] / at(720) - 1;
    const daily: number[] = [];
    for (let k = 24; k <= 672; k += 24) daily.push(eq[n - k + 24] / eq[n - k] - 1);
    const gains = daily.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const losses = -daily.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    const av = this.accountValue(t, eq, n);
    return {
      row: {
        address: t.address,
        label: t.name,
        accountValue: av,
        week: { pnl: av * (1 - 1 / (1 + weekRoi)), roi: weekRoi, vlm: av * t.leverage * t.fillsPerDay * 0.8 },
        month: { pnl: av * (1 - 1 / (1 + monthRoi)), roi: monthRoi, vlm: 0 },
        allTime: { pnl: Math.max(av * 0.3, av * (1 - 1 / (1 + monthRoi))), roi: 0.3, vlm: 0 },
      },
      m: {
        winRate: t.winRate,
        profitFactor: losses > 0 ? gains / losses : 10,
        fillsPerDay: t.fillsPerDay,
        closingTrades: Math.round((t.fillsPerDay * 7) / 2),
        topTradeShare: t.topTradeShare,
        maxDrawdown: maxDrawdown(eq, Math.max(0, n - 720), n),
        openPositions: Object.values(st.lev).filter(Boolean).length,
        coins: t.coins,
        holdHours: t.holdHours,
        scalpShare: 0.03,
        positiveDays: daily.length ? daily.filter((x) => x > 0).length / daily.length : null,
      },
    };
  }

  scoutSource: ScoutSource = {
    leaderboard: async () => [
      ...this.traders.map((t) => this.traderRow(t).row),
      ...DISTRACTORS.map((x, i) => ({ ...x.row, address: fakeAddress(9001 + i) })),
    ],
    deepDive: async (address) => {
      const t = this.traders.find((x) => x.address === address);
      if (t) return this.traderRow(t).m;
      const i = DISTRACTORS.findIndex((_, j) => fakeAddress(9001 + j) === address);
      if (i < 0) throw new Error('alamat tidak dikenal');
      return DISTRACTORS[i].m;
    },
  };

  scout = (o: ScoutOptions): Promise<ScoutResult> => runScout(o, this.scoutSource, () => {}, 0);
}

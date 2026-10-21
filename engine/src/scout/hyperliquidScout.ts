import type { LeaderView } from '../../../shared/types';
import { type HlFill, type HlLeaderboardRow, type HlPortfolio, HyperliquidInfo } from '../data/hyperliquidInfo';
import { sleep, WEEK } from '../lib/time';

export interface Window {
  pnl: number;
  roi: number;
  vlm: number;
}

export interface ParsedRow {
  address: string;
  label: string;
  accountValue: number;
  week: Window;
  month: Window;
  allTime: Window;
}

export interface DeepMetrics {
  winRate: number | null;
  profitFactor: number | null;
  fillsPerDay: number;
  closingTrades: number;
  topTradeShare: number; // porsi profit minggu ini dari 1 trade terbesar
  maxDrawdown: number | null;
  openPositions: number;
  coins: string[];
}

export interface ScoutOptions {
  minAccountValue: number;
  maxWeeklyTurnover: number;
  maxFillsPerDay: number;
  maxDrawdown: number;
  deepDive: number;
  slots: number;
  concentration: number;
  minWeekRoi?: number;
  supports?: (coin: string) => boolean;
}

const win = (row: HlLeaderboardRow, key: string): Window => {
  const w = row.windowPerformances.find(([k]) => k === key)?.[1];
  return { pnl: Number(w?.pnl ?? 0), roi: Number(w?.roi ?? 0), vlm: Number(w?.vlm ?? 0) };
};

export function parseLeaderboard(rows: HlLeaderboardRow[]): ParsedRow[] {
  return rows.map((r) => ({
    address: r.ethAddress.toLowerCase(),
    label: r.displayName || `${r.ethAddress.slice(0, 6)}…${r.ethAddress.slice(-4)}`,
    accountValue: Number(r.accountValue),
    week: win(r, 'week'),
    month: win(r, 'month'),
    allTime: win(r, 'allTime'),
  }));
}

// Saring kasar dari data leaderboard saja (murah, tanpa panggilan tambahan).
export function prefilter(rows: ParsedRow[], o: ScoutOptions) {
  const passed: ParsedRow[] = [];
  for (const r of rows) {
    if (r.accountValue < o.minAccountValue) continue;
    if (r.week.pnl <= 0 || r.week.roi < (o.minWeekRoi ?? 0.03)) continue;
    if (r.month.roi <= 0 || r.allTime.pnl <= 0) continue;
    if (r.week.vlm / Math.max(r.accountValue, 1) > o.maxWeeklyTurnover) continue;
    passed.push(r);
  }
  const rank = percentileRanks(passed.map((r) => r.week.roi));
  const rankM = percentileRanks(passed.map((r) => r.month.roi));
  return passed
    .map((r, i) => ({ r, s: 0.6 * rank[i] + 0.4 * rankM[i] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, o.deepDive)
    .map((x) => x.r);
}

export function fillMetrics(fills: HlFill[], days: number) {
  const closing = fills.filter((f) => Number(f.closedPnl) !== 0);
  const wins = closing.filter((f) => Number(f.closedPnl) > 0);
  const gains = wins.reduce((a, f) => a + Number(f.closedPnl), 0);
  const losses = closing.filter((f) => Number(f.closedPnl) < 0).reduce((a, f) => a - Number(f.closedPnl), 0);
  const top = wins.reduce((m, f) => Math.max(m, Number(f.closedPnl)), 0);
  const net = gains - losses;
  return {
    winRate: closing.length ? wins.length / closing.length : null,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? 10 : null,
    fillsPerDay: fills.length / days,
    closingTrades: closing.length,
    topTradeShare: net > 0 ? Math.min(1, top / net) : 1,
    coins: [...new Set(fills.map((f) => f.coin))],
  };
}

// Drawdown bulan ini dari kurva PnL (tidak terganggu deposit/penarikan seperti accountValue).
export function portfolioDrawdown(p: HlPortfolio, period = 'month'): number | null {
  const entry = p.find(([k]) => k === period)?.[1];
  if (!entry || entry.pnlHistory.length < 2) return null;
  const av0 = Number(entry.accountValueHistory[0]?.[1] ?? 0);
  const base = av0 - Number(entry.pnlHistory[0][1]);
  let peak = -Infinity;
  let dd = 0;
  for (const [, pnlStr] of entry.pnlHistory) {
    const eq = base + Number(pnlStr);
    peak = Math.max(peak, eq);
    if (peak > 0) dd = Math.max(dd, 1 - eq / peak);
  }
  return dd;
}

export async function deepDive(info: HyperliquidInfo, address: string, now = Date.now()): Promise<DeepMetrics> {
  const [fills, portfolio, state] = await Promise.all([
    info.userFillsByTime(address, now - WEEK, now, 3),
    info.portfolio(address).catch(() => null),
    info.clearinghouseState(address),
  ]);
  const fm = fillMetrics(fills, 7);
  return {
    ...fm,
    maxDrawdown: portfolio ? portfolioDrawdown(portfolio) : null,
    openPositions: state.assetPositions.filter((a) => Number(a.position.szi) !== 0).length,
  };
}

export function rejectReason(r: ParsedRow, m: DeepMetrics, o: ScoutOptions): string | undefined {
  if (m.fillsPerDay > o.maxFillsPerDay) return `Terlalu sering trading (${m.fillsPerDay.toFixed(0)} fill/hari) — gaya bot, tidak bisa disalin tepat waktu`;
  if (m.closingTrades < 3) return 'Bukti kurang: < 3 trade ditutup dalam 7 hari';
  if (m.maxDrawdown !== null && m.maxDrawdown > o.maxDrawdown) return `Drawdown bulanan ${(m.maxDrawdown * 100).toFixed(0)}% melebihi batas`;
  if (m.topTradeShare > 0.85 && r.week.pnl > 0) return 'Profit minggu ini hampir semua dari 1 trade — belum terbukti konsisten';
  if (o.supports && m.coins.length) {
    const ok = m.coins.filter((c) => o.supports!(c)).length / m.coins.length;
    if (ok < 0.5) return 'Mayoritas koinnya tidak tersedia di venue eksekusi';
  }
  return undefined;
}

// Peringkat persentil 0..1; nilai kembar mendapat rata-rata peringkatnya.
export function percentileRanks(xs: number[]): number[] {
  if (xs.length <= 1) return xs.map(() => 1);
  return xs.map((x) => {
    const below = xs.filter((y) => y < x).length;
    const equal = xs.filter((y) => y === x).length;
    return (below + (equal - 1) / 2) / (xs.length - 1);
  });
}

// Skor akhir & bobot. Minggu ini paling berat (berani mengejar momentum), dikoreksi kualitas.
export function rankLeaders(items: { row: ParsedRow; m: DeepMetrics; reason?: string }[], o: ScoutOptions): LeaderView[] {
  const ok = items.filter((x) => !x.reason);
  const pr = (f: (x: (typeof ok)[number]) => number) => percentileRanks(ok.map(f));
  const wk = pr((x) => x.row.week.roi);
  const mo = pr((x) => x.row.month.roi);
  const wr = pr((x) => x.m.winRate ?? 0);
  const pf = pr((x) => x.m.profitFactor ?? 0);
  const dd = pr((x) => -(x.m.maxDrawdown ?? 0.5));
  const scored = ok
    .map((x, i) => ({ x, score: 0.4 * wk[i] + 0.2 * mo[i] + 0.15 * wr[i] + 0.15 * pf[i] + 0.1 * dd[i] }))
    .sort((a, b) => b.score - a.score);
  const chosen = scored.slice(0, o.slots);
  const raw = chosen.map((c) => Math.max(c.score, 1e-6) ** (1 / o.concentration));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const weights = new Map(chosen.map((c, i) => [c.x.row.address, raw[i] / total]));
  const view = (x: (typeof items)[number], score: number): LeaderView => ({
    address: x.row.address,
    label: x.row.label,
    accountValue: x.row.accountValue,
    weekRoi: x.row.week.roi,
    monthRoi: x.row.month.roi,
    allTimePnl: x.row.allTime.pnl,
    winRate: x.m.winRate,
    maxDrawdown: x.m.maxDrawdown,
    fillsPerDay: x.m.fillsPerDay,
    score,
    weight: weights.get(x.row.address) ?? 0,
    status: x.reason ? 'rejected' : weights.has(x.row.address) ? 'copying' : 'candidate',
    reason: x.reason,
    openPositions: x.m.openPositions,
  });
  return [
    ...scored.map((s) => view(s.x, s.score)),
    ...items.filter((x) => x.reason).map((x) => view(x, 0)),
  ];
}

export async function runScout(o: ScoutOptions, log: (m: string) => void = () => {}, info = new HyperliquidInfo()): Promise<LeaderView[]> {
  log('Mengunduh leaderboard Hyperliquid…');
  const { leaderboardRows } = await HyperliquidInfo.leaderboard();
  const parsed = parseLeaderboard(leaderboardRows);
  const shortlist = prefilter(parsed, o);
  log(`${parsed.length} trader, ${shortlist.length} lolos saringan awal. Analisis mendalam…`);
  const items: { row: ParsedRow; m: DeepMetrics; reason?: string }[] = [];
  for (const row of shortlist) {
    try {
      const m = await deepDive(info, row.address);
      items.push({ row, m, reason: rejectReason(row, m, o) });
    } catch (e) {
      log(`  ${row.label}: gagal dianalisis (${e instanceof Error ? e.message : e})`);
    }
    // ~40 bobot API per trader; jeda menjaga di bawah batas 1200 bobot/menit Hyperliquid.
    await sleep(1200);
  }
  return rankLeaders(items, o);
}

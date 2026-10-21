import type { LeaderView, ScoutSummary } from '../../../shared/types';
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
  holdHours: number | null; // median lama posisi dipegang
  scalpShare: number | null; // porsi |PnL| dari posisi < 10 menit
  positiveDays: number | null; // porsi hari profit (30 hari)
}

export interface ScoutOptions {
  minAccountValue: number;
  maxWeeklyTurnover: number;
  maxFillsPerDay: number;
  maxDrawdown: number;
  deepDive: number; // batas total trader yang dianalisis mendalam
  slots: number;
  concentration: number;
  minWeekRoi?: number;
  supports?: (coin: string) => boolean;
}

// Sumber data scout: Hyperliquid asli, atau dunia demo.
export interface ScoutSource {
  leaderboard(): Promise<ParsedRow[]>;
  deepDive(address: string): Promise<DeepMetrics>;
}

export interface ScoutResult {
  leaders: LeaderView[];
  summary: ScoutSummary;
}

// Tingkat saringan awal. Dilonggarkan hanya bila trader yang lolos kurang dari jumlah slot.
// Saringan kelayakan salin (bot, scalping, untung sekali, drawdown) TIDAK pernah dilonggarkan.
export const SCOUT_LEVELS = [
  { id: 0, label: 'Ketat', minWeekRoi: 0.03, accountMult: 1, turnoverMult: 1 },
  { id: 1, label: 'Standar', minWeekRoi: 0, accountMult: 0.4, turnoverMult: 1.5 },
  { id: 2, label: 'Longgar', minWeekRoi: -Infinity, accountMult: 0.4, turnoverMult: 2 },
] as const;

const BATCH = 20;

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

// Saringan kasar dari data leaderboard saja (murah), diurutkan dari kandidat paling menjanjikan.
export function prefilter(rows: ParsedRow[], o: ScoutOptions, level: (typeof SCOUT_LEVELS)[number] = SCOUT_LEVELS[0]) {
  const minWeek = level.id === 0 ? (o.minWeekRoi ?? level.minWeekRoi) : level.minWeekRoi;
  const passed = rows.filter(
    (r) =>
      r.accountValue >= o.minAccountValue * level.accountMult &&
      r.week.roi >= minWeek &&
      (level.id === 2 || r.week.pnl > 0) &&
      r.month.roi > 0 &&
      r.allTime.pnl > 0 &&
      r.week.vlm / Math.max(r.accountValue, 1) <= o.maxWeeklyTurnover * level.turnoverMult,
  );
  const rank = percentileRanks(passed.map((r) => r.week.roi));
  const rankM = percentileRanks(passed.map((r) => r.month.roi));
  return passed
    .map((r, i) => ({ r, s: 0.6 * rank[i] + 0.4 * rankM[i] }))
    .sort((a, b) => b.s - a.s)
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
    ...holdingProfile(fills),
  };
}

// Rekonstruksi posisi dari fill (startPosition + ukuran) untuk mengukur berapa lama posisi dipegang.
// Trader yang untungnya dari scalping menit-an tidak bisa disalin dengan polling 10 detik.
export function holdingProfile(fills: HlFill[]): { holdHours: number | null; scalpShare: number | null } {
  if (!fills.length || fills.some((f) => f.startPosition === undefined)) return { holdHours: null, scalpShare: null };
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const open = new Map<string, { t: number; pnl: number }>();
  const trades: { hold: number; pnl: number }[] = [];
  for (const f of sorted) {
    const start = Number(f.startPosition);
    const end = start + Number(f.sz) * (f.side === 'B' ? 1 : -1);
    const cur = open.get(f.coin);
    if (cur) cur.pnl += Number(f.closedPnl);
    const closes = start !== 0 && (Math.abs(end) < 1e-12 || Math.sign(end) !== Math.sign(start));
    if (closes && cur) {
      trades.push({ hold: f.time - cur.t, pnl: cur.pnl });
      open.delete(f.coin);
    }
    if (Math.abs(end) > 1e-12 && (start === 0 || Math.sign(end) !== Math.sign(start))) open.set(f.coin, { t: f.time, pnl: 0 });
  }
  if (!trades.length) return { holdHours: null, scalpShare: null };
  const holds = trades.map((t) => t.hold).sort((a, b) => a - b);
  const totalAbs = trades.reduce((a, t) => a + Math.abs(t.pnl), 0);
  const scalpAbs = trades.filter((t) => t.hold < 10 * 60_000).reduce((a, t) => a + Math.abs(t.pnl), 0);
  return { holdHours: holds[Math.floor(holds.length / 2)] / 3_600_000, scalpShare: totalAbs > 0 ? scalpAbs / totalAbs : 0 };
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

// Porsi hari (UTC) dengan PnL naik, dari kurva PnL 30 hari.
export function positiveDayShare(p: HlPortfolio, period = 'month'): number | null {
  const entry = p.find(([k]) => k === period)?.[1];
  if (!entry || entry.pnlHistory.length < 3) return null;
  const byDay = new Map<number, number>();
  for (const [t, v] of entry.pnlHistory) byDay.set(Math.floor(t / 86_400_000), Number(v));
  const vals = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (vals.length < 3) return null;
  let up = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1]) up++;
  return up / (vals.length - 1);
}

export function hyperliquidSource(info = new HyperliquidInfo()): ScoutSource {
  return {
    leaderboard: async () => parseLeaderboard((await HyperliquidInfo.leaderboard()).leaderboardRows),
    deepDive: async (address) => {
      const now = Date.now();
      const [fills, portfolio, state] = await Promise.all([
        info.userFillsByTime(address, now - WEEK, now, 3),
        info.portfolio(address).catch(() => null),
        info.clearinghouseState(address),
      ]);
      return {
        ...fillMetrics(fills, 7),
        maxDrawdown: portfolio ? portfolioDrawdown(portfolio) : null,
        positiveDays: portfolio ? positiveDayShare(portfolio) : null,
        openPositions: state.assetPositions.filter((a) => Number(a.position.szi) !== 0).length,
      };
    },
  };
}

export function rejectReason(r: ParsedRow, m: DeepMetrics, o: ScoutOptions): string | undefined {
  if (m.fillsPerDay > o.maxFillsPerDay) return `Terlalu sering trading (${m.fillsPerDay.toFixed(0)} fill/hari) — gaya bot, tidak bisa disalin tepat waktu`;
  if (m.scalpShare !== null && m.scalpShare > 0.5) return `${Math.round(m.scalpShare * 100)}% PnL dari posisi < 10 menit — scalping tidak bisa disalin`;
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
  const pd = pr((x) => x.m.positiveDays ?? 0.5);
  const scored = ok
    .map((x, i) => ({ x, score: 0.35 * wk[i] + 0.2 * mo[i] + 0.15 * wr[i] + 0.1 * pf[i] + 0.1 * dd[i] + 0.1 * pd[i] }))
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
    holdHours: x.m.holdHours,
    scalpShare: x.m.scalpShare,
    positiveDays: x.m.positiveDays,
    score,
    weight: weights.get(x.row.address) ?? 0,
    status: x.reason ? 'rejected' : weights.has(x.row.address) ? 'copying' : 'candidate',
    reason: x.reason,
    openPositions: x.m.openPositions,
  });
  return [...scored.map((s) => view(s.x, s.score)), ...items.filter((x) => x.reason).map((x) => view(x, 0))];
}

// Cari sampai dapat: analisis mendalam per batch 20 trader, berhenti saat yang lolos cukup untuk
// diadu (2x slot), leaderboard habis, atau batas deepDive tercapai. Bila belum cukup, saringan awal
// dilonggarkan satu tingkat dan pencarian berlanjut ke trader yang belum dianalisis.
export async function runScout(o: ScoutOptions, source: ScoutSource, log: (m: string) => void = () => {}, pauseMs = 1200): Promise<ScoutResult> {
  log('Mengunduh leaderboard…');
  const rows = await source.leaderboard();
  const analyzed = new Map<string, { row: ParsedRow; m: DeepMetrics; reason?: string }>();
  const target = Math.max(o.slots * 2, o.slots + 2);
  const qualifiedCount = () => [...analyzed.values()].filter((x) => !x.reason).length;
  let rounds = 0;
  let level: (typeof SCOUT_LEVELS)[number] = SCOUT_LEVELS[0];
  search: for (const lv of SCOUT_LEVELS) {
    level = lv;
    const ranked = prefilter(rows, o, lv).filter((r) => !analyzed.has(r.address));
    log(`Saringan ${lv.label}: ${ranked.length} kandidat baru dari ${rows.length} trader`);
    for (let i = 0; i < ranked.length; i += BATCH) {
      if (analyzed.size >= o.deepDive) break search;
      rounds++;
      for (const row of ranked.slice(i, i + BATCH)) {
        if (analyzed.size >= o.deepDive) break;
        try {
          const m = await source.deepDive(row.address);
          analyzed.set(row.address, { row, m, reason: rejectReason(row, m, o) });
        } catch (e) {
          log(`  ${row.label}: gagal dianalisis (${e instanceof Error ? e.message : e})`);
        }
        // ~40 bobot API per trader; jeda menjaga di bawah batas 1200 bobot/menit Hyperliquid.
        if (pauseMs) await sleep(pauseMs);
      }
      log(`  putaran ${rounds}: ${analyzed.size} dianalisis, ${qualifiedCount()} lolos`);
      if (qualifiedCount() >= target) break search;
    }
    if (qualifiedCount() >= o.slots) break;
  }
  return {
    leaders: rankLeaders([...analyzed.values()], o),
    summary: {
      ranAt: Date.now(),
      leaderboardSize: rows.length,
      analyzed: analyzed.size,
      rounds,
      level: level.id,
      levelLabel: level.label,
      qualified: qualifiedCount(),
    },
  };
}

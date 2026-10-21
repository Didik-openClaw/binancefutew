import type { PolicyReport, TournamentEntry, TournamentReport } from '../../../shared/types';
import { intervalMs } from '../lib/time';
import type { RiskProfile } from '../risk/profiles';
import { STRATEGIES } from '../strategies/catalog';
import { strategyPositions } from '../strategies/sizing';
import type { Dataset, Params, Strategy } from '../strategies/types';
import { backtest, type CostModel, weekSlices, weeklyEntries, weeklyReturns, type WeekSlice } from './backtester';
import { compound, maxDrawdownFromReturns, std, weeklySharpe, winRate } from './metrics';

export interface TournamentOptions {
  profile: RiskProfile;
  lookbackWeeks: number;
  walkForwardWeeks: number;
  warmupWeeks?: number;
  minEntries?: number;
  benchmark: string;
  cost: CostModel;
  strategies?: Strategy[];
  halfLifeWeeks?: number;
}

export interface Candidate {
  id: string;
  strategy: Strategy;
  params: Params;
  universe: string[];
  label: string;
  diversityKey: string;
  weekly: number[]; // return mingguan, sejajar dengan `weeks`
  weeklyEntries: number[];
  exposure: number;
}

export interface Pick {
  candidate: Candidate;
  score: number;
  weight: number;
}

export interface TournamentRun {
  report: TournamentReport;
  candidates: Candidate[];
  weeks: WeekSlice[];
  picks: Pick[]; // pilihan untuk minggu depan
}

const paramKey = (p: Params) =>
  Object.entries(p)
    .map(([k, v]) => `${k}${v}`)
    .join('-');

export function buildCandidates(d: Dataset, o: TournamentOptions): { candidates: Candidate[]; weeks: WeekSlice[] } {
  const weeks = weekSlices(d.t, intervalMs(d.interval));
  const sizing = {
    targetVol: o.profile.targetVol,
    maxLeverage: o.profile.maxPositionLeverage,
    barsPerYear: d.barsPerYear,
  };
  const candidates: Candidate[] = [];
  for (const s of o.strategies ?? STRATEGIES) {
    for (const p of s.grid) {
      const universes = s.kind === 'single' ? d.coins.map((c) => [c]) : d.coins.length >= s.minCoins ? [d.coins] : [];
      for (const u of universes) {
        const pos = strategyPositions(s, p, d, u, sizing);
        const bt = backtest(d, pos, o.cost);
        const scope = s.kind === 'single' ? u[0] : 'basket';
        candidates.push({
          id: `${s.id}:${paramKey(p)}:${scope}`,
          strategy: s,
          params: p,
          universe: u,
          label: s.kind === 'single' ? `${s.label(p)} · ${u[0]}` : `${s.label(p)} · ${u.length} koin`,
          // Satu slot per koin (strategi satu aset) atau per mode rotasi, supaya pilihan tidak dobel.
          diversityKey: s.kind === 'single' ? `coin:${u[0]}` : `${s.id}:${p.mode}`,
          weekly: weeklyReturns(bt.equity, weeks),
          weeklyEntries: weeklyEntries(bt.entries, weeks),
          exposure: bt.exposure,
        });
      }
    }
  }
  return { candidates, weeks };
}

// Skor agresif: rata-rata return mingguan berbobot (minggu terbaru lebih berat),
// dikurangi penalti downside dan penalti drawdown di atas batas profil.
export function scoreWindow(rets: number[], entries: number, o: TournamentOptions): number {
  if (!rets.length) return -Infinity;
  if (entries < (o.minEntries ?? 2)) return -Infinity;
  const hl = o.halfLifeWeeks ?? 4;
  let wsum = 0;
  let acc = 0;
  for (let j = 0; j < rets.length; j++) {
    const w = 0.5 ** ((rets.length - 1 - j) / hl);
    wsum += w;
    acc += w * rets[j];
  }
  const recencyMean = acc / wsum;
  const downside = Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / rets.length);
  const dd = maxDrawdownFromReturns(rets);
  const ddPenalty = Math.max(0, dd - o.profile.drawdownCap);
  return recencyMean - o.profile.downsidePenalty * downside - ddPenalty * 0.5;
}

// Pilih juara untuk minggu `k` memakai data minggu [k-L, k). Tidak melihat minggu k.
export function selectPicks(candidates: Candidate[], k: number, o: TournamentOptions): Pick[] {
  const L = o.lookbackWeeks;
  const from = Math.max(0, k - L);
  const scored = candidates
    .map((c) => {
      const rets = c.weekly.slice(from, k);
      const entries = c.weeklyEntries.slice(from, k).reduce((a, b) => a + b, 0);
      return { candidate: c, score: scoreWindow(rets, entries, o) };
    })
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  const picks: { candidate: Candidate; score: number }[] = [];
  const used = new Set<string>();
  for (const s of scored) {
    if (picks.length >= o.profile.strategySlots) break;
    if (used.has(s.candidate.diversityKey)) continue;
    if (picks.length > 0 && s.score <= 0) break;
    used.add(s.candidate.diversityKey);
    picks.push(s);
  }
  if (!picks.length) return [];
  // Bobot ~ skor^(1/konsentrasi): profil berani menumpuk modal ke juara.
  const pow = 1 / o.profile.concentration;
  const raw = picks.map((p) => Math.max(p.score, 1e-9) ** pow);
  const total = raw.reduce((a, b) => a + b, 0);
  return picks.map((p, i) => ({ ...p, weight: raw[i] / total }));
}

export function runTournament(d: Dataset, o: TournamentOptions, now = Date.now()): TournamentRun {
  const { candidates, weeks } = buildCandidates(d, o);
  // Indeks minggu lengkap terakhir + 1 = minggu yang akan datang (belum ada datanya).
  let K = weeks.length;
  while (K > 0 && !weeks[K - 1].complete) K--;
  const warmup = o.warmupWeeks ?? 2;
  const L = o.lookbackWeeks;

  const bench = d.series[o.benchmark] ? o.benchmark : d.coins[0];
  const benchWeekly = weeks.map((w, k) => {
    const c = d.series[bench].c;
    const base = k === 0 ? c[w.first] : c[weeks[k - 1].last];
    return c[w.last] / base - 1;
  });

  // Walk-forward: simulasikan aturan "pilih tiap Senin" pada minggu-minggu lampau.
  const policyWeeks: PolicyReport['weeks'] = [];
  const firstEval = Math.max(warmup + Math.min(L, 4), K - o.walkForwardWeeks);
  for (let k = firstEval; k < K; k++) {
    const picks = selectPicks(candidates, k, { ...o, lookbackWeeks: Math.min(L, k - warmup) });
    const ret = picks.reduce((a, p) => a + p.weight * p.candidate.weekly[k], 0);
    policyWeeks.push({
      weekStart: weeks[k].start,
      pickedId: picks[0]?.candidate.id ?? 'flat',
      pickedLabel: picks.length
        ? picks[0].candidate.label + (picks.length > 1 ? ` +${picks.length - 1}` : '')
        : 'Tidak trading',
      ret,
      benchmark: benchWeekly[k],
    });
  }
  const pRets = policyWeeks.map((w) => w.ret);
  const policy: PolicyReport = {
    weeks: policyWeeks,
    totalReturn: compound(pRets),
    benchmarkReturn: compound(policyWeeks.map((w) => w.benchmark)),
    maxDrawdown: maxDrawdownFromReturns(pRets),
    winRateWeeks: winRate(pRets),
    worstWeek: pRets.length ? Math.min(...pRets) : 0,
    bestWeek: pRets.length ? Math.max(...pRets) : 0,
  };

  const picks = selectPicks(candidates, K, { ...o, lookbackWeeks: Math.min(L, K - warmup) });
  const from = Math.max(warmup, K - L);
  const entries: TournamentEntry[] = candidates
    .map((c) => {
      const rets = c.weekly.slice(from, K);
      const ent = c.weeklyEntries.slice(from, K).reduce((a, b) => a + b, 0);
      return {
        id: c.id,
        strategy: c.strategy.id,
        label: c.label,
        params: c.params,
        universe: c.universe,
        score: scoreWindow(rets, ent, o),
        stats: {
          totalReturn: compound(rets),
          lastWeek: rets[rets.length - 1] ?? 0,
          maxDrawdown: maxDrawdownFromReturns(rets),
          sharpe: weeklySharpe(rets),
          winRateWeeks: winRate(rets),
          trades: ent,
          exposure: c.exposure,
        },
        weeklyReturns: rets,
      };
    })
    .map((e) => ({ ...e, score: Number.isFinite(e.score) ? e.score : -1 }))
    .sort((a, b) => b.score - a.score);

  return {
    report: {
      ranAt: now,
      interval: d.interval,
      lookbackWeeks: K - from,
      dataFrom: d.t[0],
      dataTo: d.t[d.t.length - 1],
      benchmarkCoin: bench,
      entries,
      policy,
      synthetic: d.synthetic,
    },
    candidates,
    weeks,
    picks,
  };
}

export function describePolicyEdge(p: PolicyReport): string {
  const edge = p.totalReturn - p.benchmarkReturn;
  return `Rotasi mingguan ${fmtPct(p.totalReturn)} vs buy & hold ${fmtPct(p.benchmarkReturn)} (selisih ${fmtPct(edge)}), max DD ${fmtPct(-p.maxDrawdown)}, minggu profit ${(p.winRateWeeks * 100).toFixed(0)}%, std mingguan ${fmtPct(std(p.weeks.map((w) => w.ret)))}`;
}

export function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}

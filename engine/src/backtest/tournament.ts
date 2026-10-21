import type { PolicyReport, QualificationLevel, QualificationReport, RuleReport, TournamentEntry, TournamentReport } from '../../../shared/types';
import { intervalMs } from '../lib/time';
import type { RiskProfile } from '../risk/profiles';
import { STRATEGIES } from '../strategies/catalog';
import { strategyPositions } from '../strategies/sizing';
import type { Dataset, Params, Strategy } from '../strategies/types';
import { backtest, type CostModel, dailyByWeek, weekSlices, weeklyReturns, weeklySum, type WeekSlice } from './backtester';
import { compound, maxDrawdownFromReturns, std, weeklySharpe, winRate } from './metrics';
import { expectedMaxSharpe, psr, sharpe } from './stats';

// Alur mingguan:
// 1. Semua kombinasi strategi x parameter x koin di-backtest (kandidat).
// 2. Kandidat harus lolos gerbang kualifikasi (aktivitas, profit, konsistensi, signifikansi statistik
//    yang dikoreksi jumlah kandidat, tahan biaya, parameter stabil, drawdown). Bila tidak ada yang lolos,
//    gerbang dilonggarkan bertahap sampai ada juara.
// 3. Aturan seleksi (berapa minggu ke belakang & bobot minggu terbaru) dipilih dengan nested walk-forward:
//    tiap minggu dipakai aturan yang hasil out-of-sample-nya paling baik pada minggu-minggu sebelumnya.

export interface Rule {
  id: string;
  label: string;
  lookback: number;
  halfLife: number;
}

export const RULES: Rule[] = (
  [
    [4, 2],
    [4, 4],
    [8, 2],
    [8, 4],
    [12, 2],
    [12, 4],
    [12, 8],
  ] as const
).map(([lookback, halfLife]) => ({ id: `L${lookback}-H${halfLife}`, label: `${lookback} mgg · paruh ${halfLife}`, lookback, halfLife }));

export const DEFAULT_RULE = 'L12-H4';

export interface Gate {
  id: QualificationLevel;
  label: string;
  minEntries: number;
  minBlocks: number; // dari 3 sub-periode, berapa yang harus profit
  minPsr: number;
  minDsr: number | null;
  costStress: number | null; // tetap profit bila biaya dikali angka ini
  neighborFloor: number | null; // median return parameter tetangga minimal
  ddMult: number | null; // drawdown <= batas profil x angka ini
  requireProfit: boolean;
}

export const GATES: Gate[] = [
  // Ketat: Sharpe harus mengalahkan juara-karena-untung dari semua kandidat (DSR >= 0.9).
  { id: 0, label: 'Ketat', minEntries: 4, minBlocks: 2, minPsr: 0.95, minDsr: 0.9, costStress: 2, neighborFloor: 0, ddMult: 1, requireProfit: true },
  { id: 1, label: 'Standar', minEntries: 3, minBlocks: 2, minPsr: 0.9, minDsr: null, costStress: 2, neighborFloor: -0.05, ddMult: 1.3, requireProfit: true },
  { id: 2, label: 'Longgar', minEntries: 2, minBlocks: 1, minPsr: 0.7, minDsr: null, costStress: 1.5, neighborFloor: null, ddMult: 1.6, requireProfit: true },
  { id: 3, label: 'Darurat', minEntries: 1, minBlocks: 0, minPsr: 0, minDsr: null, costStress: null, neighborFloor: null, ddMult: null, requireProfit: false },
];

export const FUNNEL = ['Aktif', 'Profit', 'Konsisten', 'Signifikan', 'Tahan biaya', 'Parameter stabil', 'Drawdown terkendali'] as const;

export interface TournamentOptions {
  profile: RiskProfile;
  lookbackWeeks: number; // batas atas lookback aturan
  walkForwardWeeks: number;
  metaWeeks?: number; // jendela penilaian aturan
  warmupWeeks?: number;
  benchmark: string;
  cost: CostModel;
  strategies?: Strategy[];
  rules?: Rule[];
  expanded?: boolean;
}

export interface Candidate {
  id: string;
  strategy: Strategy;
  params: Params;
  universe: string[];
  label: string;
  diversityKey: string;
  familyKey: string;
  weekly: number[];
  weeklyEntries: number[];
  weeklyTurnover: number[];
  daily: number[][];
  exposure: number;
}

export interface Pick {
  candidate: Candidate;
  score: number;
  weight: number;
}

export interface WindowEval {
  c: Candidate;
  score: number;
  total: number;
  rets: number[];
  entries: number;
  turnover: number;
  maxDD: number;
  psr: number;
  dsr: number;
  blocks: number;
  neighbor: number | null;
}

export interface Selection {
  picks: Pick[];
  level: QualificationLevel;
  evals: WindowEval[];
  emax: number; // Sharpe harian juara-karena-untung
}

export interface TournamentRun {
  report: TournamentReport;
  candidates: Candidate[];
  weeks: WeekSlice[];
  picks: Pick[];
  rule: Rule;
  level: QualificationLevel;
}

const paramKey = (p: Params) =>
  Object.entries(p)
    .map(([k, v]) => `${k}${v}`)
    .join('-');

export function buildCandidates(d: Dataset, o: TournamentOptions): { candidates: Candidate[]; weeks: WeekSlice[] } {
  const weeks = weekSlices(d.t, intervalMs(d.interval));
  const sizing = { targetVol: o.profile.targetVol, maxLeverage: o.profile.maxPositionLeverage, barsPerYear: d.barsPerYear };
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
          // Tetangga = strategi & aset sama, parameter lain.
          familyKey: s.kind === 'single' ? `${s.id}:${u[0]}` : `${s.id}:${p.mode}`,
          weekly: weeklyReturns(bt.equity, weeks),
          weeklyEntries: weeklySum(bt.entries, weeks),
          weeklyTurnover: weeklySum(bt.traded, weeks),
          daily: dailyByWeek(bt.equity, d.t, weeks),
          exposure: bt.exposure,
        });
      }
    }
  }
  return { candidates, weeks };
}

// Skor agresif: rata-rata return mingguan berbobot (paruh-umur halfLife minggu),
// dikurangi penalti downside dan penalti drawdown di atas batas profil.
export function scoreWindow(rets: number[], halfLife: number, profile: RiskProfile): number {
  if (!rets.length) return -Infinity;
  let wsum = 0;
  let acc = 0;
  for (let j = 0; j < rets.length; j++) {
    const w = 0.5 ** ((rets.length - 1 - j) / halfLife);
    wsum += w;
    acc += w * rets[j];
  }
  const downside = Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / rets.length);
  const ddPenalty = Math.max(0, maxDrawdownFromReturns(rets) - profile.drawdownCap);
  return acc / wsum - profile.downsidePenalty * downside - ddPenalty * 0.5;
}

function blocksPositive(rets: number[]): number {
  if (rets.length < 3) return rets.filter((r) => r > 0).length;
  const size = Math.floor(rets.length / 3);
  let n = 0;
  for (let b = 0; b < 3; b++) {
    const chunk = rets.slice(b * size, b === 2 ? rets.length : (b + 1) * size);
    if (compound(chunk) > 0) n++;
  }
  return n;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function evaluateWindow(cands: Candidate[], k: number, rule: Rule, o: TournamentOptions): { evals: WindowEval[]; emax: number } {
  const warmup = o.warmupWeeks ?? 2;
  const from = Math.max(warmup, k - rule.lookback);
  const base = cands.map((c) => {
    const rets = c.weekly.slice(from, k);
    const daily = c.daily.slice(from, k).flat();
    return {
      c,
      rets,
      daily,
      entries: c.weeklyEntries.slice(from, k).reduce((a, b) => a + b, 0),
      turnover: c.weeklyTurnover.slice(from, k).reduce((a, b) => a + b, 0),
      total: compound(rets),
      score: scoreWindow(rets, rule.halfLife, o.profile),
      maxDD: maxDrawdownFromReturns(rets),
      blocks: blocksPositive(rets),
      sr: sharpe(daily),
    };
  });
  // Ambang Deflated Sharpe: setinggi apa Sharpe juara bila semua kandidat sebenarnya tanpa edge.
  const active = base.filter((b) => b.entries > 0);
  const mean = active.reduce((a, b) => a + b.sr, 0) / Math.max(1, active.length);
  const variance = active.reduce((a, b) => a + (b.sr - mean) ** 2, 0) / Math.max(1, active.length - 1);
  const emax = expectedMaxSharpe(active.length, variance);
  const byFamily = new Map<string, typeof base>();
  for (const b of base) {
    const arr = byFamily.get(b.c.familyKey) ?? [];
    arr.push(b);
    byFamily.set(b.c.familyKey, arr);
  }
  const evals = base.map((b) => ({
    c: b.c,
    score: b.score,
    total: b.total,
    rets: b.rets,
    entries: b.entries,
    turnover: b.turnover,
    maxDD: b.maxDD,
    psr: psr(b.daily, 0),
    dsr: psr(b.daily, emax),
    blocks: b.blocks,
    neighbor: median((byFamily.get(b.c.familyKey) ?? []).filter((x) => x !== b).map((x) => x.total)),
  }));
  return { evals, emax };
}

// Indeks gerbang (urutan FUNNEL) yang pertama gagal, atau -1 bila lolos semua.
export function failedGate(e: WindowEval, g: Gate, o: TournamentOptions): number {
  const perSide = o.cost.feeRate + o.cost.slippage;
  if (!Number.isFinite(e.score) || e.entries < g.minEntries) return 0;
  if (g.requireProfit && (e.total <= 0 || e.score <= 0)) return 1;
  if (e.blocks < g.minBlocks) return 2;
  if (e.psr < g.minPsr || (g.minDsr !== null && e.dsr < g.minDsr)) return 3;
  if (g.costStress !== null && e.total - e.turnover * perSide * (g.costStress - 1) <= 0) return 4;
  if (g.neighborFloor !== null && e.neighbor !== null && e.neighbor < g.neighborFloor) return 5;
  if (g.ddMult !== null && e.maxDD > o.profile.drawdownCap * g.ddMult) return 6;
  return -1;
}

// Pilih juara untuk minggu k memakai data minggu sebelum k saja. Mulai dari gerbang paling ketat,
// longgarkan hanya bila tidak ada satu pun kandidat yang lolos.
export function selectPicks(cands: Candidate[], k: number, rule: Rule, o: TournamentOptions): Selection {
  const { evals, emax } = evaluateWindow(cands, k, rule, o);
  for (const g of GATES) {
    const qualified = evals.filter((e) => failedGate(e, g, o) === -1).sort((a, b) => b.score - a.score);
    const picks: WindowEval[] = [];
    const used = new Set<string>();
    for (const e of qualified) {
      if (picks.length >= o.profile.strategySlots) break;
      if (used.has(e.c.diversityKey)) continue;
      if (picks.length > 0 && e.score <= 0) break;
      used.add(e.c.diversityKey);
      picks.push(e);
    }
    if (!picks.length) continue;
    // Bobot ~ skor^(1/konsentrasi): profil berani menumpuk modal ke juara.
    const pow = 1 / o.profile.concentration;
    const raw = picks.map((p) => Math.max(p.score, 1e-9) ** pow);
    const total = raw.reduce((a, b) => a + b, 0);
    return { picks: picks.map((p, i) => ({ candidate: p.c, score: p.score, weight: raw[i] / total })), level: g.id, evals, emax };
  }
  return { picks: [], level: 3, evals, emax };
}

export function runTournament(d: Dataset, o: TournamentOptions, now = Date.now()): TournamentRun {
  const { candidates, weeks } = buildCandidates(d, o);
  let K = weeks.length;
  while (K > 0 && !weeks[K - 1].complete) K--;
  const warmup = o.warmupWeeks ?? 2;
  const rules = (o.rules ?? RULES).filter((r) => r.lookback <= Math.max(4, o.lookbackWeeks));
  const M = o.metaWeeks ?? 8;
  const defaultRule = rules.find((r) => r.id === DEFAULT_RULE) ?? rules[rules.length - 1];

  const bench = d.series[o.benchmark] ? o.benchmark : d.coins[0];
  const benchWeekly = weeks.map((w, k) => {
    const c = d.series[bench].c;
    const base = k === 0 ? c[w.first] : c[weeks[k - 1].last];
    return c[w.last] / base - 1;
  });

  // Hasil out-of-sample tiap aturan per minggu.
  type RuleWeek = { ret: number; label: string; id: string; level: QualificationLevel };
  const evalStart = Math.max(warmup + 4, K - o.walkForwardWeeks);
  const ruleStart = Math.max(warmup + 4, evalStart - M);
  const ruleWeeks = new Map<string, Map<number, RuleWeek>>();
  for (const r of rules) {
    const m = new Map<number, RuleWeek>();
    for (let k = ruleStart; k < K; k++) {
      const sel = selectPicks(candidates, k, r, o);
      m.set(k, {
        ret: sel.picks.reduce((a, p) => a + p.weight * p.candidate.weekly[k], 0),
        id: sel.picks[0]?.candidate.id ?? 'flat',
        label: sel.picks.length ? sel.picks[0].candidate.label + (sel.picks.length > 1 ? ` +${sel.picks.length - 1}` : '') : 'Tidak trading',
        level: sel.level,
      });
    }
    ruleWeeks.set(r.id, m);
  }

  // Aturan terbaik untuk minggu k = skor tertinggi atas hasil OOS-nya pada M minggu sebelum k.
  const chooseRule = (k: number): Rule => {
    const from = Math.max(ruleStart, k - M);
    if (k - from < 3) return defaultRule;
    let best = defaultRule;
    let bestScore = -Infinity;
    for (const r of rules) {
      const rets: number[] = [];
      for (let j = from; j < k; j++) rets.push(ruleWeeks.get(r.id)!.get(j)!.ret);
      const s = scoreWindow(rets, 4, o.profile);
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
    }
    return best;
  };

  const policyWeeks: PolicyReport['weeks'] = [];
  for (let k = evalStart; k < K; k++) {
    const r = chooseRule(k);
    const w = ruleWeeks.get(r.id)!.get(k)!;
    policyWeeks.push({ weekStart: weeks[k].start, pickedId: w.id, pickedLabel: w.label, rule: r.label, level: w.level, ret: w.ret, benchmark: benchWeekly[k] });
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

  const rule = chooseRule(K);
  const ruleReports: RuleReport[] = rules.map((r) => {
    const rets: number[] = [];
    for (let k = evalStart; k < K; k++) rets.push(ruleWeeks.get(r.id)!.get(k)!.ret);
    return { id: r.id, label: r.label, lookback: r.lookback, halfLife: r.halfLife, oosReturn: compound(rets), maxDrawdown: maxDrawdownFromReturns(rets), winRateWeeks: winRate(rets), chosen: r.id === rule.id };
  });

  // Pilihan minggu depan dengan aturan terpilih.
  const sel = selectPicks(candidates, K, rule, o);
  const gate = GATES[sel.level];
  const funnel = [{ label: 'Diuji', remaining: sel.evals.length }];
  FUNNEL.forEach((label, i) =>
    funnel.push({
      label,
      remaining: sel.evals.filter((e) => {
        const f = failedGate(e, gate, o);
        return f === -1 || f > i;
      }).length,
    }),
  );
  const entries: TournamentEntry[] = sel.evals
    .map((e) => {
      const f = failedGate(e, gate, o);
      return {
        id: e.c.id,
        strategy: e.c.strategy.id,
        label: e.c.label,
        params: e.c.params,
        universe: e.c.universe,
        score: Number.isFinite(e.score) ? e.score : -1,
        stats: {
          totalReturn: e.total,
          lastWeek: e.rets[e.rets.length - 1] ?? 0,
          maxDrawdown: e.maxDD,
          sharpe: weeklySharpe(e.rets),
          winRateWeeks: winRate(e.rets),
          trades: e.entries,
          exposure: e.c.exposure,
        },
        gate: { passed: f === -1, failed: f === -1 ? undefined : FUNNEL[f], psr: e.psr, dsr: e.dsr },
        weeklyReturns: e.rets,
      };
    })
    .sort((a, b) => Number(b.gate.passed) - Number(a.gate.passed) || b.score - a.score);

  const qualification: QualificationReport = {
    level: sel.level,
    levelLabel: gate.label,
    tested: sel.evals.length,
    qualified: funnel[funnel.length - 1].remaining,
    expectedMaxSharpe: sel.emax * Math.sqrt(365),
    funnel,
    universe: d.coins,
    expanded: o.expanded ?? false,
  };

  return {
    report: {
      ranAt: now,
      interval: d.interval,
      lookbackWeeks: Math.min(rule.lookback, K - warmup),
      dataFrom: d.t[0],
      dataTo: d.t[d.t.length - 1],
      benchmarkCoin: bench,
      entries,
      policy,
      rules: ruleReports,
      chosenRule: rule.label,
      qualification,
      synthetic: d.synthetic,
    },
    candidates,
    weeks,
    picks: sel.picks,
    rule,
    level: sel.level,
  };
}

export function describePolicyEdge(p: PolicyReport): string {
  const edge = p.totalReturn - p.benchmarkReturn;
  return `Rotasi mingguan ${fmtPct(p.totalReturn)} vs buy & hold ${fmtPct(p.benchmarkReturn)} (selisih ${fmtPct(edge)}), max DD ${fmtPct(-p.maxDrawdown)}, minggu profit ${(p.winRateWeeks * 100).toFixed(0)}%, std mingguan ${fmtPct(std(p.weeks.map((w) => w.ret)))}`;
}

export function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}

import type { LeaderView, ScoutSummary } from '../../shared/types';
import { runTournament, type TournamentOptions, type TournamentRun } from './backtest/tournament';
import type { Config } from './config';
import type { MarketHistory } from './data/market';
import type { RiskProfile } from './risk/profiles';
import type { ScoutOptions, ScoutResult } from './scout/hyperliquidScout';

export const META_WEEKS = 8;

export interface SelectionDeps {
  cfg: Config;
  market: MarketHistory;
  profile: RiskProfile;
  feeRate: number;
  scout: ((o: ScoutOptions) => Promise<ScoutResult>) | null;
  supports: (coin: string) => boolean;
  log: (m: string) => void;
  now: number;
}

export interface SelectionResult {
  run: TournamentRun;
  leaders: LeaderView[] | null; // null = scout tidak jalan / gagal
  scout: ScoutSummary | null;
  failedCoins: string[];
  scoutError?: string;
}

// Seleksi mingguan lengkap: turnamen strategi (diperluas ke koin paling likuid bila kandidat yang
// lolos saringan ketat tidak ada) lalu scout trader. Dipakai engine dan perintah `hunt`.
export async function runSelection(x: SelectionDeps): Promise<SelectionResult> {
  const { cfg, market, log } = x;
  const weeks = cfg.lookbackWeeks + cfg.walkForwardWeeks + META_WEEKS + 3;
  const opts = (funding?: Record<string, Float64Array>, expanded = false): TournamentOptions => ({
    profile: x.profile,
    lookbackWeeks: cfg.lookbackWeeks,
    walkForwardWeeks: cfg.walkForwardWeeks,
    metaWeeks: META_WEEKS,
    benchmark: cfg.benchmark,
    cost: { feeRate: x.feeRate, slippage: 0.0003, funding },
    expanded,
  });

  log(`Turnamen: ${cfg.universe.length} koin, ${weeks} minggu candle ${cfg.strategyInterval}`);
  const base = await market.dataset(cfg.universe, cfg.strategyInterval, weeks);
  let run = runTournament(base.d, opts(base.funding), x.now);
  let failed = base.failed;
  log(`  saringan ${run.report.qualification.levelLabel}: ${run.report.qualification.qualified}/${run.report.qualification.tested} lolos`);

  // Tidak ada kandidat yang lolos saringan Ketat -> cari di koin likuid lain sebelum menerima bukti yang lebih lemah.
  if (run.level >= 1 && market.topCoins) {
    try {
      const top = await market.topCoins(25);
      const extra = top.filter((c) => !cfg.universe.includes(c));
      if (extra.length) {
        log(`  memperluas ke ${extra.length} koin likuid lain: ${extra.join(', ')}`);
        const wide = await market.dataset([...cfg.universe, ...extra], cfg.strategyInterval, weeks);
        const run2 = runTournament(wide.d, opts(wide.funding, true), x.now);
        log(`  hasil perluasan: saringan ${run2.report.qualification.levelLabel}, ${run2.report.qualification.qualified}/${run2.report.qualification.tested} lolos`);
        const better = run2.level < run.level || (run2.level === run.level && (run2.picks[0]?.score ?? -Infinity) > (run.picks[0]?.score ?? -Infinity));
        if (better) {
          run = run2;
          failed = wide.failed;
        }
      }
    } catch (e) {
      log(`  perluasan koin gagal: ${e instanceof Error ? e.message : e}`);
    }
  }

  let leaders: LeaderView[] | null = null;
  let scout: ScoutSummary | null = null;
  let scoutError: string | undefined;
  if (x.scout) {
    try {
      const r = await x.scout({ ...cfg.scout, slots: x.profile.leaderSlots, concentration: x.profile.concentration, supports: x.supports });
      leaders = r.leaders;
      scout = r.summary;
      log(`Scout: ${r.summary.analyzed} trader dianalisis dalam ${r.summary.rounds} putaran, ${r.summary.qualified} lolos (saringan ${r.summary.levelLabel})`);
    } catch (e) {
      scoutError = e instanceof Error ? e.message : String(e);
    }
  }
  return { run, leaders, scout, failedCoins: failed, scoutError };
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startApi } from './api/server';
import { describePolicyEdge, fmtPct, runTournament } from './backtest/tournament';
import { BINANCE_LEADER_ID, loadConfig } from './config';
import { Engine } from './copy/engine';
import { RealMarket } from './data/market';
import { DemoWorld } from './demo/world';
import { BinanceFeed, HyperliquidFeed } from './exchanges/feeds';
import { BinanceLiveBroker, HyperliquidLiveBroker } from './exchanges/live';
import { PaperBroker } from './exchanges/paper';
import type { Broker } from './exchanges/types';
import { HOUR, sleep, WEEK } from './lib/time';
import { RISK_PROFILES } from './risk/profiles';
import { runScout } from './scout/hyperliquidScout';
import { BinanceAccountLeader, HyperliquidWalletLeader } from './sources/leaders';
import { Store } from './store';

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

function makeBroker(cfg: ReturnType<typeof loadConfig>): Broker {
  const fee = cfg.venue === 'hyperliquid' ? 0.00045 : 0.0005;
  if (cfg.mode === 'live') {
    return cfg.venue === 'binance' ? new BinanceLiveBroker(cfg.binance) : new HyperliquidLiveBroker(cfg.hyperliquid);
  }
  const feed = cfg.venue === 'binance' ? new BinanceFeed() : new HyperliquidFeed();
  return new PaperBroker(cfg.venue, feed, {
    startEquity: cfg.paperStartEquity,
    feeRate: fee,
    slippage: 0.0003,
    file: join(cfg.dataDir, 'state', 'paper-account.json'),
  });
}

// Dunia demo: jam virtual dimulai beberapa minggu lalu, lalu dipercepat sampai "sekarang".
async function buildDemo(cfg: ReturnType<typeof loadConfig>, store: Store, warmWeeks: number) {
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  const world = new DemoWorld({ seed: 1, start: now - warmWeeks * WEEK, historyWeeks: 46, futureWeeks: warmWeeks + 2 });
  const broker = new PaperBroker('hyperliquid', world, { startEquity: cfg.paperStartEquity, feeRate: 0.00045, slippage: 0.0003, clock: world.clock });
  const engine = new Engine({
    cfg: { ...cfg, universe: (await world.listCoins()), manualLeaders: [] },
    broker,
    store,
    market: world,
    clock: world.clock,
    leaderSource: world.leaderSource,
    scout: world.scout,
    synthetic: true,
    log: () => {},
  });
  await engine.start();
  const steps = warmWeeks * 168;
  for (let i = 0; i < steps; i++) {
    await engine.tick();
    world.advance(HOUR);
    if (i % 168 === 0) log(`  demo: minggu ${i / 168 + 1}/${warmWeeks}`);
  }
  return { world, engine, now };
}

async function main() {
  const [cmd = 'run', ...args] = process.argv.slice(2);
  const demo = args.includes('--demo') || cmd === 'demo-snapshot';
  const cfg = loadConfig(demo ? { MODE: 'demo' } : {});

  if (cmd === 'tournament') {
    const market = new RealMarket(join(cfg.dataDir, 'cache'), log);
    const weeks = cfg.lookbackWeeks + cfg.walkForwardWeeks + 3;
    log(`Mengunduh ${weeks} minggu candle ${cfg.strategyInterval} untuk ${cfg.universe.join(', ')}…`);
    const { d, funding, failed } = await market.dataset(cfg.universe, cfg.strategyInterval, weeks);
    if (failed.length) log(`Tanpa data: ${failed.join(', ')}`);
    const profile = RISK_PROFILES[cfg.riskProfile];
    const run = runTournament(d, {
      profile,
      lookbackWeeks: cfg.lookbackWeeks,
      walkForwardWeeks: cfg.walkForwardWeeks,
      benchmark: cfg.benchmark,
      cost: { feeRate: cfg.venue === 'hyperliquid' ? 0.00045 : 0.0005, slippage: 0.0003, funding },
    });
    console.log(`\nTURNAMEN STRATEGI · profil ${profile.label} · ${run.candidates.length} kandidat · ${run.report.lookbackWeeks} minggu terakhir\n`);
    console.log('Rank  Skor     12m-ret  Mgg-lalu  MaxDD   Sharpe  Entri  Strategi');
    run.report.entries.slice(0, 20).forEach((e, i) => {
      console.log(
        `${String(i + 1).padStart(4)}  ${e.score.toFixed(4).padStart(7)}  ${fmtPct(e.stats.totalReturn).padStart(7)}  ${fmtPct(e.stats.lastWeek).padStart(8)}  ${fmtPct(-e.stats.maxDrawdown).padStart(6)}  ${e.stats.sharpe.toFixed(2).padStart(6)}  ${String(e.stats.trades).padStart(5)}  ${e.label}`,
      );
    });
    console.log(`\nPilihan minggu depan:`);
    for (const p of run.picks) console.log(`  ${(p.weight * 100).toFixed(0)}%  ${p.candidate.label}`);
    console.log(`\nValidasi out-of-sample (${run.report.policy.weeks.length} minggu): ${describePolicyEdge(run.report.policy)}`);
    const store = new Store(join(cfg.dataDir, 'state'));
    store.writeJson('tournament', run.report);
    return;
  }

  if (cmd === 'scout') {
    const profile = RISK_PROFILES[cfg.riskProfile];
    const leaders = await runScout({ ...cfg.scout, slots: profile.leaderSlots, concentration: profile.concentration }, log);
    console.log('\nStatus     Skor  Bobot  ROI-7h   ROI-30h  WinRate  DD-30h  Fill/h  Trader');
    for (const l of leaders.slice(0, 25)) {
      console.log(
        `${l.status.padEnd(9)}  ${l.score.toFixed(2)}  ${(l.weight * 100).toFixed(0).padStart(4)}%  ${fmtPct(l.weekRoi).padStart(7)}  ${fmtPct(l.monthRoi).padStart(7)}  ${l.winRate === null ? '   -' : `${(l.winRate * 100).toFixed(0)}%`.padStart(6)}  ${l.maxDrawdown === null ? '   -' : fmtPct(-l.maxDrawdown).padStart(6)}  ${l.fillsPerDay?.toFixed(0).padStart(6)}  ${l.label} ${l.address}${l.reason ? `\n           ↳ ${l.reason}` : ''}`,
      );
    }
    return;
  }

  if (cmd === 'demo-snapshot') {
    const out = resolve(args.find((a) => a.startsWith('--out='))?.slice(6) ?? join(cfg.root, 'dashboard/src/demo/snapshot.json'));
    log('Mensimulasikan 6 minggu di pasar sintetis…');
    const { engine } = await buildDemo(cfg, new Store(null), 6);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(engine.snapshot()));
    log(`Snapshot demo ditulis ke ${out}`);
    return;
  }

  if (cmd === 'run') {
    let engine: Engine;
    let advance: (() => void) | null = null;
    if (demo) {
      log('MODE DEMO — pasar & trader SINTETIS, tidak ada koneksi ke bursa.');
      const built = await buildDemo(cfg, new Store(null), 3);
      engine = built.engine;
      // Setiap tick nyata memajukan jam virtual 10 menit supaya dashboard terlihat hidup.
      advance = () => built.world.advance(10 * 60_000);
    } else {
      const store = new Store(join(cfg.dataDir, 'state'));
      const broker = makeBroker(cfg);
      engine = new Engine({
        cfg,
        broker,
        store,
        market: new RealMarket(join(cfg.dataDir, 'cache'), log),
        clock: Date.now,
        leaderSource: (address, label) =>
          address === BINANCE_LEADER_ID && cfg.binanceLeader
            ? new BinanceAccountLeader(address, 'Akun Binance (read-only)', cfg.binanceLeader.apiKey, cfg.binanceLeader.apiSecret)
            : new HyperliquidWalletLeader(address, label),
        scout: (o) => runScout(o, log),
        synthetic: false,
        log,
      });
      await engine.start();
    }
    startApi(engine, { ...cfg.api, staticDir: join(cfg.root, 'dashboard/dist'), log });
    const tickMs = demo ? 2000 : cfg.tickSeconds * 1000;
    let stopping = false;
    process.on('SIGINT', () => {
      stopping = true;
      log('Berhenti… (posisi TIDAK ditutup otomatis)');
      setTimeout(() => process.exit(0), 500);
    });
    while (!stopping) {
      const t0 = Date.now();
      await engine.tick();
      advance?.();
      await sleep(Math.max(250, tickMs - (Date.now() - t0)));
    }
    return;
  }

  console.log('Perintah: run [--demo] | tournament | scout | demo-snapshot [--out=path]');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

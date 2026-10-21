import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startApi } from './api/server';
import { BINANCE_LEADER_ID, loadConfig } from './config';
import { Engine } from './copy/engine';
import { type MarketHistory, RealMarket } from './data/market';
import { DemoWorld } from './demo/world';
import { BinanceFeed, HyperliquidFeed } from './exchanges/feeds';
import { BinanceLiveBroker, HyperliquidLiveBroker } from './exchanges/live';
import { PaperBroker } from './exchanges/paper';
import type { Broker } from './exchanges/types';
import { HOUR, sleep, WEEK } from './lib/time';
import { RISK_PROFILES } from './risk/profiles';
import { hyperliquidSource, runScout, type ScoutOptions, type ScoutResult } from './scout/hyperliquidScout';
import { printScout, printTournament, printVerdict } from './report';
import { runSelection } from './weekly';
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

  if (cmd === 'tournament' || cmd === 'hunt') {
    // hunt = turnamen strategi + scout trader, sama persis dengan siklus Senin di engine.
    const profile = RISK_PROFILES[cfg.riskProfile];
    let market: MarketHistory = new RealMarket(join(cfg.dataDir, 'cache'), log);
    let scout: ((o: ScoutOptions) => Promise<ScoutResult>) | null = cmd === 'hunt' ? (o) => runScout(o, hyperliquidSource(), log) : null;
    let now = Date.now();
    let universe = cfg.universe;
    if (args.includes('--demo')) {
      log('DEMO: pasar & trader sintetis.');
      const world = new DemoWorld({ seed: 1, start: Math.floor(now / HOUR) * HOUR, historyWeeks: 52, futureWeeks: 1 });
      market = world;
      scout = cmd === 'hunt' ? world.scout : null;
      now = world.clock();
      universe = await world.listCoins();
    }
    const sel = await runSelection({
      cfg: { ...cfg, universe },
      market,
      profile,
      feeRate: cfg.venue === 'hyperliquid' ? 0.00045 : 0.0005,
      scout,
      supports: () => true,
      log,
      now,
    });
    if (sel.failedCoins.length) log(`Tanpa data: ${sel.failedCoins.join(', ')}`);
    printTournament(sel.run);
    if (sel.scoutError) log(`Scout gagal: ${sel.scoutError}`);
    if (sel.leaders) printScout(sel.leaders, sel.scout);
    printVerdict(sel.run, sel.leaders, cfg.allocStrategy);
    if (!args.includes('--demo')) {
      const store = new Store(join(cfg.dataDir, 'state'));
      store.writeJson('tournament', sel.run.report);
      if (sel.leaders) {
        store.writeJson('leaders', sel.leaders);
        store.writeJson('scout', sel.scout);
      }
      log('Hasil disimpan di data/state; engine memakainya sampai siklus Senin berikutnya.');
    }
    return;
  }

  if (cmd === 'scout') {
    const profile = RISK_PROFILES[cfg.riskProfile];
    const r = await runScout({ ...cfg.scout, slots: profile.leaderSlots, concentration: profile.concentration }, hyperliquidSource(), log);
    printScout(r.leaders, r.summary);
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
        scout: (o) => runScout(o, hyperliquidSource(), log),
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

  console.log('Perintah: run [--demo] | hunt [--demo] | tournament [--demo] | scout | demo-snapshot [--out=path]');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  DashboardSnapshot,
  EngineAlert,
  EquityPoint,
  FundingEntry,
  LeaderView,
  Playbook,
  PositionView,
  ProvenanceView,
  ReplayView,
  RiskProfileId,
  ScoutSummary,
  StatementView,
  TournamentReport,
  TradeView,
} from '../../../shared/types';
import type { Config } from '../config';
import type { MarketHistory } from '../data/market';
import type { Broker, BrokerPosition, Fill } from '../exchanges/types';
import { nextWeekStart, WEEK, weekStart } from '../lib/time';
import { resolveProfile } from '../risk/profiles';
import { RiskManager, type RiskPersisted } from '../risk/riskManager';
import type { ScoutOptions, ScoutResult } from '../scout/hyperliquidScout';
import type { FetchInputs } from '../scout/vet';
import { runSelection } from '../weekly';
import type { LeaderSnapshot, LeaderSource } from '../sources/leaders';
import type { Store } from '../store';
import { auditLedger } from '../backtest/copyReplay';
import { capTargets, computeTargets, planOrders } from './mirror';
import { StrategySleeve } from './strategySleeve';

export interface EngineDeps {
  cfg: Config;
  broker: Broker;
  store: Store;
  market: MarketHistory;
  clock: () => number;
  leaderSource: (address: string, label?: string) => LeaderSource;
  scout: (o: ScoutOptions) => Promise<ScoutResult>;
  // Uji salin historis kandidat scout (tidak ada di mode demo).
  vetInputs?: (days: number) => FetchInputs;
  synthetic: boolean;
  log?: (m: string) => void;
}

interface Baseline {
  // Untuk ENTRY_POLICY=new-only: posisi leader yang sudah terbuka saat mulai disalin diabaikan
  // sampai posisi itu ditutup atau berbalik arah.
  [leader: string]: Record<string, number>;
}

const EQUITY_SAMPLE_MS = 60_000;
const MAX_EQUITY_POINTS = 20_000;

export class Engine extends EventEmitter {
  private risk: RiskManager;
  private sleeve: StrategySleeve;
  private playbook: Playbook | null;
  private tournament: TournamentReport | null;
  private leaders: LeaderView[];
  private scoutSummary: ScoutSummary | null;
  private sources = new Map<string, LeaderSource>();
  private lastSnap = new Map<string, LeaderSnapshot>();
  private firstFail = new Map<string, number>();
  private goneAlerted = new Set<string>();
  private baseline: Baseline;
  private equity: EquityPoint[];
  private trades: TradeView[];
  private fundingLog: FundingEntry[];
  private statement: StatementView | null = null;
  private files: ProvenanceView['files'] = [];
  private lastAudit = -Infinity;
  private replay: ReplayView | null;
  private codeVersion: string | null = null;
  private alerts: EngineAlert[] = [];
  private state: 'running' | 'paused' | 'halted' | 'starting' = 'starting';
  private startedAt: number;
  private lastTick = 0;
  private tickMs = 0;
  private cycleRunning = false;
  private cycleRetryAt = 0;
  private lastEquity = 0;
  private lastPositions: Record<string, BrokerPosition> = {};
  private lastMarks: Record<string, number> = {};
  private lastSources: Record<string, string[]> = {};
  private leaderLag: number | null = null;
  private startEquity: number;

  constructor(private d: EngineDeps) {
    super();
    const { store, cfg } = d;
    const profileId = store.readJson<{ profile?: RiskProfileId }>('settings', {}).profile ?? cfg.riskProfile;
    this.risk = new RiskManager(resolveProfile(profileId, cfg.copyMultiplier), store.readJson<RiskPersisted>('risk', RiskManager.fresh(0, d.clock())));
    this.sleeve = new StrategySleeve(d.market, cfg.strategyInterval, this.risk.profile);
    this.playbook = store.readJson<Playbook | null>('playbook', null);
    this.tournament = store.readJson<TournamentReport | null>('tournament', null);
    this.leaders = store.readJson<LeaderView[]>('leaders', []);
    this.scoutSummary = store.readJson<ScoutSummary | null>('scout', null);
    this.baseline = store.readJson<Baseline>('baseline', {});
    this.equity = store.readJsonl<EquityPoint>('equity', MAX_EQUITY_POINTS);
    this.trades = store.readJsonl<TradeView>('trades', 500);
    this.fundingLog = store.readJsonl<FundingEntry>('funding', 500);
    this.replay = store.readJson<ReplayView | null>('replay', null);
    try {
      this.codeVersion = execSync('git rev-parse --short HEAD', { cwd: cfg.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      this.codeVersion = null;
    }
    this.startEquity = store.readJson<{ startEquity?: number }>('settings', {}).startEquity ?? 0;
    this.startedAt = d.clock();
    if (this.playbook?.appliedAt) this.activate(this.playbook, false);
  }

  private log(m: string) {
    this.d.log?.(m);
  }

  private alert(level: EngineAlert['level'], message: string) {
    const a = { t: this.d.clock(), level, message };
    this.alerts = [a, ...this.alerts].slice(0, 60);
    this.log(`[${level}] ${message}`);
    this.d.store.appendJsonl('alerts', a);
  }

  async start() {
    await this.d.broker.init();
    const eq = await this.d.broker.equity();
    if (!this.startEquity) {
      this.startEquity = eq;
      this.saveSettings();
    }
    if (!this.risk.s.weekStartEquity) this.risk.s = RiskManager.fresh(eq, this.d.clock());
    this.lastEquity = eq;
    this.state = this.risk.s.haltedUntil ? 'halted' : 'running';
    this.alert('info', `Engine aktif · ${this.d.cfg.mode.toUpperCase()} · ${this.d.broker.venue} · profil ${this.risk.profile.label}`);
  }

  // ---------------------------------------------------------------- siklus mingguan

  async runWeeklyCycle(reason = 'jadwal mingguan') {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    const { cfg } = this.d;
    const now = this.d.clock();
    try {
      this.alert('info', `Menjalankan seleksi mingguan (${reason})…`);
      const sel = await runSelection({
        cfg,
        market: this.d.market,
        profile: this.risk.profile,
        feeRate: this.d.broker.venue === 'hyperliquid' ? 0.00045 : 0.0005,
        scout: cfg.autoScout ? this.d.scout : null,
        supports: (c) => this.d.broker.supports(c),
        log: (m) => this.log(m),
        now,
        skipTournament: cfg.allocStrategy === 0,
        vetInputs: this.d.vetInputs ?? null,
      });
      const { run } = sel;
      if (sel.failedCoins.length) this.alert('warn', `Data tidak tersedia untuk: ${sel.failedCoins.join(', ')}`);
      if (run) {
        const q = run.report.qualification;
        this.alert(
          q.level >= 2 ? 'warn' : 'info',
          `Turnamen: ${q.qualified} dari ${q.tested} kandidat lolos saringan ${q.levelLabel}${q.expanded ? ' (universe diperluas)' : ''}; aturan seleksi terpilih ${run.report.chosenRule}.`,
        );
        this.tournament = run.report;
        this.d.store.writeJson('tournament', run.report);
      } else this.alert('info', 'Porsi strategi 0%: turnamen dilewati, 100% modal untuk copy trader.');

      let leaders: LeaderView[] = [];
      if (sel.scoutError) {
        this.alert('warn', `Scout leader gagal: ${sel.scoutError}. Memakai leader minggu lalu.`);
        leaders = this.leaders;
      } else if (sel.leaders) {
        leaders = sel.leaders;
        this.scoutSummary = sel.scout;
        this.d.store.writeJson('scout', sel.scout);
      }
      leaders = this.mergeManualLeaders(leaders);
      this.leaders = leaders;
      this.d.store.writeJson('leaders', leaders);

      const copying = leaders.filter((l) => l.status === 'copying' && l.weight > 0);
      const strategies = (run?.picks ?? []).map((p) => ({ id: p.candidate.id, label: p.candidate.label, weight: p.weight, universe: p.candidate.universe }));
      const allocation =
        !copying.length && !strategies.length
          ? { strategy: 0, copy: 0 }
          : !copying.length
            ? { strategy: 1, copy: 0 }
            : !strategies.length
              ? { strategy: 0, copy: 1 }
              : { strategy: cfg.allocStrategy, copy: 1 - cfg.allocStrategy };
      // Siklus: Senin–Senin UTC (default) atau 7 hari sejak sekarang (CYCLE_ANCHOR=start).
      const ws = cfg.cycleAnchor === 'start' ? now : weekStart(now);
      const notes: string[] = [];
      if (run?.picks[0]) notes.push(`Juara strategi: ${run.picks[0].candidate.label} (skor ${run.picks[0].score.toFixed(4)}, saringan ${run.report.qualification.levelLabel})`);
      if (run) {
        notes.push(
          `Uji rotasi ${run.report.policy.weeks.length} minggu: ${(run.report.policy.totalReturn * 100).toFixed(1)}% vs ${run.report.benchmarkCoin} ${(run.report.policy.benchmarkReturn * 100).toFixed(1)}%`,
        );
      } else notes.push('Mode copy penuh: 100% modal mengikuti trader terpilih.');
      if (copying.length) notes.push(`${copying.length} trader Hyperliquid disalin`);
      const pb: Playbook = {
        weekStart: ws,
        weekEnd: ws + WEEK,
        createdAt: now,
        appliedAt: null,
        riskProfile: this.risk.profile.id,
        allocation,
        strategies,
        leaders: copying.map((l) => ({ address: l.address, label: l.label, weight: l.weight })),
        notes,
      };
      this.playbook = pb;
      if (cfg.autoApplyPlaybook) this.activate(pb, true);
      else this.alert('info', 'Playbook baru menunggu persetujuan di dashboard.');
      this.d.store.writeJson('playbook', this.playbook);
    } catch (e) {
      this.alert('critical', `Seleksi mingguan gagal: ${e instanceof Error ? e.message : e}. Dicoba lagi dalam 15 menit; playbook lama tetap dipakai.`);
      this.cycleRetryAt = now + 15 * 60_000;
    } finally {
      this.cycleRunning = false;
    }
  }

  private mergeManualLeaders(list: LeaderView[]): LeaderView[] {
    const manual = this.d.cfg.manualLeaders.map((a) => a.toLowerCase());
    if (!manual.length) return list;
    const out = list.map((l) => ({ ...l }));
    const copyingCount = out.filter((l) => l.status === 'copying').length;
    const share = 1 / (manual.length + copyingCount);
    for (const l of out) if (l.status === 'copying') l.weight *= 1 - share * manual.length;
    for (const addr of manual) {
      const existing = out.find((l) => l.address === addr);
      if (existing) {
        existing.weight += share;
        existing.status = 'copying';
        existing.reason = undefined;
      } else {
        // Wallet manual yang pernah dianalisis (mis. lewat `npm run hunt`) tetap membawa metriknya.
        const known = this.leaders.find((l) => l.address === addr);
        if (known) {
          out.unshift({ ...known, weight: share, status: 'copying', reason: undefined });
          continue;
        }
        out.unshift({
          address: addr,
          label: addr.startsWith('0x') ? `${addr.slice(0, 6)}…${addr.slice(-4)} (manual)` : 'Akun Binance (read-only)',
          accountValue: 0,
          weekRoi: 0,
          monthRoi: 0,
          allTimePnl: 0,
          winRate: null,
          maxDrawdown: null,
          fillsPerDay: null,
          holdHours: null,
          scalpShare: null,
          positiveDays: null,
          score: 0,
          weight: share,
          status: 'copying',
          openPositions: 0,
        });
      }
    }
    return out;
  }

  private activate(pb: Playbook, fresh: boolean) {
    pb.appliedAt = pb.appliedAt ?? this.d.clock();
    this.playbook = pb;
    const entries = this.tournament?.entries ?? [];
    this.sleeve.setPlaybook(pb, entries);
    const keep = new Set(pb.leaders.map((l) => l.address));
    for (const id of [...this.sources.keys()]) if (!keep.has(id)) this.sources.delete(id);
    for (const l of pb.leaders) if (!this.sources.has(l.address)) this.sources.set(l.address, this.d.leaderSource(l.address, l.label));
    for (const id of Object.keys(this.baseline)) if (!keep.has(id)) delete this.baseline[id];
    if (fresh) this.alert('info', `Playbook minggu ini aktif: ${pb.strategies.length} strategi, ${pb.leaders.length} leader.`);
    this.d.store.writeJson('playbook', pb);
  }

  applyPendingPlaybook() {
    if (this.playbook && !this.playbook.appliedAt) this.activate(this.playbook, true);
  }

  // ---------------------------------------------------------------- tick

  async tick() {
    const t0 = Date.now();
    const now = this.d.clock();
    try {
      if ((!this.playbook || this.playbook.weekEnd <= now) && now >= this.cycleRetryAt) await this.runWeeklyCycle(this.playbook ? 'minggu baru' : 'start pertama');

      // Funding (paper): dibebankan per slot dengan tarif & harga mark asli, dicatat ke ledger.
      const funding = (await this.d.broker.settleFunding?.(now)) ?? [];
      for (const f of funding) {
        this.fundingLog = [...this.fundingLog, f].slice(-500);
        this.d.store.appendJsonl('funding', f);
      }

      const [equity, positions] = await Promise.all([this.d.broker.equity(), this.d.broker.positions()]);
      this.lastEquity = equity;
      this.lastPositions = positions;

      const r = this.risk.update(equity, now, this.d.cfg.cycleAnchor === 'start' && this.playbook ? { start: this.playbook.weekStart, end: this.playbook.weekEnd } : undefined);
      if (r === 'halt') {
        this.alert('critical', `Kill switch: rugi minggu ini ${(this.risk.lossFraction(equity) * 100).toFixed(1)}% ≥ batas ${(this.risk.profile.weeklyLossLimit * 100).toFixed(0)}%. Semua posisi ditutup sampai Senin.`);
        await this.flatten('kill switch');
        this.state = 'halted';
      } else if (r === 'ok' && this.state === 'halted') {
        this.state = 'running';
        this.alert('info', 'Minggu baru: kill switch direset, trading dilanjutkan.');
      }
      this.d.store.writeJson('risk', this.risk.s);

      if (this.state === 'running' && this.playbook?.appliedAt) await this.rebalance(now, equity, positions);
      else this.lastMarks = await this.d.broker.markPrices(Object.keys(positions));

      this.recordEquity(now, this.state === 'running' ? await this.d.broker.equity() : equity);
      if (now - this.lastAudit >= 60_000) await this.audit(now);
    } catch (e) {
      this.alert('warn', `Tick gagal: ${e instanceof Error ? e.message : e}`);
    }
    this.lastTick = now;
    this.tickMs = Date.now() - t0;
    this.emit('snapshot', this.snapshot());
  }

  private async rebalance(now: number, equity: number, positions: Record<string, BrokerPosition>) {
    const pb = this.playbook!;
    const { cfg, broker } = this.d;
    // 1. Snapshot leader. Data basi melewati batas -> bekukan (tidak ada order baru) daripada menebak.
    // Bila basi > 5x batas, leader dianggap hilang: kontribusinya dikeluarkan supaya sleeve lain tetap jalan.
    let frozen = false;
    const gone = new Set<string>();
    const staleMs = cfg.leaderStaleSeconds * 1000;
    const results = await Promise.allSettled([...this.sources.values()].map((s) => s.fetch()));
    let oldest = now;
    [...this.sources.values()].forEach((src, i) => {
      const res = results[i];
      if (res.status === 'fulfilled') this.lastSnap.set(src.id, { ...res.value, ts: now });
      else if (!this.firstFail.has(src.id)) this.firstFail.set(src.id, now);
      if (res.status === 'fulfilled') this.firstFail.delete(src.id);
      const snap = this.lastSnap.get(src.id);
      const age = snap ? now - snap.ts : now - (this.firstFail.get(src.id) ?? now);
      if (age > 5 * staleMs) {
        if (!this.goneAlerted.has(src.id)) this.alert('warn', `Leader ${src.label} tidak bisa diambil > ${Math.round((5 * staleMs) / 60_000)} menit; posisinya tidak lagi disalin.`);
        this.goneAlerted.add(src.id);
        gone.add(src.id);
      } else if (!snap || age > staleMs) frozen = true;
      else this.goneAlerted.delete(src.id);
      if (snap && !gone.has(src.id)) oldest = Math.min(oldest, snap.ts);
    });
    this.leaderLag = this.sources.size ? now - oldest : null;
    if (frozen) {
      this.alert('warn', 'Data leader tidak terbaru — rebalancing ditahan sampai koneksi pulih.');
      this.lastMarks = await broker.markPrices(Object.keys(positions));
      return;
    }

    // 2. Target dari leader + strategi.
    const strategyLeverage = await this.sleeve.update(now);
    const leaderInputs = pb.leaders
      .filter((l) => !gone.has(l.address))
      .map((l) => {
        const snapshot = this.lastSnap.get(l.address);
        if (!snapshot) return null;
        return { snapshot, weight: l.weight, exclude: this.excludedFor(l.address, snapshot) };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const t = computeTargets({
      equity,
      allocation: pb.allocation,
      copyMultiplier: this.risk.profile.copyMultiplier,
      leaders: leaderInputs,
      strategyLeverage,
      supports: (c) => broker.supports(c),
    });
    this.lastSources = t.sources;
    const capped = capTargets(t.notional, equity, this.risk.profile);

    // 3. Order.
    const coins = [...new Set([...Object.keys(capped.notional), ...Object.keys(positions)])];
    const marks = await broker.markPrices(coins);
    this.lastMarks = marks;
    const orders = planOrders(capped.notional, positions, marks, {
      minOrderUsd: cfg.minOrderUsd,
      band: cfg.rebalanceBand,
      roundQty: (c, q) => broker.roundQty(c, q),
      minNotional: (c) => broker.minNotional(c),
    });
    for (const o of orders) {
      try {
        // Leverage bursa = batas gross, supaya margin silang cukup untuk semua posisi sekaligus.
        if (!o.reduceOnly) await broker.ensureLeverage(o.coin, this.risk.profile.maxGrossLeverage);
        const fill = await broker.marketOrder(o);
        this.recordTrade(fill, this.reasonFor(o.coin, o.reduceOnly));
      } catch (e) {
        this.alert('warn', `Order ${o.side} ${o.qty} ${o.coin} gagal: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (orders.length) this.lastPositions = await broker.positions();
  }

  private excludedFor(leader: string, snap: LeaderSnapshot): Set<string> | undefined {
    if (this.d.cfg.entryPolicy !== 'new-only') return undefined;
    if (!this.baseline[leader]) {
      this.baseline[leader] = Object.fromEntries(Object.entries(snap.positions).map(([c, p]) => [c, Math.sign(p.size)]));
      this.d.store.writeJson('baseline', this.baseline);
    }
    const base = this.baseline[leader];
    for (const [coin, sign] of Object.entries(base)) {
      const now = Math.sign(snap.positions[coin]?.size ?? 0);
      if (now !== sign) delete base[coin];
    }
    return new Set(Object.keys(base));
  }

  private reasonFor(coin: string, reduce: boolean) {
    const src = this.lastSources[coin] ?? [];
    const names = src.map((s) => (s === 'strategy' ? 'strategi' : (this.leaders.find((l) => l.address === s)?.label ?? s.slice(0, 8))));
    if (!names.length) return reduce ? 'tutup (tidak ada target)' : 'rebalance';
    return `${reduce ? 'kurangi' : 'ikut'} ${names.join(' + ')}`;
  }

  // Rekonsiliasi: ekuitas dihitung ulang HANYA dari ledger (trade + funding) dan harga mark,
  // lalu dibandingkan dengan ekuitas broker. Paper: harus sama sampai sen. Live: posisi harus sama.
  async audit(now: number) {
    const { broker, store } = this.d;
    // Buku besar lengkap (file / memori), bukan 500 baris terakhir yang ditampilkan.
    const trades = store.readJsonl<TradeView>('trades');
    const fundingRows = store.readJsonl<FundingEntry>('funding');
    const fundingTotal = broker.fundingPaid?.() ?? fundingRows.reduce((a, f) => a + f.amount, 0);
    const brokerPos = await broker.positions();
    const coins = [...new Set([...trades.map((t) => t.coin), ...Object.keys(brokerPos)])];
    const marks = coins.length ? await broker.markPrices(coins) : {};
    const brokerEquity = await broker.equity();
    const ledger = auditLedger(this.startEquity, trades, marks);
    const ledgerEquity = ledger.equity - fundingTotal;
    const sizes = new Set([...Object.keys(ledger.positions), ...Object.keys(brokerPos)]);
    const positionsMatch = [...sizes].every((c) => Math.abs((ledger.positions[c] ?? 0) - (brokerPos[c]?.size ?? 0)) <= 1e-9 * Math.max(1, Math.abs(brokerPos[c]?.size ?? 0)));
    const diff = brokerEquity - ledgerEquity;
    const unrealized = ledger.equity - (this.startEquity + ledger.realized - ledger.fees);
    this.statement = {
      periodStart: this.equity[0]?.t ?? this.startedAt,
      periodEnd: now,
      startEquity: this.startEquity,
      realized: ledger.realized,
      fees: ledger.fees,
      funding: fundingTotal,
      unrealized,
      endEquity: brokerEquity,
      netPnl: brokerEquity - this.startEquity,
      tradeCount: trades.length,
      fundingEvents: fundingRows.length,
      reconciled: broker.live ? positionsMatch : positionsMatch && Math.abs(diff) < 0.01,
      ledgerEquity,
      diff,
      checkedAt: now,
    };
    if (!this.statement.reconciled) this.alert('warn', `Rekonsiliasi ledger tidak cocok: selisih $${diff.toFixed(4)}${positionsMatch ? '' : ', posisi berbeda'}.`);
    if (store.dir) {
      this.files = ['trades.jsonl', 'funding.jsonl', 'equity.jsonl', 'paper-account.json']
        .map((name) => ({ name, path: join(store.dir!, name) }))
        .filter((f) => existsSync(f.path))
        .map((f) => {
          const buf = readFileSync(f.path);
          return { name: f.name, sha256: createHash('sha256').update(buf).digest('hex'), lines: buf.toString().split('\n').filter(Boolean).length };
        });
    }
    this.lastAudit = now;
  }

  private provenance(): ProvenanceView {
    const synthetic = this.d.synthetic;
    const hl = this.d.broker.venue === 'hyperliquid';
    const sources = synthetic
      ? [
          { label: 'Harga & candle', endpoint: 'Pasar sintetis (seed tetap)', detail: 'Demo: tidak ada data bursa.' },
          { label: 'Trader', endpoint: 'Trader sintetis', detail: 'Demo: alamat bukan wallet sungguhan.' },
        ]
      : [
          { label: 'Harga mark', endpoint: hl ? 'POST api.hyperliquid.xyz/info · allMids' : 'GET fapi.binance.com/fapi/v1/premiumIndex', detail: `Diambil tiap tick (${this.d.cfg.tickSeconds} detik); dipakai untuk eksekusi paper & nilai posisi.` },
          { label: 'Posisi trader yang disalin', endpoint: 'POST api.hyperliquid.xyz/info · clearinghouseState', detail: 'Data publik on-chain; bisa dicek siapa saja lewat explorer di bawah.' },
          { label: 'Funding', endpoint: hl ? 'POST api.hyperliquid.xyz/info · metaAndAssetCtxs' : 'GET fapi.binance.com/fapi/v1/premiumIndex', detail: hl ? 'Tarif per jam, dibebankan tiap jam.' : 'Tarif per 8 jam.' },
          { label: 'Riwayat trader (scout & replay)', endpoint: 'POST api.hyperliquid.xyz/info · userFillsByTime, portfolio', detail: 'Fill & kurva PnL trader 7–30 hari.' },
          { label: 'Leaderboard', endpoint: 'GET stats-data.hyperliquid.xyz/Mainnet/leaderboard', detail: 'Daftar awal kandidat trader.' },
          { label: 'Candle turnamen strategi', endpoint: 'POST api.hyperliquid.xyz/info · candleSnapshot', detail: '1 jam; Hyperliquid menyimpan ±5000 candle terakhir.' },
        ];
    const leaders = (this.playbook?.leaders ?? []).map((l) => ({
      address: l.address,
      label: l.label,
      explorer: l.address.startsWith('0x') && !synthetic ? `https://app.hyperliquid.xyz/explorer/address/${l.address}` : '',
    }));
    const lastLeaderSnapshots = [...this.lastSnap.values()].map((sn) => ({
      address: sn.id,
      ts: sn.ts,
      equity: sn.equity,
      positions: Object.entries(sn.positions).map(([coin, p]) => ({ coin, size: p.size, px: p.px })),
    }));
    return { sources, leaders, lastLeaderSnapshots, files: this.files, codeVersion: this.codeVersion };
  }

  private recordTrade(f: Fill, reason: string) {
    const t: TradeView = { ...f, notional: f.qty * f.px, reason };
    this.trades = [...this.trades, t].slice(-500);
    this.d.store.appendJsonl('trades', t);
  }

  private recordEquity(now: number, equity: number) {
    const last = this.equity[this.equity.length - 1];
    if (last && now - last.t < EQUITY_SAMPLE_MS) {
      last.equity = equity;
      return;
    }
    const p = { t: now, equity };
    this.equity.push(p);
    if (this.equity.length > MAX_EQUITY_POINTS) this.equity.splice(0, this.equity.length - MAX_EQUITY_POINTS);
    this.d.store.appendJsonl('equity', p);
  }

  // ---------------------------------------------------------------- kontrol

  async flatten(reason = 'manual') {
    const positions = await this.d.broker.positions();
    const marks = await this.d.broker.markPrices(Object.keys(positions));
    for (const [coin, p] of Object.entries(positions)) {
      try {
        const fill = await this.d.broker.marketOrder({
          coin,
          side: p.size > 0 ? 'sell' : 'buy',
          qty: Math.abs(p.size),
          reduceOnly: true,
          refPx: marks[coin] ?? p.entryPx,
        });
        this.recordTrade(fill, `tutup semua (${reason})`);
      } catch (e) {
        this.alert('critical', `Gagal menutup ${coin}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.lastPositions = await this.d.broker.positions();
  }

  pause() {
    if (this.state === 'running') this.state = 'paused';
    this.alert('info', 'Engine dijeda — posisi dibiarkan, tidak ada order baru.');
  }

  resume() {
    if (this.state === 'paused') this.state = 'running';
    this.alert('info', 'Engine dilanjutkan.');
  }

  setProfile(id: RiskProfileId) {
    this.risk.profile = resolveProfile(id, this.d.cfg.copyMultiplier);
    this.sleeve.setProfile(this.risk.profile);
    this.saveSettings();
    this.alert('info', `Profil risiko diubah ke ${this.risk.profile.label}. Berlaku penuh pada seleksi mingguan berikutnya.`);
  }

  private saveSettings() {
    this.d.store.writeJson('settings', { profile: this.risk.profile.id, startEquity: this.startEquity });
  }

  // ---------------------------------------------------------------- snapshot dashboard

  snapshot(): DashboardSnapshot {
    const now = this.d.clock();
    const equity = this.lastEquity;
    const marks = this.lastMarks;
    const positions: PositionView[] = Object.entries(this.lastPositions)
      .map(([coin, p]) => {
        const markPx = marks[coin] ?? p.entryPx;
        const upnl = p.size * (markPx - p.entryPx);
        return {
          coin,
          side: p.size > 0 ? ('long' as const) : ('short' as const),
          size: Math.abs(p.size),
          notional: Math.abs(p.size) * markPx,
          entryPx: p.entryPx,
          markPx,
          upnl,
          upnlPct: p.entryPx ? upnl / (Math.abs(p.size) * p.entryPx) : 0,
          sources: this.lastSources[coin] ?? [],
        };
      })
      .sort((a, b) => b.notional - a.notional);
    const gross = positions.reduce((a, p) => a + p.notional, 0);
    const net = positions.reduce((a, p) => a + (p.side === 'long' ? p.notional : -p.notional), 0);
    const wse = this.risk.s.weekStartEquity || equity;
    return {
      version: 1,
      mode: this.d.cfg.mode,
      venue: this.d.broker.venue,
      generatedAt: now,
      synthetic: this.d.synthetic,
      account: {
        equity,
        startEquity: this.startEquity,
        weekStartEquity: wse,
        weekPnl: equity - wse,
        weekPnlPct: wse ? equity / wse - 1 : 0,
        totalPnl: equity - this.startEquity,
        totalPnlPct: this.startEquity ? equity / this.startEquity - 1 : 0,
        grossExposure: gross,
        netExposure: net,
        leverage: equity > 0 ? gross / equity : 0,
        feesPaid: this.d.broker.feesPaid(),
        fundingPaid: this.d.broker.fundingPaid?.() ?? 0,
      },
      equityCurve: downsample(this.equity, 1500),
      weeklyReturns: weeklyFromCurve(this.equity),
      positions,
      trades: [...this.trades].reverse().slice(0, 200),
      playbook: this.playbook,
      tournament: this.tournament && { ...this.tournament, entries: this.tournament.entries.slice(0, 40) },
      leaders: this.leaders,
      scout: this.scoutSummary,
      risk: this.risk.view(equity),
      status: {
        state: this.state,
        lastTick: this.lastTick,
        tickMs: this.tickMs,
        startedAt: this.startedAt,
        nextRebalance: this.playbook?.weekEnd ?? nextWeekStart(now),
        nextStrategyBar: this.sleeve.nextBarAt(now),
        leaderLagMs: this.leaderLag,
      },
      alerts: this.alerts.slice(0, 30),
      statement: this.statement,
      fundingLog: [...this.fundingLog].reverse().slice(0, 100),
      provenance: this.provenance(),
      replay: this.replay,
    };
  }
}

export function downsample(points: EquityPoint[], max: number): EquityPoint[] {
  if (points.length <= max) return points.slice();
  const step = points.length / max;
  const out: EquityPoint[] = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

export function weeklyFromCurve(points: EquityPoint[]) {
  const out: { weekStart: number; ret: number }[] = [];
  let prevClose: number | null = null;
  let cur: { ws: number; open: number; close: number } | null = null;
  for (const p of points) {
    const ws = weekStart(p.t);
    if (!cur || cur.ws !== ws) {
      if (cur) {
        out.push({ weekStart: cur.ws, ret: cur.close / (prevClose ?? cur.open) - 1 });
        prevClose = cur.close;
      }
      cur = { ws, open: p.equity, close: p.equity };
    } else cur.close = p.equity;
  }
  if (cur) out.push({ weekStart: cur.ws, ret: cur.close / (prevClose ?? cur.open) - 1 });
  return out;
}

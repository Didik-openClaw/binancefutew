// Kontrak data antara engine dan dashboard. Semua angka dalam USD kecuali disebut lain.

export type Venue = 'binance' | 'hyperliquid';
export type EngineMode = 'paper' | 'live' | 'demo';
export type RiskProfileId = 'balanced' | 'bold' | 'extreme';

export interface Candle {
  t: number; // open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface WeeklyReturn {
  weekStart: number;
  ret: number;
}

export interface PositionView {
  coin: string;
  side: 'long' | 'short';
  size: number; // base units, unsigned
  notional: number; // unsigned
  entryPx: number;
  markPx: number;
  upnl: number;
  upnlPct: number; // relative to margin-free notional at entry
  sources: string[]; // 'strategy' | leader address
}

export interface TradeView {
  id: string;
  t: number;
  coin: string;
  side: 'buy' | 'sell';
  qty: number;
  px: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  reason: string;
  reduceOnly: boolean;
}

export interface StrategyStats {
  totalReturn: number;
  lastWeek: number;
  maxDrawdown: number; // positive fraction
  sharpe: number;
  winRateWeeks: number; // fraction of positive weeks
  trades: number;
  exposure: number; // average |position|
}

export interface GateResult {
  passed: boolean; // lolos di tingkat saringan yang dipakai minggu ini
  failed?: string; // gerbang pertama yang gagal
  psr: number; // Probabilistic Sharpe Ratio (peluang Sharpe > 0)
  dsr: number; // Deflated Sharpe Ratio (dikoreksi jumlah kandidat)
}

export interface TournamentEntry {
  id: string;
  strategy: string;
  label: string;
  params: Record<string, number>;
  universe: string[]; // coins
  score: number;
  stats: StrategyStats;
  gate: GateResult;
  weeklyReturns: number[]; // lookback window, oldest -> newest
}

export type QualificationLevel = 0 | 1 | 2 | 3;

export interface QualificationReport {
  level: QualificationLevel; // 0 Ketat, 1 Standar, 2 Longgar, 3 Darurat
  levelLabel: string;
  tested: number;
  qualified: number;
  expectedMaxSharpe: number; // Sharpe tahunan yang bisa didapat juara "karena untung-untungan"
  funnel: { label: string; remaining: number }[];
  universe: string[];
  expanded: boolean; // universe diperluas karena kandidat lolos kurang
}

export interface RuleReport {
  id: string;
  label: string;
  lookback: number;
  halfLife: number;
  oosReturn: number;
  maxDrawdown: number;
  winRateWeeks: number;
  chosen: boolean;
}

export interface PolicyReport {
  // Hasil out-of-sample dari aturan "pilih juara tiap Senin, pakai 1 minggu"
  weeks: { weekStart: number; pickedId: string; pickedLabel: string; rule: string; level: QualificationLevel; ret: number; benchmark: number }[];
  totalReturn: number;
  benchmarkReturn: number; // buy & hold coin acuan
  maxDrawdown: number;
  winRateWeeks: number;
  worstWeek: number;
  bestWeek: number;
}

export interface TournamentReport {
  ranAt: number;
  interval: string;
  lookbackWeeks: number;
  dataFrom: number;
  dataTo: number;
  benchmarkCoin: string;
  entries: TournamentEntry[]; // lolos saringan dulu, lalu skor menurun
  policy: PolicyReport; // aturan seleksi terpilih tiap minggu, out-of-sample
  rules: RuleReport[];
  chosenRule: string;
  qualification: QualificationReport;
  synthetic: boolean;
}

export interface LeaderView {
  address: string;
  label: string;
  accountValue: number;
  weekRoi: number;
  monthRoi: number;
  allTimePnl: number;
  winRate: number | null;
  maxDrawdown: number | null;
  fillsPerDay: number | null;
  holdHours: number | null; // median lama posisi dipegang
  scalpShare: number | null; // porsi profit dari posisi < 10 menit (sulit disalin)
  positiveDays: number | null; // porsi hari profit dalam 30 hari
  score: number;
  weight: number; // allocation inside copy sleeve, 0 if not copied
  status: 'copying' | 'candidate' | 'rejected';
  reason?: string;
  openPositions: number;
}

export interface ScoutSummary {
  ranAt: number;
  leaderboardSize: number;
  analyzed: number; // jumlah trader yang dianalisis mendalam
  rounds: number;
  level: number; // 0 ketat .. 2 longgar
  levelLabel: string;
  qualified: number;
}

export interface Playbook {
  weekStart: number;
  weekEnd: number;
  createdAt: number;
  appliedAt: number | null;
  riskProfile: RiskProfileId;
  allocation: { strategy: number; copy: number };
  strategies: { id: string; label: string; weight: number; universe: string[] }[];
  leaders: { address: string; label: string; weight: number }[];
  notes: string[];
}

export interface RiskState {
  profile: RiskProfileId;
  maxGrossLeverage: number;
  maxPositionLeverage: number;
  weeklyLossLimit: number; // fraction
  copyMultiplier: number;
  weekStartEquity: number;
  weekLossUsed: number; // fraction of limit used (0..1+)
  killSwitch: 'armed' | 'triggered';
  haltedUntil: number | null;
}

export interface EngineAlert {
  t: number;
  level: 'info' | 'warn' | 'critical';
  message: string;
}

export interface AccountSummary {
  equity: number;
  startEquity: number;
  weekStartEquity: number;
  weekPnl: number;
  weekPnlPct: number;
  totalPnl: number;
  totalPnlPct: number;
  grossExposure: number;
  netExposure: number;
  leverage: number;
  feesPaid: number;
}

export interface EngineStatus {
  state: 'running' | 'paused' | 'halted' | 'starting';
  lastTick: number;
  tickMs: number;
  startedAt: number;
  nextRebalance: number;
  nextStrategyBar: number;
  leaderLagMs: number | null;
}

export interface DashboardSnapshot {
  version: 1;
  mode: EngineMode;
  venue: Venue;
  generatedAt: number;
  synthetic: boolean;
  account: AccountSummary;
  equityCurve: EquityPoint[];
  weeklyReturns: WeeklyReturn[];
  positions: PositionView[];
  trades: TradeView[];
  playbook: Playbook | null;
  tournament: TournamentReport | null;
  leaders: LeaderView[];
  scout: ScoutSummary | null;
  risk: RiskState;
  status: EngineStatus;
  alerts: EngineAlert[];
}

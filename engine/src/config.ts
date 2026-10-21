import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const envPath = resolve(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const list = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));
const num = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)));

const Env = z.object({
  MODE: z.enum(['paper', 'live', 'demo']).optional(),
  VENUE: z.enum(['binance', 'hyperliquid']).optional(),
  CONFIRM_LIVE: z.string().optional(),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BINANCE_ENV: z.enum(['live', 'testnet', 'demo']).optional(),
  BINANCE_LEADER_API_KEY: z.string().optional(),
  BINANCE_LEADER_API_SECRET: z.string().optional(),
  HL_WALLET_ADDRESS: z.string().optional(),
  HL_PRIVATE_KEY: z.string().optional(),
  HL_TESTNET: bool,
  RISK_PROFILE: z.enum(['balanced', 'bold', 'extreme']).optional(),
  PAPER_START_EQUITY: num,
  LEADERS: list,
  AUTO_SCOUT: bool,
  AUTO_APPLY_PLAYBOOK: bool,
  ALLOC_STRATEGY: num,
  ENTRY_POLICY: z.enum(['mirror', 'new-only']).optional(),
  UNIVERSE: list,
  BENCHMARK: z.string().optional(),
  STRATEGY_INTERVAL: z.string().optional(),
  LOOKBACK_WEEKS: num,
  WALKFORWARD_WEEKS: num,
  TICK_SECONDS: num,
  MIN_ORDER_USD: num,
  REBALANCE_BAND: num,
  LEADER_STALE_SECONDS: num,
  SCOUT_MIN_ACCOUNT: num,
  SCOUT_MAX_TURNOVER: num,
  SCOUT_MAX_FILLS_PER_DAY: num,
  SCOUT_MAX_DRAWDOWN: num,
  SCOUT_DEEP_DIVE: num,
  API_HOST: z.string().optional(),
  API_PORT: num,
  DASHBOARD_TOKEN: z.string().optional(),
  DATA_DIR: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export const BINANCE_LEADER_ID = 'binance:leader';

export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const e = Env.parse({ ...process.env, ...overrides });
  const mode = e.MODE ?? 'paper';
  const venue = e.VENUE ?? 'hyperliquid';
  const cfg = {
    root: ROOT,
    mode,
    venue,
    confirmLive: e.CONFIRM_LIVE === 'I_UNDERSTAND_THE_RISK',
    binance: {
      apiKey: e.BINANCE_API_KEY ?? '',
      apiSecret: e.BINANCE_API_SECRET ?? '',
      env: e.BINANCE_ENV ?? 'live',
    },
    hyperliquid: {
      walletAddress: e.HL_WALLET_ADDRESS ?? '',
      privateKey: e.HL_PRIVATE_KEY ?? '',
      testnet: e.HL_TESTNET ?? false,
    },
    riskProfile: e.RISK_PROFILE ?? 'bold',
    paperStartEquity: e.PAPER_START_EQUITY ?? 10_000,
    // Akun Binance sumber sinyal (API key read-only) disalin sebagai leader manual "binance:leader".
    binanceLeader: e.BINANCE_LEADER_API_KEY && e.BINANCE_LEADER_API_SECRET ? { apiKey: e.BINANCE_LEADER_API_KEY, apiSecret: e.BINANCE_LEADER_API_SECRET } : null,
    manualLeaders: [...(e.LEADERS ?? []), ...(e.BINANCE_LEADER_API_KEY && e.BINANCE_LEADER_API_SECRET ? [BINANCE_LEADER_ID] : [])],
    autoScout: e.AUTO_SCOUT ?? true,
    autoApplyPlaybook: e.AUTO_APPLY_PLAYBOOK ?? true,
    allocStrategy: clamp(e.ALLOC_STRATEGY ?? 0.5, 0, 1),
    entryPolicy: e.ENTRY_POLICY ?? 'mirror',
    universe: e.UNIVERSE ?? ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'SUI', 'AVAX', 'LINK', 'LTC', 'ADA', 'HYPE'],
    benchmark: e.BENCHMARK ?? 'BTC',
    strategyInterval: e.STRATEGY_INTERVAL ?? '1h',
    lookbackWeeks: e.LOOKBACK_WEEKS ?? 12,
    walkForwardWeeks: e.WALKFORWARD_WEEKS ?? 26,
    tickSeconds: e.TICK_SECONDS ?? 10,
    minOrderUsd: e.MIN_ORDER_USD ?? 12,
    rebalanceBand: e.REBALANCE_BAND ?? 0.15,
    leaderStaleSeconds: e.LEADER_STALE_SECONDS ?? 120,
    scout: {
      minAccountValue: e.SCOUT_MIN_ACCOUNT ?? 25_000,
      maxWeeklyTurnover: e.SCOUT_MAX_TURNOVER ?? 200,
      maxFillsPerDay: e.SCOUT_MAX_FILLS_PER_DAY ?? 150,
      maxDrawdown: e.SCOUT_MAX_DRAWDOWN ?? 0.45,
      deepDive: e.SCOUT_DEEP_DIVE ?? 40,
    },
    api: {
      host: e.API_HOST ?? '127.0.0.1',
      port: e.API_PORT ?? 8787,
      token: e.DASHBOARD_TOKEN ?? '',
    },
    dataDir: resolve(ROOT, e.DATA_DIR ?? 'data'),
  };
  if (cfg.mode === 'live' && !cfg.confirmLive) {
    throw new Error('MODE=live butuh CONFIRM_LIVE=I_UNDERSTAND_THE_RISK di .env. Mulai dari MODE=paper dulu.');
  }
  if (cfg.mode === 'live' && cfg.api.host !== '127.0.0.1' && !cfg.api.token) {
    throw new Error('Dashboard diekspos ke jaringan tanpa DASHBOARD_TOKEN. Isi DASHBOARD_TOKEN atau pakai API_HOST=127.0.0.1.');
  }
  return cfg;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

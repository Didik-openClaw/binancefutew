import type { Candle } from '../../../shared/types';
import { fetchJson, postJson } from '../lib/http';
import { intervalMs } from '../lib/time';

export const HL_MAINNET = 'https://api.hyperliquid.xyz';
export const HL_TESTNET = 'https://api.hyperliquid-testnet.xyz';
export const HL_LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

export interface HlAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    leverage: { type: string; value: number };
    liquidationPx: string | null;
    marginUsed: string;
  };
}

export interface HlClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMarginSummary?: { accountValue: string };
  assetPositions: HlAssetPosition[];
  withdrawable: string;
  time: number;
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  dir: string; // "Open Long", "Close Short", ...
  closedPnl: string;
  fee: string;
  oid: number;
  hash: string;
}

export type HlPortfolio = [string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }][];

export interface HlLeaderboardRow {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
}

export class HyperliquidInfo {
  constructor(private base = HL_MAINNET) {}

  private info<T>(body: unknown) {
    return postJson<T>(`${this.base}/info`, body);
  }

  clearinghouseState(user: string) {
    return this.info<HlClearinghouseState>({ type: 'clearinghouseState', user });
  }

  allMids() {
    return this.info<Record<string, string>>({ type: 'allMids' });
  }

  async meta() {
    const [meta, ctxs] = await this.info<[{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }, { markPx: string; funding: string; dayNtlVlm: string }[]]>({
      type: 'metaAndAssetCtxs',
    });
    return meta.universe.map((u, i) => ({ ...u, markPx: Number(ctxs[i]?.markPx), funding: Number(ctxs[i]?.funding), dayVolume: Number(ctxs[i]?.dayNtlVlm) }));
  }

  portfolio(user: string) {
    return this.info<HlPortfolio>({ type: 'portfolio', user });
  }

  // Maks 2000 fill per panggilan; lanjutkan dari waktu fill terakhir.
  async userFillsByTime(user: string, startTime: number, endTime = Date.now(), maxPages = 5) {
    const out: HlFill[] = [];
    let cursor = startTime;
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.info<HlFill[]>({ type: 'userFillsByTime', user, startTime: cursor, endTime, aggregateByTime: true });
      out.push(...rows);
      if (rows.length < 2000) break;
      cursor = rows[rows.length - 1].time + 1;
    }
    return out;
  }

  async candles(coin: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
    const step = intervalMs(interval);
    const out: Candle[] = [];
    let cursor = startTime;
    while (cursor <= endTime) {
      const rows = await this.info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({
        type: 'candleSnapshot',
        req: { coin, interval, startTime: cursor, endTime },
      });
      if (!rows.length) break;
      for (const r of rows) out.push({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
      const lastT = rows[rows.length - 1].t;
      if (lastT + step > endTime || rows.length < 500) break;
      cursor = lastT + step;
    }
    const now = Date.now();
    const seen = new Set<number>();
    return out.filter((k) => k.t + step <= now && !seen.has(k.t) && seen.add(k.t));
  }

  async fundingHistory(coin: string, startTime: number, endTime: number) {
    const out: { t: number; rate: number }[] = [];
    let cursor = startTime;
    while (cursor < endTime) {
      const rows = await this.info<{ time: number; fundingRate: string }[]>({ type: 'fundingHistory', coin, startTime: cursor, endTime });
      if (!rows.length) break;
      for (const r of rows) out.push({ t: r.time, rate: Number(r.fundingRate) });
      if (rows.length < 500) break;
      cursor = rows[rows.length - 1].time + 1;
    }
    return out;
  }

  static leaderboard() {
    // File leaderboard besar (puluhan MB); beri waktu unduh lebih lama.
    return fetchJson<{ leaderboardRows: HlLeaderboardRow[] }>(HL_LEADERBOARD, { signal: AbortSignal.timeout(120_000) }, 2);
  }
}

import { createHmac } from 'node:crypto';
import { BINANCE_FAPI } from '../data/binancePublic';
import { HyperliquidInfo } from '../data/hyperliquidInfo';
import { fromBinanceSymbol } from '../data/symbols';
import { fetchJson } from '../lib/http';

export interface LeaderPosition {
  size: number; // bertanda
  px: number; // harga mark saat snapshot
}

export interface LeaderSnapshot {
  id: string;
  equity: number;
  positions: Record<string, LeaderPosition>;
  ts: number;
}

export interface LeaderSource {
  id: string;
  label: string;
  fetch(): Promise<LeaderSnapshot>;
}

// Semua posisi wallet Hyperliquid bersifat publik — cukup alamatnya.
export class HyperliquidWalletLeader implements LeaderSource {
  label: string;
  constructor(
    public id: string,
    label?: string,
    private info = new HyperliquidInfo(),
  ) {
    this.label = label ?? `${id.slice(0, 6)}…${id.slice(-4)}`;
  }

  async fetch(): Promise<LeaderSnapshot> {
    const s = await this.info.clearinghouseState(this.id);
    const positions: Record<string, LeaderPosition> = {};
    for (const { position: p } of s.assetPositions) {
      const size = Number(p.szi);
      if (!size) continue;
      positions[p.coin] = { size, px: Math.abs(Number(p.positionValue) / size) };
    }
    return { id: this.id, equity: Number(s.marginSummary.accountValue), positions, ts: s.time ?? Date.now() };
  }
}

// Akun Binance yang membagikan API key READ-ONLY (mis. akun sinyal milik sendiri).
export class BinanceAccountLeader implements LeaderSource {
  constructor(
    public id: string,
    public label: string,
    private key: string,
    private secret: string,
    private base = BINANCE_FAPI,
  ) {}

  private signed<T>(path: string) {
    const qs = `timestamp=${Date.now()}&recvWindow=10000`;
    const sig = createHmac('sha256', this.secret).update(qs).digest('hex');
    return fetchJson<T>(`${this.base}${path}?${qs}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': this.key } });
  }

  async fetch(): Promise<LeaderSnapshot> {
    const [acct, risk] = await Promise.all([
      this.signed<{ totalMarginBalance: string }>('/fapi/v2/account'),
      this.signed<{ symbol: string; positionAmt: string; markPrice: string }[]>('/fapi/v2/positionRisk'),
    ]);
    const positions: Record<string, LeaderPosition> = {};
    for (const r of risk) {
      const size = Number(r.positionAmt);
      const coin = fromBinanceSymbol(r.symbol);
      if (!size || !coin) continue;
      positions[coin] = { size: (positions[coin]?.size ?? 0) + size, px: Number(r.markPrice) };
    }
    return { id: this.id, equity: Number(acct.totalMarginBalance), positions, ts: Date.now() };
  }
}

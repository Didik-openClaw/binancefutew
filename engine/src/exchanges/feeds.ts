import { binanceExchangeInfo, binanceMarkPrices, BINANCE_FAPI } from '../data/binancePublic';
import { HyperliquidInfo } from '../data/hyperliquidInfo';
import { fromBinanceSymbol } from '../data/symbols';
import { fetchJson } from '../lib/http';
import type { PriceFeed } from './types';

// Cache singkat supaya satu tick tidak memanggil endpoint harga berkali-kali.
abstract class CachedFeed implements PriceFeed {
  private cache: { t: number; prices: Record<string, number> } | null = null;
  constructor(private ttlMs = 1500) {}
  protected abstract fetchAll(): Promise<Record<string, number>>;
  abstract listCoins(): Promise<string[]>;
  async markPrices(coins: string[]) {
    if (!this.cache || Date.now() - this.cache.t > this.ttlMs) this.cache = { t: Date.now(), prices: await this.fetchAll() };
    const out: Record<string, number> = {};
    for (const c of coins) if (this.cache.prices[c] !== undefined) out[c] = this.cache.prices[c];
    return out;
  }
}

export class HyperliquidFeed extends CachedFeed {
  constructor(private info = new HyperliquidInfo()) {
    super();
  }
  protected async fetchAll() {
    const mids = await this.info.allMids();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(mids)) if (!k.startsWith('@')) out[k] = Number(v);
    return out;
  }
  async listCoins() {
    return (await this.info.meta()).filter((u) => !u.isDelisted).map((u) => u.name);
  }
  async fundingRates() {
    const meta = await this.info.meta();
    return { rates: Object.fromEntries(meta.filter((u) => Number.isFinite(u.funding)).map((u) => [u.name, u.funding])), intervalHours: 1 };
  }
}

export class BinanceFeed extends CachedFeed {
  constructor(private base = BINANCE_FAPI) {
    super();
  }
  protected async fetchAll() {
    const bySymbol = await binanceMarkPrices(this.base);
    const out: Record<string, number> = {};
    for (const [sym, px] of Object.entries(bySymbol)) {
      const coin = fromBinanceSymbol(sym);
      if (coin) out[coin] = px;
    }
    return out;
  }
  async fundingRates() {
    const rows = await fetchJson<{ symbol: string; lastFundingRate: string }[]>(`${this.base}/fapi/v1/premiumIndex`);
    const rates: Record<string, number> = {};
    for (const r of rows) {
      const coin = fromBinanceSymbol(r.symbol);
      if (coin) rates[coin] = Number(r.lastFundingRate);
    }
    return { rates, intervalHours: 8 };
  }
  async listCoins() {
    const info = await binanceExchangeInfo(this.base);
    return info.symbols
      .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map((s) => fromBinanceSymbol(s.symbol))
      .filter((c): c is string => !!c);
  }
}

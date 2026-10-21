import ccxt, { type Exchange, type MarketInterface as Market } from 'ccxt';
import type { Venue } from '../../../shared/types';
import { BINANCE_FAPI } from '../data/binancePublic';
import { HL_MAINNET, HL_TESTNET, HyperliquidInfo } from '../data/hyperliquidInfo';
import { fromBinanceSymbol } from '../data/symbols';
import { BinanceFeed, HyperliquidFeed } from './feeds';
import type { Broker, BrokerPosition, Fill, OrderRequest, PriceFeed } from './types';

// Eksekusi live lewat ccxt (penandatanganan order Binance & Hyperliquid ditangani ccxt).
abstract class CcxtBroker implements Broker {
  live = true;
  protected markets = new Map<string, Market>(); // coin -> market ccxt
  private leverageSet = new Map<string, number>();
  private fees = 0;

  constructor(
    public venue: Venue,
    protected ex: Exchange,
    protected feed: PriceFeed,
  ) {}

  protected abstract coinOf(m: Market): string | null;

  async init() {
    const markets = await this.ex.loadMarkets();
    for (const m of Object.values(markets)) {
      if (!m || !m.swap || !m.active || !m.linear) continue;
      const coin = this.coinOf(m);
      if (coin) this.markets.set(coin, m);
    }
    if (!this.markets.size) throw new Error(`${this.venue}: tidak ada market perpetual yang dimuat`);
  }

  supports(coin: string) {
    return this.markets.has(coin);
  }

  minNotional(coin: string) {
    const m = this.markets.get(coin);
    return Math.max(m?.limits?.cost?.min ?? 0, this.venue === 'hyperliquid' ? 10 : 5);
  }

  roundQty(coin: string, qty: number) {
    const m = this.markets.get(coin);
    if (!m) return 0;
    const s = Number(this.ex.amountToPrecision(m.symbol, qty));
    return s >= (m.limits?.amount?.min ?? 0) ? s : 0;
  }

  markPrices(coins: string[]) {
    return this.feed.markPrices(coins);
  }

  async ensureLeverage(coin: string, leverage: number) {
    const m = this.markets.get(coin);
    if (!m) return;
    const maxLev = Number(m.limits?.leverage?.max ?? 20);
    const lev = Math.max(1, Math.min(Math.ceil(leverage), maxLev));
    if ((this.leverageSet.get(coin) ?? 0) >= lev) return;
    await this.setLeverage(m, lev);
    this.leverageSet.set(coin, lev);
  }

  protected abstract setLeverage(m: Market, lev: number): Promise<void>;

  feesPaid() {
    return this.fees;
  }

  async marketOrder(o: OrderRequest): Promise<Fill> {
    const m = this.markets.get(o.coin);
    if (!m) throw new Error(`${o.coin} tidak tersedia di ${this.venue}`);
    const order = await this.ex.createOrder(m.symbol, 'market', o.side, o.qty, this.priceArg(o), this.orderParams(o));
    const px = Number(order.average ?? order.price ?? o.refPx);
    const qty = Number(order.filled ?? o.qty);
    const fee = Number(order.fee?.cost ?? qty * px * (this.venue === 'hyperliquid' ? 0.00045 : 0.0005));
    this.fees += fee;
    return {
      id: String(order.id),
      t: order.timestamp ?? Date.now(),
      coin: o.coin,
      side: o.side,
      qty,
      px,
      fee,
      realizedPnl: 0,
      reduceOnly: o.reduceOnly,
    };
  }

  protected priceArg(_o: OrderRequest): number | undefined {
    return undefined;
  }

  protected orderParams(o: OrderRequest): Record<string, unknown> {
    return o.reduceOnly ? { reduceOnly: true } : {};
  }

  abstract equity(): Promise<number>;
  abstract positions(): Promise<Record<string, BrokerPosition>>;
}

export class BinanceLiveBroker extends CcxtBroker {
  constructor(cfg: { apiKey: string; apiSecret: string; env: 'live' | 'testnet' | 'demo' }) {
    if (!cfg.apiKey || !cfg.apiSecret) throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET belum diisi');
    const ex = new ccxt.binanceusdm({
      apiKey: cfg.apiKey,
      secret: cfg.apiSecret,
      enableRateLimit: true,
      options: { adjustForTimeDifference: true },
    });
    if (cfg.env === 'testnet') ex.setSandboxMode(true);
    if (cfg.env === 'demo') ex.enableDemoTrading(true);
    const base = cfg.env === 'live' ? BINANCE_FAPI : String((ex.urls.api as Record<string, string>).fapiPublic).replace(/\/fapi\/v1\/?$/, '');
    super('binance', ex, new BinanceFeed(base));
  }

  protected coinOf(m: Market) {
    return m.quote === 'USDT' ? fromBinanceSymbol(m.id ?? '') : null;
  }

  protected async setLeverage(m: Market, lev: number) {
    try {
      await this.ex.setMarginMode('cross', m.symbol);
    } catch {
      // "No need to change margin type" — sudah cross.
    }
    await this.ex.setLeverage(lev, m.symbol);
  }

  async equity() {
    const bal = await this.ex.fetchBalance();
    const info = bal.info as { totalMarginBalance?: string };
    return Number(info.totalMarginBalance ?? (bal.total as unknown as Record<string, number>)?.USDT ?? 0);
  }

  async positions() {
    const rows = await this.ex.fetchPositions();
    const out: Record<string, BrokerPosition> = {};
    for (const p of rows) {
      const info = p.info as { symbol?: string; positionAmt?: string; entryPrice?: string };
      const size = Number(info.positionAmt ?? 0);
      const coin = fromBinanceSymbol(info.symbol ?? '');
      if (!coin || !size) continue;
      out[coin] = { size, entryPx: Number(info.entryPrice ?? p.entryPrice ?? 0) };
    }
    return out;
  }
}

export class HyperliquidLiveBroker extends CcxtBroker {
  private info: HyperliquidInfo;

  constructor(private cfg: { walletAddress: string; privateKey: string; testnet: boolean }) {
    if (!cfg.walletAddress || !cfg.privateKey) throw new Error('HL_WALLET_ADDRESS / HL_PRIVATE_KEY belum diisi');
    const ex = new ccxt.hyperliquid({ walletAddress: cfg.walletAddress, privateKey: cfg.privateKey, enableRateLimit: true });
    if (cfg.testnet) ex.setSandboxMode(true);
    const info = new HyperliquidInfo(cfg.testnet ? HL_TESTNET : HL_MAINNET);
    super('hyperliquid', ex, new HyperliquidFeed(info));
    this.info = info;
  }

  protected coinOf(m: Market) {
    const name = (m as Market & { baseName?: string }).baseName;
    // Lewati perp HIP-3 (format "dex:COIN").
    return name && !name.includes(':') ? name : null;
  }

  protected async setLeverage(m: Market, lev: number) {
    await this.ex.setLeverage(lev, m.symbol, { marginMode: 'cross' });
  }

  // Market order Hyperliquid = IOC limit dengan batas slippage dari harga acuan.
  protected priceArg(o: OrderRequest) {
    return o.refPx;
  }

  protected orderParams(o: OrderRequest) {
    return { ...super.orderParams(o), slippage: '0.02' };
  }

  async equity() {
    const s = await this.info.clearinghouseState(this.cfg.walletAddress);
    return Number(s.marginSummary.accountValue);
  }

  async positions() {
    const s = await this.info.clearinghouseState(this.cfg.walletAddress);
    const out: Record<string, BrokerPosition> = {};
    for (const { position: p } of s.assetPositions) {
      const size = Number(p.szi);
      if (size) out[p.coin] = { size, entryPx: Number(p.entryPx ?? 0) };
    }
    return out;
  }
}

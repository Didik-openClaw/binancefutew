import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Venue } from '../../../shared/types';
import type { Broker, BrokerPosition, Fill, OrderRequest, PriceFeed } from './types';

interface PaperState {
  cash: number; // setoran + realized PnL - fee
  fees: number;
  positions: Record<string, BrokerPosition>;
  seq: number;
}

// Simulasi eksekusi dengan harga mark asli (atau sintetis di demo), fee taker dan slippage.
export class PaperBroker implements Broker {
  live = false;
  private s: PaperState;
  private coins = new Set<string>();

  constructor(
    public venue: Venue,
    private feed: PriceFeed,
    private opts: { startEquity: number; feeRate: number; slippage: number; file?: string; clock?: () => number },
  ) {
    this.s =
      opts.file && existsSync(opts.file)
        ? JSON.parse(readFileSync(opts.file, 'utf8'))
        : { cash: opts.startEquity, fees: 0, positions: {}, seq: 0 };
  }

  async init() {
    for (const c of await this.feed.listCoins()) this.coins.add(c);
  }

  supports(coin: string) {
    return this.coins.size === 0 || this.coins.has(coin);
  }

  minNotional() {
    return this.venue === 'hyperliquid' ? 10 : 5;
  }

  roundQty(_coin: string, qty: number) {
    if (qty === 0) return 0;
    const mag = 10 ** (Math.floor(Math.log10(Math.abs(qty))) - 5);
    return Math.round(qty / mag) * mag;
  }

  async ensureLeverage() {}

  markPrices(coins: string[]) {
    return this.feed.markPrices(coins);
  }

  async positions() {
    return structuredClone(this.s.positions);
  }

  async equity() {
    const coins = Object.keys(this.s.positions);
    if (!coins.length) return this.s.cash;
    const marks = await this.feed.markPrices(coins);
    let upnl = 0;
    for (const c of coins) {
      const p = this.s.positions[c];
      const m = marks[c] ?? p.entryPx;
      upnl += p.size * (m - p.entryPx);
    }
    return this.s.cash + upnl;
  }

  feesPaid() {
    return this.s.fees;
  }

  async marketOrder(o: OrderRequest): Promise<Fill> {
    const marks = await this.feed.markPrices([o.coin]);
    const mark = marks[o.coin] ?? o.refPx;
    const px = o.side === 'buy' ? mark * (1 + this.opts.slippage) : mark * (1 - this.opts.slippage);
    const signed = o.side === 'buy' ? o.qty : -o.qty;
    const pos = this.s.positions[o.coin] ?? { size: 0, entryPx: px };
    let qty = o.qty;
    let realized = 0;
    if (o.reduceOnly) {
      if (pos.size === 0 || Math.sign(signed) === Math.sign(pos.size)) throw new Error(`reduceOnly akan menambah posisi ${o.coin}`);
      qty = Math.min(qty, Math.abs(pos.size));
    }
    const fill = Math.sign(signed) * qty;
    let newSize = pos.size + fill;
    if (pos.size !== 0 && Math.sign(fill) !== Math.sign(pos.size)) {
      const closed = Math.min(Math.abs(fill), Math.abs(pos.size));
      realized = closed * (px - pos.entryPx) * Math.sign(pos.size);
    }
    let entryPx = pos.entryPx;
    if (pos.size === 0 || Math.sign(newSize) !== Math.sign(pos.size)) entryPx = px;
    else if (Math.abs(newSize) > Math.abs(pos.size)) entryPx = (pos.entryPx * Math.abs(pos.size) + px * Math.abs(fill)) / Math.abs(newSize);
    if (Math.abs(newSize) < 1e-12) newSize = 0;
    const fee = qty * px * this.opts.feeRate;
    this.s.cash += realized - fee;
    this.s.fees += fee;
    if (newSize === 0) delete this.s.positions[o.coin];
    else this.s.positions[o.coin] = { size: newSize, entryPx };
    this.s.seq++;
    this.persist();
    return {
      id: `paper-${this.s.seq}`,
      t: this.opts.clock?.() ?? Date.now(),
      coin: o.coin,
      side: o.side,
      qty,
      px,
      fee,
      realizedPnl: realized,
      reduceOnly: o.reduceOnly,
    };
  }

  private persist() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify(this.s));
  }
}

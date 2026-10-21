import type { Venue } from '../../../shared/types';

export interface BrokerPosition {
  size: number; // bertanda: + long, - short (unit base)
  entryPx: number;
}

export interface Fill {
  id: string;
  t: number;
  coin: string;
  side: 'buy' | 'sell';
  qty: number;
  px: number;
  fee: number;
  realizedPnl: number;
  reduceOnly: boolean;
}

export interface OrderRequest {
  coin: string;
  side: 'buy' | 'sell';
  qty: number;
  reduceOnly: boolean;
  refPx: number;
}

export interface Broker {
  venue: Venue;
  live: boolean;
  init(): Promise<void>;
  equity(): Promise<number>;
  positions(): Promise<Record<string, BrokerPosition>>;
  markPrices(coins: string[]): Promise<Record<string, number>>;
  supports(coin: string): boolean;
  minNotional(coin: string): number;
  roundQty(coin: string, qty: number): number;
  ensureLeverage(coin: string, leverage: number): Promise<void>;
  marketOrder(o: OrderRequest): Promise<Fill>;
  feesPaid(): number;
  // Hanya paper: bebankan funding untuk slot yang lewat; mengembalikan entri ledger funding.
  settleFunding?(now: number): Promise<import('../../../shared/types').FundingEntry[]>;
  fundingPaid?(): number;
}

// Sumber harga mark (dipakai paper broker & mesin).
export interface PriceFeed {
  markPrices(coins: string[]): Promise<Record<string, number>>;
  listCoins(): Promise<string[]>;
  // Tarif funding per interval (Hyperliquid: per jam; Binance: per 8 jam).
  fundingRates?(): Promise<{ rates: Record<string, number>; intervalHours: number }>;
}

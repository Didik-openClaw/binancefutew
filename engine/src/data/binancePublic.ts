import type { Candle } from '../../../shared/types';
import { fetchJson } from '../lib/http';
import { intervalMs } from '../lib/time';
import { toBinanceSymbol } from './symbols';

export const BINANCE_FAPI = 'https://fapi.binance.com';

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

export async function binanceKlines(coin: string, interval: string, startTime: number, endTime: number, base = BINANCE_FAPI): Promise<Candle[]> {
  const symbol = toBinanceSymbol(coin);
  const step = intervalMs(interval);
  const out: Candle[] = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const rows = await fetchJson<RawKline[]>(url);
    if (!rows.length) break;
    for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    const lastT = rows[rows.length - 1][0];
    if (rows.length < 1500) break;
    cursor = lastT + step;
  }
  // Buang candle yang belum close.
  const now = Date.now();
  return out.filter((k) => k.t + step <= now);
}

export interface BinanceFundingRow {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

export async function binanceFunding(coin: string, startTime: number, endTime: number, base = BINANCE_FAPI) {
  const symbol = toBinanceSymbol(coin);
  const out: { t: number; rate: number }[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${base}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const rows = await fetchJson<BinanceFundingRow[]>(url);
    if (!rows.length) break;
    for (const r of rows) out.push({ t: r.fundingTime, rate: Number(r.fundingRate) });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].fundingTime + 1;
  }
  return out;
}

export interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  contractType: string;
  quoteAsset: string;
  filters: { filterType: string; stepSize?: string; minQty?: string; notional?: string; tickSize?: string }[];
}

export async function binanceExchangeInfo(base = BINANCE_FAPI) {
  return fetchJson<{ symbols: BinanceSymbolInfo[] }>(`${base}/fapi/v1/exchangeInfo`);
}

export async function binanceMarkPrices(base = BINANCE_FAPI): Promise<Record<string, number>> {
  const rows = await fetchJson<{ symbol: string; markPrice: string }[]>(`${base}/fapi/v1/premiumIndex`);
  return Object.fromEntries(rows.map((r) => [r.symbol, Number(r.markPrice)]));
}

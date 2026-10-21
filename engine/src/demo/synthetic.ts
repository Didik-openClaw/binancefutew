import type { Candle } from '../../../shared/types';
import { gaussian, mulberry32 } from '../lib/rng';
import { HOUR, weekStart } from '../lib/time';

// Pasar SINTETIS untuk demo & test. Tidak mewakili harga asli.
// Regime-switching: tren naik, tren turun, sideways; plus faktor pasar bersama antar koin.

export interface SyntheticCoin {
  coin: string;
  price: number;
  vol: number; // volatilitas tahunan
  beta: number;
}

export const DEMO_COINS: SyntheticCoin[] = [
  { coin: 'BTC', price: 108_000, vol: 0.5, beta: 1 },
  { coin: 'ETH', price: 3_900, vol: 0.65, beta: 1.15 },
  { coin: 'SOL', price: 190, vol: 0.85, beta: 1.3 },
  { coin: 'XRP', price: 2.4, vol: 0.8, beta: 1.1 },
  { coin: 'DOGE', price: 0.21, vol: 0.95, beta: 1.35 },
  { coin: 'BNB', price: 1_050, vol: 0.5, beta: 0.8 },
  { coin: 'SUI', price: 3.1, vol: 1.1, beta: 1.4 },
  { coin: 'AVAX', price: 24, vol: 0.95, beta: 1.3 },
  { coin: 'LINK', price: 19, vol: 0.9, beta: 1.2 },
  { coin: 'HYPE', price: 41, vol: 1.15, beta: 1.2 },
];

export interface SyntheticOptions {
  seed: number;
  bars: number;
  endTime: number; // open time bar terakhir
  barMs?: number;
  coins?: SyntheticCoin[];
}

export function syntheticCandles(o: SyntheticOptions): Record<string, Candle[]> {
  const barMs = o.barMs ?? HOUR;
  const coins = o.coins ?? DEMO_COINS;
  const rand = mulberry32(o.seed);
  const z = gaussian(rand);
  const barsPerYear = (365 * 24 * HOUR) / barMs;
  const start = o.endTime - (o.bars - 1) * barMs;
  // Regime pasar bersama, berganti rata-rata tiap ~10 hari.
  let regime = 0;
  const drifts = [0, 1.0, -0.9]; // drift tahunan per regime
  const regimeOf: number[] = [];
  for (let i = 0; i < o.bars; i++) {
    if (rand() < barMs / (10 * 24 * HOUR)) regime = Math.floor(rand() * 3);
    regimeOf.push(regime);
  }
  const market: number[] = [];
  for (let i = 0; i < o.bars; i++) market.push(z());
  const out: Record<string, Candle[]> = {};
  for (const c of coins) {
    const candles: Candle[] = [];
    let price = c.price;
    let idio = 0;
    const sigma = c.vol / Math.sqrt(barsPerYear);
    for (let i = 0; i < o.bars; i++) {
      // Tren idiosinkratik per koin yang berubah perlahan, supaya rotasi antar koin punya makna.
      idio = 0.995 * idio + 0.07 * z();
      const drift = (drifts[regimeOf[i]] * c.beta + idio * 0.9) / barsPerYear;
      const shock = sigma * (0.75 * market[i] + 0.66 * z());
      const open = price;
      const close = open * Math.exp(drift + shock);
      const wick = sigma * Math.abs(z()) * 0.6;
      const high = Math.max(open, close) * (1 + wick);
      const low = Math.min(open, close) * (1 - wick * (0.8 + rand() * 0.4));
      const v = (1_000_000 + rand() * 4_000_000) / Math.sqrt(price);
      candles.push({ t: start + i * barMs, o: open, h: high, l: low, c: close, v });
      price = close;
    }
    // Skala ulang supaya harga di ujung data mendekati level acuan (tampilan demo tetap masuk akal).
    const k = c.price / candles[candles.length - 1].c;
    for (const x of candles) {
      x.o *= k;
      x.h *= k;
      x.l *= k;
      x.c *= k;
    }
    out[c.coin] = candles;
  }
  return out;
}

// Ujung data dibulatkan ke awal jam; dipakai demo agar minggu terakhir terlihat "sedang berjalan".
export function alignedEnd(now: number, barMs = HOUR): number {
  return Math.floor(now / barMs) * barMs - barMs;
}

export { weekStart };

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../../../shared/types';
import { intervalMs, WEEK } from '../lib/time';
import type { Dataset } from '../strategies/types';
import { binanceFunding, binanceKlines } from './binancePublic';
import { HyperliquidInfo } from './hyperliquidInfo';

export type HistorySource = 'binance' | 'hyperliquid';

export interface History {
  raw: Record<string, Candle[]>;
  funding: Record<string, { t: number; rate: number }[]>;
  failed: { coin: string; error: string }[];
}

// Unduh candle (dengan cache di disk) untuk semua koin. Koin yang gagal dicatat, bukan menghentikan proses.
export async function loadHistory(opts: {
  coins: string[];
  interval: string;
  weeks: number;
  source: HistorySource;
  cacheDir: string;
  withFunding?: boolean;
  now?: number;
  log?: (msg: string) => void;
}): Promise<History> {
  const now = opts.now ?? Date.now();
  const step = intervalMs(opts.interval);
  const start = Math.floor((now - opts.weeks * WEEK) / step) * step;
  mkdirSync(opts.cacheDir, { recursive: true });
  const hl = new HyperliquidInfo();
  const out: History = { raw: {}, funding: {}, failed: [] };
  for (const coin of opts.coins) {
    const file = join(opts.cacheDir, `${opts.source}-${coin}-${opts.interval}.json`);
    try {
      let cached: Candle[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      // Cache hanya dipakai bila menutup awal periode; sisanya diunduh sejak candle cache terakhir.
      if (!cached.length || cached[0].t > start + step) cached = [];
      const from = cached.length ? cached[cached.length - 1].t + step : start;
      const fresh =
        opts.source === 'binance'
          ? await binanceKlines(coin, opts.interval, from, now)
          : await hl.candles(coin, opts.interval, from, now);
      const lastCached = cached.length ? cached[cached.length - 1].t : -Infinity;
      const merged = [...cached, ...fresh.filter((k) => k.t > lastCached)];
      // Simpan maksimal 80 minggu di disk.
      writeFileSync(file, JSON.stringify(merged.filter((k) => k.t >= now - 80 * WEEK)));
      out.raw[coin] = merged.filter((k) => k.t >= start);
      if (opts.withFunding) {
        out.funding[coin] =
          opts.source === 'binance' ? await binanceFunding(coin, start, now) : await hl.fundingHistory(coin, start, now);
      }
      opts.log?.(`  ${coin}: ${merged.length} candle`);
    } catch (e) {
      out.failed.push({ coin, error: e instanceof Error ? e.message : String(e) });
      opts.log?.(`  ${coin}: GAGAL (${e instanceof Error ? e.message : e})`);
    }
  }
  return out;
}

// Funding pada waktu ft dibebankan ke posisi yang dipegang selama bar yang memuat ft.
export function fundingPerBar(d: Dataset, events: Record<string, { t: number; rate: number }[]>) {
  const step = intervalMs(d.interval);
  const t0 = d.t[0];
  const out: Record<string, Float64Array> = {};
  for (const c of d.coins) {
    const arr = new Float64Array(d.t.length);
    for (const e of events[c] ?? []) {
      const i = Math.floor((e.t - t0) / step);
      if (i >= 0 && i < arr.length) arr[i] += e.rate;
    }
    out[c] = arr;
  }
  return out;
}

import { join } from 'node:path';
import { intervalMs, WEEK } from '../lib/time';
import type { Dataset } from '../strategies/types';
import { buildDataset } from './dataset';
import { fundingPerBar, loadHistory } from './history';

// Penyedia data historis untuk turnamen dan sleeve strategi.
export interface MarketHistory {
  dataset(coins: string[], interval: string, weeks: number): Promise<{ d: Dataset; funding?: Record<string, Float64Array>; failed: string[] }>;
  recent(coins: string[], interval: string, bars: number): Promise<Dataset>;
}

// Data asli: Binance (riwayat lebih panjang), koin yang tidak ada di Binance diambil dari Hyperliquid.
export class RealMarket implements MarketHistory {
  constructor(
    private cacheDir: string,
    private log: (m: string) => void = () => {},
  ) {}

  private async load(coins: string[], interval: string, weeks: number, withFunding: boolean) {
    const cacheDir = join(this.cacheDir, 'candles');
    const bn = await loadHistory({ coins, interval, weeks, source: 'binance', cacheDir, withFunding, log: this.log });
    const missing = bn.failed.map((f) => f.coin);
    if (missing.length) {
      this.log(`Mencoba Hyperliquid untuk: ${missing.join(', ')}`);
      const hl = await loadHistory({ coins: missing, interval, weeks, source: 'hyperliquid', cacheDir, withFunding, log: this.log });
      Object.assign(bn.raw, hl.raw);
      Object.assign(bn.funding, hl.funding);
      bn.failed = hl.failed;
    }
    return bn;
  }

  async dataset(coins: string[], interval: string, weeks: number) {
    const h = await this.load(coins, interval, weeks, true);
    const d = buildDataset(h.raw, interval, { benchmark: coins[0] });
    return { d, funding: fundingPerBar(d, h.funding), failed: h.failed.map((f) => f.coin) };
  }

  async recent(coins: string[], interval: string, bars: number) {
    const weeks = Math.ceil((bars * intervalMs(interval)) / WEEK) + 1;
    const h = await this.load(coins, interval, weeks, false);
    return buildDataset(h.raw, interval, { minCoverage: 0.9 });
  }
}

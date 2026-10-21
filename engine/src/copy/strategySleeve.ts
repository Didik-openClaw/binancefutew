import type { Playbook } from '../../../shared/types';
import type { MarketHistory } from '../data/market';
import { intervalMs } from '../lib/time';
import type { RiskProfile } from '../risk/profiles';
import { getStrategy } from '../strategies/catalog';
import { strategyPositions } from '../strategies/sizing';

const WARMUP_BARS = 1200; // cukup untuk lookback terpanjang (336) + volatilitas (168) + jejak hysteresis

// Menghitung leverage target strategi pilihan minggu ini. Dihitung ulang hanya saat bar baru close,
// memakai kode sinyal & sizing yang sama persis dengan backtest.
export class StrategySleeve {
  private lastBar = -1;
  private leverage: Record<string, number> = {};
  private picks: { strategy: string; params: Record<string, number>; universe: string[]; weight: number }[] = [];

  constructor(
    private market: MarketHistory,
    private interval: string,
    private profile: RiskProfile,
  ) {}

  setPlaybook(pb: Playbook | null, entries: { id: string; strategy: string; params: Record<string, number>; universe: string[] }[]) {
    this.picks = (pb?.strategies ?? [])
      .map((s) => {
        const e = entries.find((x) => x.id === s.id);
        return e ? { strategy: e.strategy, params: e.params, universe: e.universe, weight: s.weight } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    this.lastBar = -1;
  }

  setProfile(p: RiskProfile) {
    this.profile = p;
    this.lastBar = -1;
  }

  nextBarAt(now: number) {
    const step = intervalMs(this.interval);
    return (Math.floor(now / step) + 1) * step;
  }

  async update(now: number): Promise<Record<string, number>> {
    const step = intervalMs(this.interval);
    const bar = Math.floor(now / step);
    if (bar === this.lastBar) return this.leverage;
    if (!this.picks.length) {
      this.leverage = {};
      this.lastBar = bar;
      return this.leverage;
    }
    const coins = [...new Set(this.picks.flatMap((p) => p.universe))];
    const d = await this.market.recent(coins, this.interval, WARMUP_BARS);
    const out: Record<string, number> = {};
    for (const p of this.picks) {
      if (!p.universe.every((c) => d.series[c])) continue;
      const pos = strategyPositions(getStrategy(p.strategy), p.params, d, p.universe, {
        targetVol: this.profile.targetVol,
        maxLeverage: this.profile.maxPositionLeverage,
        barsPerYear: d.barsPerYear,
      });
      for (const [coin, arr] of Object.entries(pos)) {
        const lev = arr[arr.length - 1];
        if (lev) out[coin] = (out[coin] ?? 0) + lev * p.weight;
      }
    }
    this.leverage = out;
    this.lastBar = bar;
    return out;
  }
}

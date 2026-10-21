import type { BrokerPosition, OrderRequest } from '../exchanges/types';
import type { LeaderSnapshot } from '../sources/leaders';

export interface TargetInput {
  equity: number;
  allocation: { strategy: number; copy: number };
  copyMultiplier: number;
  leaders: { snapshot: LeaderSnapshot; weight: number; exclude?: Set<string> }[];
  // Leverage strategi per koin (sudah dikali bobot pilihan), sebelum dikali alokasi.
  strategyLeverage: Record<string, number>;
  supports: (coin: string) => boolean;
}

export interface Targets {
  notional: Record<string, number>; // bertanda, USD
  sources: Record<string, string[]>;
  skipped: string[]; // koin leader yang tidak tersedia di venue follower
}

// Posisi target = proporsi eksposur leader terhadap ekuitasnya, diterapkan ke modal sleeve copy,
// ditambah target sleeve strategi.
export function computeTargets(i: TargetInput): Targets {
  const notional: Record<string, number> = {};
  const sources: Record<string, string[]> = {};
  const skipped = new Set<string>();
  const add = (coin: string, v: number, src: string) => {
    if (!v) return;
    notional[coin] = (notional[coin] ?? 0) + v;
    (sources[coin] ??= []).includes(src) || sources[coin].push(src);
  };
  const copyCapital = i.equity * i.allocation.copy;
  for (const { snapshot, weight, exclude } of i.leaders) {
    if (!(snapshot.equity > 0) || !weight) continue;
    for (const [coin, p] of Object.entries(snapshot.positions)) {
      if (exclude?.has(coin)) continue;
      if (!i.supports(coin)) {
        skipped.add(coin);
        continue;
      }
      const fraction = (p.size * p.px) / snapshot.equity;
      add(coin, fraction * weight * copyCapital * i.copyMultiplier, snapshot.id);
    }
  }
  const stratCapital = i.equity * i.allocation.strategy;
  for (const [coin, lev] of Object.entries(i.strategyLeverage)) {
    if (!i.supports(coin)) {
      skipped.add(coin);
      continue;
    }
    add(coin, lev * stratCapital, 'strategy');
  }
  return { notional, sources, skipped: [...skipped] };
}

// Batas risiko: notional per koin dan total gross relatif ekuitas.
export function capTargets(
  notional: Record<string, number>,
  equity: number,
  limits: { maxPositionLeverage: number; maxGrossLeverage: number },
): { notional: Record<string, number>; scaled: boolean } {
  const out: Record<string, number> = {};
  const perCoin = limits.maxPositionLeverage * equity;
  let gross = 0;
  let scaled = false;
  for (const [c, v] of Object.entries(notional)) {
    const capped = Math.max(-perCoin, Math.min(perCoin, v));
    if (capped !== v) scaled = true;
    out[c] = capped;
    gross += Math.abs(capped);
  }
  const maxGross = limits.maxGrossLeverage * equity;
  if (gross > maxGross && gross > 0) {
    const k = maxGross / gross;
    for (const c of Object.keys(out)) out[c] *= k;
    scaled = true;
  }
  return { notional: out, scaled };
}

export interface PlanOptions {
  minOrderUsd: number;
  band: number; // abaikan selisih < band x |target|
  roundQty: (coin: string, qty: number) => number;
  minNotional: (coin: string) => number;
}

// Rencana order dari posisi sekarang ke target. Pengurangan & penutupan dieksekusi duluan
// supaya margin terbebas sebelum menambah posisi.
export function planOrders(
  targets: Record<string, number>,
  current: Record<string, BrokerPosition>,
  marks: Record<string, number>,
  o: PlanOptions,
): OrderRequest[] {
  const reduce: OrderRequest[] = [];
  const increase: OrderRequest[] = [];
  const coins = new Set([...Object.keys(targets), ...Object.keys(current)]);
  for (const coin of coins) {
    const px = marks[coin];
    if (!px) continue;
    const size = current[coin]?.size ?? 0;
    const cur = size * px;
    const tgt = targets[coin] ?? 0;
    const minUsd = Math.max(o.minOrderUsd, o.minNotional(coin));
    const flip = size !== 0 && tgt !== 0 && Math.sign(tgt) !== Math.sign(size);
    // Target nol atau terlalu kecil untuk dipegang -> tutup penuh.
    if (size !== 0 && (Math.abs(tgt) < minUsd || flip)) {
      reduce.push({ coin, side: size > 0 ? 'sell' : 'buy', qty: Math.abs(size), reduceOnly: true, refPx: px });
      if (flip && Math.abs(tgt) >= minUsd) {
        const qty = o.roundQty(coin, Math.abs(tgt) / px);
        if (qty > 0) increase.push({ coin, side: tgt > 0 ? 'buy' : 'sell', qty, reduceOnly: false, refPx: px });
      }
      continue;
    }
    const delta = tgt - cur;
    if (Math.abs(delta) < Math.max(minUsd, o.band * Math.abs(tgt))) continue;
    const qty = o.roundQty(coin, Math.abs(delta) / px);
    if (qty <= 0) continue;
    const side = delta > 0 ? 'buy' : 'sell';
    const reducing = size !== 0 && Math.abs(tgt) < Math.abs(cur);
    (reducing ? reduce : increase).push({ coin, side, qty: reducing ? Math.min(qty, Math.abs(size)) : qty, reduceOnly: reducing, refPx: px });
  }
  return [...reduce, ...increase];
}

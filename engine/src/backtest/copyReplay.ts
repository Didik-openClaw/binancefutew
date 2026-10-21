import type { Candle } from '../../../shared/types';
import type { HlFill } from '../data/hyperliquidInfo';
import { HOUR } from '../lib/time';
import { maxDrawdown } from './metrics';

// Replay copy trading dari data asli: posisi leader direkonstruksi dari fill-nya sendiri
// (startPosition + ukuran), lalu disalin dengan aturan yang sama dengan engine live
// (proporsi eksposur x pengali, batas per koin & gross, ambang order minimum, kill switch 7 hari).
// Eksekusi memakai harga fill leader + slippage + penalti keterlambatan; mark-to-market & funding per jam.

export interface ReplayInputs {
  leader: string;
  from: number;
  to: number;
  fills: HlFill[]; // urut waktu, berisi startPosition
  leaderEquity: [number, number][]; // [ms, accountValue]
  // accountValue = kurva nilai akun Hyperliquid; pnl+flows = akun unified, direkonstruksi dari PnL perp + arus dana.
  equitySource?: 'accountValue' | 'pnl+flows';
  flows?: [number, number][]; // arus dana bersih di luar trading (akun unified)
  openAtEnd: Record<string, number>; // posisi leader saat ini (untuk koin tanpa fill di jendela)
  candles: Record<string, Candle[]>; // 1h
  funding: Record<string, { t: number; rate: number }[]>;
}

export interface ReplayOptions {
  startEquity: number;
  copyMultiplier: number;
  maxPositionLeverage: number;
  maxGrossLeverage: number;
  feeRate: number;
  slippage: number; // per sisi
  latencyPenalty: number; // harga lebih buruk karena terlambat menyalin
  minOrderUsd: number;
  band: number;
  killSwitch: number; // rugi per siklus 7 hari, mis. 0.25
  entryPolicy: 'mirror' | 'new-only';
}

export interface ReplayTrade {
  t: number;
  coin: string;
  side: 'buy' | 'sell';
  qty: number;
  px: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  leaderSize: number; // posisi leader setelah fill yang memicu order ini
  leaderEquity: number;
  reason: string;
}

export interface ReplayResult {
  equity: { t: number; equity: number }[];
  trades: ReplayTrade[];
  stats: {
    startEquity: number;
    endEquity: number;
    totalReturn: number;
    maxDrawdown: number;
    fees: number;
    funding: number;
    realized: number;
    trades: number;
    skippedSmall: number;
    killSwitchHits: number;
    leaderReturn: number; // perubahan nilai akun leader di jendela yang sama (termasuk deposit)
    coins: string[];
  };
}

interface Pos {
  size: number;
  entry: number;
}

function equityAt(series: [number, number][], t: number): number {
  let v = series[0]?.[1] ?? 0;
  for (const [ts, val] of series) {
    if (ts > t) break;
    v = val;
  }
  return v;
}

export function replayCopy(inp: ReplayInputs, o: ReplayOptions): ReplayResult {
  const coins = [...new Set([...inp.fills.map((f) => f.coin), ...Object.keys(inp.openAtEnd)])].filter((c) => inp.candles[c]?.length);
  // Harga per jam per koin untuk mark-to-market.
  const closeAt = new Map<string, Map<number, number>>();
  for (const c of coins) closeAt.set(c, new Map(inp.candles[c].map((k) => [k.t, k.c])));
  const lastPx: Record<string, number> = {};
  const priceAtOpen = (c: string, t: number) => {
    const k = inp.candles[c].find((x) => x.t >= t) ?? inp.candles[c][inp.candles[c].length - 1];
    return k.o;
  };

  // Posisi leader di awal jendela.
  const leaderPos: Record<string, number> = {};
  for (const c of coins) {
    const first = inp.fills.find((f) => f.coin === c);
    leaderPos[c] = first ? Number(first.startPosition ?? 0) : (inp.openAtEnd[c] ?? 0);
  }
  const excluded = new Set<string>();
  if (o.entryPolicy === 'new-only') for (const c of coins) if (leaderPos[c]) excluded.add(c);

  let cash = o.startEquity;
  let fees = 0;
  let fundingPaid = 0;
  let realized = 0;
  let skipped = 0;
  let killHits = 0;
  const pos: Record<string, Pos> = {};
  const trades: ReplayTrade[] = [];
  const equity: { t: number; equity: number }[] = [];

  const ourEquity = () => cash + Object.entries(pos).reduce((a, [c, p]) => a + p.size * ((lastPx[c] ?? p.entry) - p.entry), 0);

  const trade = (t: number, coin: string, deltaQty: number, refPx: number, reason: string, reduceOnly: boolean) => {
    const side = deltaQty > 0 ? 'buy' : 'sell';
    const adverse = o.slippage + o.latencyPenalty;
    const px = side === 'buy' ? refPx * (1 + adverse) : refPx * (1 - adverse);
    const p = pos[coin] ?? { size: 0, entry: px };
    let qty = Math.abs(deltaQty);
    if (reduceOnly) qty = Math.min(qty, Math.abs(p.size));
    const signed = Math.sign(deltaQty) * qty;
    let r = 0;
    if (p.size !== 0 && Math.sign(signed) !== Math.sign(p.size)) r = Math.min(qty, Math.abs(p.size)) * (px - p.entry) * Math.sign(p.size);
    const newSize = p.size + signed;
    let entry = p.entry;
    if (p.size === 0 || Math.sign(newSize) !== Math.sign(p.size)) entry = px;
    else if (Math.abs(newSize) > Math.abs(p.size)) entry = (p.entry * Math.abs(p.size) + px * qty) / Math.abs(newSize);
    const fee = qty * px * o.feeRate;
    cash += r - fee;
    fees += fee;
    realized += r;
    if (Math.abs(newSize) < 1e-12) delete pos[coin];
    else pos[coin] = { size: newSize, entry };
    lastPx[coin] = refPx;
    trades.push({ t, coin, side, qty, px, notional: qty * px, fee, realizedPnl: r, leaderSize: leaderPos[coin] ?? 0, leaderEquity: equityAt(inp.leaderEquity, t), reason });
  };

  // Sinkronkan satu koin ke target berdasarkan posisi leader saat ini.
  const sync = (t: number, coin: string, refPx: number, reason: string) => {
    lastPx[coin] = refPx;
    const E = ourEquity();
    const lev = equityAt(inp.leaderEquity, t);
    const lp = excluded.has(coin) ? 0 : leaderPos[coin] ?? 0;
    let target = lev > 0 ? ((lp * refPx) / lev) * E * o.copyMultiplier : 0;
    target = Math.max(-o.maxPositionLeverage * E, Math.min(o.maxPositionLeverage * E, target));
    const otherGross = Object.entries(pos).reduce((a, [c, p]) => (c === coin ? a : a + Math.abs(p.size * (lastPx[c] ?? p.entry))), 0);
    const room = Math.max(0, o.maxGrossLeverage * E - otherGross);
    if (Math.abs(target) > room) target = Math.sign(target) * room;
    const curSize = pos[coin]?.size ?? 0;
    const cur = curSize * refPx;
    const flip = curSize !== 0 && target !== 0 && Math.sign(target) !== Math.sign(curSize);
    if (curSize !== 0 && (Math.abs(target) < o.minOrderUsd || flip)) {
      trade(t, coin, -curSize, refPx, `${reason} · tutup`, true);
      if (flip && Math.abs(target) >= o.minOrderUsd) trade(t, coin, target / refPx, refPx, `${reason} · balik arah`, false);
      return;
    }
    const delta = target - cur;
    if (Math.abs(delta) < Math.max(o.minOrderUsd, o.band * Math.abs(target))) {
      if (Math.abs(delta) >= 1) skipped++;
      return;
    }
    const reducing = curSize !== 0 && Math.abs(target) < Math.abs(cur);
    trade(t, coin, delta / refPx, refPx, reason, reducing);
  };

  const flattenAll = (t: number, reason: string) => {
    for (const [c, p] of Object.entries(pos)) trade(t, c, -p.size, lastPx[c] ?? p.entry, reason, true);
  };

  // Garis waktu: bar per jam + fill leader.
  const start = Math.floor(inp.from / HOUR) * HOUR;
  const fills = inp.fills.filter((f) => f.time >= inp.from && f.time <= inp.to).sort((a, b) => a.time - b.time);
  let fi = 0;
  let periodStart = start;
  let periodBase = o.startEquity;
  let haltedUntil = 0;
  // Setelah kill switch, engine live menyalin ulang semua posisi leader di awal siklus berikutnya.
  let resumePending = false;
  // Masuk posisi leader yang sudah terbuka di awal jendela.
  for (const c of coins) {
    lastPx[c] = priceAtOpen(c, start);
    if (o.entryPolicy === 'mirror' && leaderPos[c]) sync(start, c, lastPx[c], 'posisi awal leader');
  }
  equity.push({ t: start, equity: ourEquity() });
  for (let h = start; h < inp.to; h += HOUR) {
    const barEnd = h + HOUR;
    if (resumePending && h >= haltedUntil) {
      resumePending = false;
      for (const c of coins) if (leaderPos[c]) sync(h, c, lastPx[c], 'siklus baru setelah kill switch');
    }
    while (fi < fills.length && fills[fi].time < barEnd) {
      const f = fills[fi++];
      if (!coins.includes(f.coin)) continue;
      const after = Number(f.startPosition ?? 0) + Number(f.sz) * (f.side === 'B' ? 1 : -1);
      const before = leaderPos[f.coin] ?? 0;
      leaderPos[f.coin] = Math.abs(after) < 1e-12 ? 0 : after;
      // new-only: koin yang sudah terbuka saat mulai baru diikuti setelah leader menutup/membalik.
      if (excluded.has(f.coin) && (leaderPos[f.coin] === 0 || Math.sign(leaderPos[f.coin]) !== Math.sign(before))) excluded.delete(f.coin);
      if (f.time < haltedUntil) continue;
      sync(f.time, f.coin, Number(f.px), `ikut ${f.dir || (f.side === 'B' ? 'beli' : 'jual')} leader`);
    }
    // Funding per jam & mark-to-market di close bar.
    for (const c of coins) {
      const px = closeAt.get(c)?.get(h);
      if (px !== undefined) lastPx[c] = px;
    }
    for (const [c, p] of Object.entries(pos)) {
      const rate = (inp.funding[c] ?? []).filter((x) => x.t >= h && x.t < barEnd).reduce((a, x) => a + x.rate, 0);
      if (rate) {
        const pay = p.size * (lastPx[c] ?? p.entry) * rate;
        cash -= pay;
        fundingPaid += pay;
      }
    }
    // Kill switch per siklus 7 hari sejak awal.
    if (barEnd - periodStart >= 7 * 24 * HOUR) {
      periodStart = barEnd;
      periodBase = ourEquity();
    }
    if (barEnd >= haltedUntil && ourEquity() <= periodBase * (1 - o.killSwitch)) {
      flattenAll(barEnd, 'kill switch');
      killHits++;
      haltedUntil = periodStart + 7 * 24 * HOUR;
      resumePending = true;
    }
    equity.push({ t: barEnd, equity: ourEquity() });
  }

  const eqs = equity.map((p) => p.equity);
  const l0 = equityAt(inp.leaderEquity, inp.from);
  const l1 = equityAt(inp.leaderEquity, inp.to);
  return {
    equity,
    trades,
    stats: {
      startEquity: o.startEquity,
      endEquity: eqs[eqs.length - 1],
      totalReturn: eqs[eqs.length - 1] / o.startEquity - 1,
      maxDrawdown: maxDrawdown(eqs),
      fees,
      funding: fundingPaid,
      realized,
      trades: trades.length,
      skippedSmall: skipped,
      killSwitchHits: killHits,
      leaderReturn: l0 > 0 ? l1 / l0 - 1 : 0,
      coins,
    },
  };
}

// Potong input ke jendela [from, to]: posisi leader di dalam jendela tetap benar walau koin
// tidak punya fill di dalamnya (posisi akhir jendela = startPosition fill pertama sesudahnya).
export function sliceInputs(inp: ReplayInputs, from: number, to: number): ReplayInputs {
  const fills = inp.fills.filter((f) => f.time >= from && f.time <= to);
  const openAtEnd: Record<string, number> = {};
  for (const c of new Set([...inp.fills.map((f) => f.coin), ...Object.keys(inp.openAtEnd)])) {
    const next = inp.fills.find((f) => f.coin === c && f.time > to);
    const size = next ? Number(next.startPosition ?? 0) : (inp.openAtEnd[c] ?? 0);
    if (size) openAtEnd[c] = size;
  }
  return { ...inp, from, to, fills, openAtEnd };
}

export interface RollingStats {
  days: number;
  stepHours: number;
  n: number;
  median: number;
  mean: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  worst: number;
  best: number;
  lossShare: number; // porsi titik mulai yang berakhir rugi
  killShare: number; // porsi titik mulai yang kena kill switch
  medianMaxDrawdown: number;
}

// Semua kemungkinan "mulai hari ini": tiap stepHours, $startEquity mulai menyalin dari nol
// (mirror posisi leader saat itu) selama `days` hari. Jawaban jujur untuk "kalau saya mulai minggu ini?".
export function rollingStarts(inp: ReplayInputs, o: ReplayOptions, days = 7, stepHours = 24) {
  const span = days * 24 * HOUR;
  const first = Math.ceil(inp.from / HOUR) * HOUR;
  const runs: { start: number; ret: number; maxDrawdown: number; killed: boolean }[] = [];
  for (let t = first; t + span <= inp.to; t += stepHours * HOUR) {
    const r = replayCopy(sliceInputs(inp, t, t + span), o);
    runs.push({ start: t, ret: r.stats.totalReturn, maxDrawdown: r.stats.maxDrawdown, killed: r.stats.killSwitchHits > 0 });
  }
  const rets = runs.map((r) => r.ret).sort((a, b) => a - b);
  const q = (p: number) => (rets.length ? rets[Math.min(rets.length - 1, Math.max(0, Math.round(p * (rets.length - 1))))] : 0);
  const dds = runs.map((r) => r.maxDrawdown).sort((a, b) => a - b);
  const stats: RollingStats = {
    days,
    stepHours,
    n: runs.length,
    median: q(0.5),
    mean: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    p10: q(0.1),
    p25: q(0.25),
    p75: q(0.75),
    p90: q(0.9),
    worst: rets[0] ?? 0,
    best: rets[rets.length - 1] ?? 0,
    lossShare: runs.length ? runs.filter((r) => r.ret < 0).length / runs.length : 0,
    killShare: runs.length ? runs.filter((r) => r.killed).length / runs.length : 0,
    medianMaxDrawdown: dds.length ? dds[Math.floor(dds.length / 2)] : 0,
  };
  return { runs, stats };
}

// Audit: hitung ulang ekuitas hanya dari ledger trade + harga, bandingkan dengan angka yang dilaporkan.
export function auditLedger(
  startEquity: number,
  trades: { coin: string; side: 'buy' | 'sell'; qty: number; px: number; fee: number }[],
  marks: Record<string, number>,
  extraCash = 0,
): { equity: number; positions: Record<string, number>; realized: number; fees: number } {
  const pos: Record<string, { size: number; entry: number }> = {};
  let cash = startEquity + extraCash;
  let realized = 0;
  let fees = 0;
  for (const t of trades) {
    const p = pos[t.coin] ?? { size: 0, entry: t.px };
    const signed = t.side === 'buy' ? t.qty : -t.qty;
    let r = 0;
    if (p.size !== 0 && Math.sign(signed) !== Math.sign(p.size)) r = Math.min(t.qty, Math.abs(p.size)) * (t.px - p.entry) * Math.sign(p.size);
    const n = p.size + signed;
    let entry = p.entry;
    if (p.size === 0 || Math.sign(n) !== Math.sign(p.size)) entry = t.px;
    else if (Math.abs(n) > Math.abs(p.size)) entry = (p.entry * Math.abs(p.size) + t.px * t.qty) / Math.abs(n);
    cash += r - t.fee;
    realized += r;
    fees += t.fee;
    if (Math.abs(n) < 1e-12) delete pos[t.coin];
    else pos[t.coin] = { size: n, entry };
  }
  const upnl = Object.entries(pos).reduce((a, [c, p]) => a + p.size * ((marks[c] ?? p.entry) - p.entry), 0);
  return { equity: cash + upnl, positions: Object.fromEntries(Object.entries(pos).map(([c, p]) => [c, p.size])), realized, fees };
}

import type { LeaderView, VetView } from '../../../shared/types';
import { replayCopy, type ReplayInputs, type ReplayOptions } from '../backtest/copyReplay';
import { psr } from '../backtest/stats';
import { DAY } from '../lib/time';

// Uji salin historis: kandidat dari scout disalin ulang dari fill aslinya selama N hari dengan aturan
// engine (ukuran, batas leverage, fee, slippage, funding, kill switch). ROI leaderboard mengukur trader;
// uji ini mengukur hasil KITA bila menyalinnya. Yang gagal tidak disalin, seberapa pun bagus ROI-nya.

export interface VetOptions {
  days: number;
  top: number; // berapa kandidat teratas scout yang diuji
  replay: ReplayOptions;
  minActiveWeeks: number; // minggu dengan order: menyaring trader yang baru aktif / jarang trading
  minPsr: number; // peluang Sharpe mingguan > 0
}

export const VET_DEFAULTS = { days: 120, top: 12, minActiveWeeks: 8, minPsr: 0.8 };

export type FetchInputs = (address: string) => Promise<ReplayInputs>;

const WEEK = 7 * DAY;

export function vetOne(address: string, inputs: ReplayInputs, o: VetOptions): VetView {
  const r = replayCopy(inputs, o.replay);
  const weekly: number[] = [];
  let active = 0;
  for (let start = inputs.from; start + WEEK <= inputs.to + DAY; start += WEEK) {
    const a = r.equity.filter((p) => p.t <= start).pop() ?? r.equity[0];
    const b = r.equity.filter((p) => p.t <= start + WEEK).pop();
    if (!a || !b || a.equity <= 0) continue;
    weekly.push(b.equity / a.equity - 1);
    if (r.trades.some((t) => t.t >= start && t.t < start + WEEK)) active++;
  }
  const s = r.stats;
  const p = psr(weekly);
  const growth = weekly.length && s.endEquity > 0 ? (s.endEquity / s.startEquity) ** (1 / weekly.length) - 1 : -1;
  const maxKills = Math.max(1, Math.floor(weekly.length / 10));
  const maxDd = Math.min(0.9, o.replay.killSwitch * 2);
  const reason =
    active < o.minActiveWeeks
      ? `aktif hanya ${active} dari ${weekly.length} minggu (min ${o.minActiveWeeks})`
      : s.totalReturn <= 0
        ? `rugi ${(s.totalReturn * 100).toFixed(1)}%`
        : s.killSwitchHits > maxKills
          ? `kena kill switch ${s.killSwitchHits}× (maks ${maxKills})`
          : s.maxDrawdown > maxDd
            ? `drawdown ${(s.maxDrawdown * 100).toFixed(0)}% (maks ${(maxDd * 100).toFixed(0)}%)`
            : p < o.minPsr
              ? `hasil mingguan belum meyakinkan (PSR ${p.toFixed(2)} < ${o.minPsr})`
              : undefined;
  return {
    address,
    days: o.days,
    copyMultiplier: o.replay.copyMultiplier,
    weeks: weekly.length,
    activeWeeks: active,
    weeksUp: weekly.filter((w) => w > 0).length,
    totalReturn: s.totalReturn,
    weeklyGrowth: growth,
    worstWeek: weekly.length ? Math.min(...weekly) : 0,
    maxDrawdown: s.maxDrawdown,
    killSwitchHits: s.killSwitchHits,
    psr: p,
    orders: s.trades,
    pass: !reason,
    reason,
  };
}

// Uji kandidat teratas, lalu susun ulang: yang lolos diurutkan menurut pertumbuhan mingguan
// (geometris, sudah termasuk biaya), slot salin diisi dari sana. Bobot dibagi seperti scout.
export async function vetLeaders(leaders: LeaderView[], o: VetOptions, fetchInputs: FetchInputs, slots: number, concentration: number, log: (m: string) => void = () => {}) {
  const pool = leaders.filter((l) => l.status !== 'rejected' && !l.address.includes(':')).slice(0, o.top);
  const results = new Map<string, VetView>();
  for (const l of pool) {
    try {
      const v = vetOne(l.address, await fetchInputs(l.address), o);
      results.set(l.address, v);
      log(`  uji salin ${l.label}: ${(v.totalReturn * 100).toFixed(1)}% / ${o.days} hari, DD ${(v.maxDrawdown * 100).toFixed(0)}%, ${v.weeksUp}/${v.weeks} minggu profit → ${v.pass ? 'LOLOS' : `gagal: ${v.reason}`}`);
    } catch (e) {
      log(`  uji salin ${l.label} gagal dijalankan (${e instanceof Error ? e.message : e})`);
    }
  }
  const passed = pool.filter((l) => results.get(l.address)?.pass).sort((a, b) => results.get(b.address)!.weeklyGrowth - results.get(a.address)!.weeklyGrowth);
  const chosen = passed.slice(0, slots);
  // Skor = pertumbuhan mingguan relatif terhadap yang terbaik (0..1), lalu softmax bersuhu seperti scout.
  const best = Math.max(...chosen.map((l) => results.get(l.address)!.weeklyGrowth), 1e-9);
  const raw = chosen.map((l) => Math.max(results.get(l.address)!.weeklyGrowth / best, 1e-6) ** (1 / concentration));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const weight = new Map(chosen.map((l, i) => [l.address, raw[i] / total]));
  const out = leaders.map((l): LeaderView => {
    const v = results.get(l.address);
    if (!v) return { ...l, weight: 0, status: l.status === 'copying' ? 'candidate' : l.status };
    return {
      ...l,
      vet: v,
      weight: weight.get(l.address) ?? 0,
      status: weight.has(l.address) ? 'copying' : v.pass ? 'candidate' : 'rejected',
      reason: v.pass ? l.reason : `Uji salin ${o.days} hari: ${v.reason}`,
    };
  });
  const rank = (l: LeaderView) => (weight.has(l.address) ? 0 : l.vet?.pass ? 1 : l.status === 'rejected' ? 3 : 2);
  out.sort((a, b) => rank(a) - rank(b) || (b.vet?.weeklyGrowth ?? -1) - (a.vet?.weeklyGrowth ?? -1) || b.score - a.score);
  return { leaders: out, tested: results.size, passed: passed.length };
}

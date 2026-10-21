import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayCopy, type ReplayInputs, type ReplayOptions, type ReplayResult } from './backtest/copyReplay';
import { HyperliquidInfo, stableFlows, tradingEquity } from './data/hyperliquidInfo';
import { isStandardPerp } from './scout/hyperliquidScout';
import { DAY, HOUR } from './lib/time';
import type { ReplayView } from '../../shared/types';
import type { RiskProfile } from './risk/profiles';

// Kumpulkan semua input replay dari API Hyperliquid (first-party), simpan ke disk supaya hasil
// bisa dihitung ulang siapa pun dengan data yang sama persis.
// prev = input yang tersimpan sebelumnya: candle & funding lama dipakai ulang, hanya sisanya yang diunduh.
export async function fetchReplayInputs(address: string, days: number, now = Date.now(), log: (m: string) => void = () => {}, prev?: ReplayInputs): Promise<ReplayInputs> {
  const info = new HyperliquidInfo();
  const from = Math.floor((now - days * DAY) / HOUR) * HOUR;
  const to = Math.floor(now / HOUR) * HOUR;
  log(`  ${address}: fill ${days} hari…`);
  const fills = (await info.userFillsByTime(address, from, now, 20)).sort((a, b) => a.time - b.time);
  const [portfolio, state] = await Promise.all([info.portfolio(address), info.clearinghouseState(address)]);
  const eq = await tradingEquity(info, address, state);
  const span = days <= 7 ? 'week' : days <= 30 ? 'month' : 'allTime';
  let leaderEquity: [number, number][];
  let flows: [number, number][] | undefined;
  if (eq.mode === 'unifiedAccount' || eq.mode === 'portfolioMargin') {
    // Akun unified: modal trading saat t = modal sekarang − PnL perp sesudah t − arus dana bersih sesudah t.
    const pnl = portfolio.find(([k]) => k === `perp${span[0].toUpperCase()}${span.slice(1)}`)?.[1]?.pnlHistory ?? [];
    const last = pnl.length ? Number(pnl[pnl.length - 1][1]) : 0;
    const firstT = Math.min(from, pnl[0]?.[0] ?? from);
    const ledger = await info.userNonFundingLedgerUpdates(address, firstT, now);
    flows = stableFlows(address, ledger, fills.filter((f) => f.coin.startsWith('@') || f.coin.includes('/')));
    const after = (t: number) => flows!.reduce((a, [ft, v]) => (ft > t ? a + v : a), 0);
    leaderEquity = pnl.map(([t, v]) => [t, eq.equity - (last - Number(v)) - after(t)] as [number, number]);
    const net = after(from);
    log(`    akun ${eq.mode}: modal trading $${eq.equity.toFixed(0)} (saldo perp $${eq.perpAccountValue.toFixed(0)}), arus dana bersih sejak awal ${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(0)}`);
    const low = Math.min(...leaderEquity.filter(([t]) => t >= from).map(([, v]) => v));
    if (low < eq.equity * 0.05) log(`    PERINGATAN: rekonstruksi modal turun ke $${low.toFixed(0)}; data akun tidak konsisten`);
  } else {
    leaderEquity = (portfolio.find(([k]) => k === span)?.[1]?.accountValueHistory ?? []).map(([t, v]) => [t, Number(v)] as [number, number]);
  }
  if (!leaderEquity.length) leaderEquity = [[from, eq.equity]];
  const openAtEnd: Record<string, number> = {};
  for (const { position: p } of state.assetPositions) if (Number(p.szi)) openAtEnd[p.coin] = Number(p.szi);
  const coins = [...new Set([...fills.map((f) => f.coin), ...Object.keys(openAtEnd)])].filter(isStandardPerp);
  const candles: ReplayInputs['candles'] = {};
  const funding: ReplayInputs['funding'] = {};
  for (const c of coins) {
    const oldC = prev?.candles[c]?.filter((k) => k.t >= from - HOUR) ?? [];
    const oldF = prev?.funding[c]?.filter((x) => x.t >= from) ?? [];
    // Pakai ulang hanya bila data lama menutup awal jendela.
    const reuse = oldC.length > 0 && oldC[0].t <= from && prev!.from <= from;
    log(`    ${c}: candle & funding${reuse ? ' (lanjutan)' : ''}`);
    const cStart = reuse ? oldC[oldC.length - 1].t + HOUR : from - HOUR;
    const fStart = reuse && oldF.length ? oldF[oldF.length - 1].t + 1 : from;
    candles[c] = [...(reuse ? oldC : []), ...(await info.candles(c, '1h', cStart, now))];
    funding[c] = [...(reuse ? oldF : []), ...(await info.fundingHistory(c, fStart, now))];
  }
  return {
    leader: address,
    from,
    to,
    fills: fills.filter((f) => coins.includes(f.coin)),
    leaderEquity,
    equitySource: flows ? 'pnl+flows' : 'accountValue',
    ...(flows ? { flows } : {}),
    openAtEnd,
    candles,
    funding,
  };
}

// Input replay untuk banyak trader sekaligus: candle & funding koin yang sama diunduh sekali.
export function replayFetcher(days: number, log: (m: string) => void = () => {}) {
  let pool: ReplayInputs | undefined;
  return async (address: string) => {
    const inp = await fetchReplayInputs(address, days, Date.now(), log, pool);
    pool = { ...inp, from: Math.min(pool?.from ?? inp.from, inp.from), candles: { ...pool?.candles, ...inp.candles }, funding: { ...pool?.funding, ...inp.funding } };
    return inp;
  };
}

export function replayOptions(profile: RiskProfile, startEquity: number, entryPolicy: 'mirror' | 'new-only', copyMultiplier = profile.copyMultiplier): ReplayOptions {
  return {
    startEquity,
    copyMultiplier,
    maxPositionLeverage: profile.maxPositionLeverage,
    maxGrossLeverage: profile.maxGrossLeverage,
    feeRate: 0.00045,
    slippage: 0.0003,
    latencyPenalty: 0.0005,
    minOrderUsd: 12,
    band: 0.15,
    killSwitch: profile.weeklyLossLimit,
    entryPolicy,
  };
}

export async function runReplay(
  address: string,
  days: number,
  profile: RiskProfile,
  startEquity: number,
  entryPolicy: 'mirror' | 'new-only',
  dir: string,
  log: (m: string) => void,
  copyMultiplier = profile.copyMultiplier,
  cachedInputs?: ReplayInputs,
  prevInputs?: ReplayInputs,
): Promise<{ result: ReplayResult; view: ReplayView; inputs: ReplayInputs }> {
  const inputs = cachedInputs ?? (await fetchReplayInputs(address, days, Date.now(), log, prevInputs));
  const options = replayOptions(profile, startEquity, entryPolicy, copyMultiplier);
  const result = replayCopy(inputs, options);
  mkdirSync(dir, { recursive: true });
  const inputsJson = JSON.stringify(inputs);
  writeFileSync(join(dir, `replay-${address}-${days}d-inputs.json`), inputsJson);
  writeFileSync(join(dir, `replay-${address}-${days}d-${entryPolicy}-x${copyMultiplier}.json`), JSON.stringify({ address, days, entryPolicy, options, ...result }));
  const s = result.stats;
  const view: ReplayView = {
    leader: address,
    label: `${address.slice(0, 6)}…${address.slice(-4)}`,
    days,
    entryPolicy,
    from: inputs.from,
    to: inputs.to,
    startEquity: s.startEquity,
    endEquity: s.endEquity,
    totalReturn: s.totalReturn,
    maxDrawdown: s.maxDrawdown,
    fees: s.fees,
    funding: s.funding,
    trades: s.trades,
    killSwitchHits: s.killSwitchHits,
    leaderReturn: s.leaderReturn,
    equity: result.equity,
    recentTrades: result.trades.slice(-150).reverse().map((t) => ({ t: t.t, coin: t.coin, side: t.side, qty: t.qty, px: t.px, fee: t.fee, realizedPnl: t.realizedPnl, reason: t.reason })),
    inputsSha256: createHash('sha256').update(inputsJson).digest('hex'),
    assumptions: [
      `Posisi trader direkonstruksi dari ${inputs.fills.length} fill aslinya (startPosition + ukuran).`,
      inputs.equitySource === 'pnl+flows'
        ? `Nilai akun trader (akun unified) = modal trading sekarang − PnL perp sesudahnya − arus dana bersih sesudahnya (${inputs.flows?.length ?? 0} deposit/penarikan/kiriman dari ledger Hyperliquid).`
        : 'Nilai akun trader dari kurva portfolio Hyperliquid (sudah termasuk deposit & penarikan).',
      `Salinan = eksposur trader / nilai akunnya × ekuitas kita × ${options.copyMultiplier}, maks ${options.maxPositionLeverage}× per koin & ${options.maxGrossLeverage}× total.`,
      `Eksekusi di harga fill trader + slippage ${(options.slippage * 1e4).toFixed(0)} bps + keterlambatan ${(options.latencyPenalty * 1e4).toFixed(0)} bps; fee taker ${(options.feeRate * 1e4).toFixed(1)} bps.`,
      `Funding per jam dari riwayat funding Hyperliquid; mark-to-market tiap jam dari candle 1 jam.`,
      `Order < $${options.minOrderUsd} dilewati (batas minimum bursa); kill switch −${Math.round(options.killSwitch * 100)}% per 7 hari.`,
      entryPolicy === 'mirror' ? 'Posisi trader yang sudah terbuka di awal periode ikut disalin.' : 'Hanya posisi yang dibuka trader setelah periode dimulai yang disalin.',
    ],
  };
  return { result, view, inputs };
}

// Statistik per siklus 7 hari: berapa minggu profit, minggu terburuk, kena kill switch berapa kali.
export function weeklyBreakdown(equity: { t: number; equity: number }[], from: number) {
  const W = 7 * DAY;
  const out: { start: number; ret: number }[] = [];
  let base = equity[0]?.equity ?? 0;
  let start = from;
  for (const p of equity) {
    if (p.t >= start + W) {
      const prev = equity.filter((x) => x.t <= start + W).pop();
      if (prev && base > 0) out.push({ start, ret: prev.equity / base - 1 });
      base = prev?.equity ?? base;
      start += W;
    }
  }
  return out;
}

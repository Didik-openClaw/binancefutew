// Koin kanonik memakai penamaan Hyperliquid ("BTC", "kPEPE"). Prefix "k" = per 1000 unit,
// sama dengan kontrak "1000PEPEUSDT" di Binance, jadi harga dan ukuran konsisten.

const BINANCE_OVERRIDES: Record<string, string> = {};

export function toBinanceSymbol(coin: string): string {
  if (BINANCE_OVERRIDES[coin]) return BINANCE_OVERRIDES[coin];
  if (/^k[A-Z0-9]/.test(coin)) return `1000${coin.slice(1)}USDT`;
  return `${coin.toUpperCase()}USDT`;
}

export function fromBinanceSymbol(symbol: string): string | null {
  const hit = Object.entries(BINANCE_OVERRIDES).find(([, s]) => s === symbol);
  if (hit) return hit[0];
  if (!symbol.endsWith('USDT')) return null;
  const base = symbol.slice(0, -4);
  if (/^1000[A-Z]/.test(base)) return `k${base.slice(4)}`;
  return base;
}

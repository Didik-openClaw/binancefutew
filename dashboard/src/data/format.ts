const TZ = 'Asia/Jakarta';

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const MINUS = '−';

export function usd(n: number, digits: 0 | 2 = 2) {
  const s = (digits === 0 ? usd0 : usdFmt).format(Math.abs(n));
  return n < 0 ? `${MINUS}${s}` : s;
}

export function usdSigned(n: number, digits: 0 | 2 = 2) {
  return `${n >= 0 ? '+' : MINUS}${(digits === 0 ? usd0 : usdFmt).format(Math.abs(n))}`;
}

export function usdCompact(n: number) {
  return `${n < 0 ? MINUS : ''}$${compact.format(Math.abs(n))}`;
}

export function pct(x: number, digits = 1, signed = true) {
  const v = (Math.abs(x) * 100).toFixed(digits);
  if (!signed) return `${x < 0 ? MINUS : ''}${v}%`;
  return `${x > 0 ? '+' : x < 0 ? MINUS : ''}${v}%`;
}

export function num(x: number, digits = 2) {
  return `${x < 0 ? MINUS : ''}${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

export function price(x: number) {
  const d = x >= 1000 ? 1 : x >= 10 ? 2 : x >= 1 ? 4 : 5;
  return x.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}

export function qty(x: number) {
  const d = x >= 1000 ? 0 : x >= 10 ? 2 : x >= 1 ? 3 : 5;
  return x.toLocaleString('en-US', { maximumFractionDigits: d });
}

const dtFmt = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dFmt = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short' });
const tFmt = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const wdFmt = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, weekday: 'long' });

export const dateTime = (t: number) => dtFmt.format(t).replace('.', ':');
export const dateShort = (t: number) => dFmt.format(t);
export const timeOnly = (t: number) => tFmt.format(t).replace('.', ':');
export const weekday = (t: number) => wdFmt.format(t);

export function countdown(ms: number) {
  if (ms <= 0) return 'sekarang';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}h ${h}j`;
  if (h > 0) return `${h}j ${mm}m`;
  return `${mm}m`;
}

export function shortAddr(a: string) {
  return a.startsWith('0x') && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// ISO week label, mis. "W42".
export function isoWeek(t: number) {
  const d = new Date(t + 3 * 86_400_000);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `W${Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)}`;
}

export function tone(x: number) {
  return x > 0 ? 'up' : x < 0 ? 'down' : 'flat';
}

// Progres minggu berjalan (0..1); minggu dimulai Senin 00:00 UTC = 07:00 WIB.
export function weekProgressAt(now: number) {
  const WEEK = 7 * 86_400_000;
  const MONDAY = 4 * 86_400_000;
  const ws = Math.floor((now - MONDAY) / WEEK) * WEEK + MONDAY;
  return (now - ws) / WEEK;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

// Awal minggu = Senin 00:00 UTC. 1970-01-01 adalah Kamis, jadi geser 4 hari.
const MONDAY_OFFSET = 4 * DAY;

export function weekStart(t: number): number {
  return Math.floor((t - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET;
}

export function nextWeekStart(t: number): number {
  return weekStart(t) + WEEK;
}

export function intervalMs(interval: string): number {
  const m = /^(\d+)([mhdw])$/.exec(interval);
  if (!m) throw new Error(`Interval tidak dikenal: ${interval}`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: HOUR, d: DAY, w: WEEK }[m[2] as 'm' | 'h' | 'd' | 'w'];
  return n * unit;
}

export function isoWeekLabel(t: number): string {
  const d = new Date(weekStart(t) + 3 * DAY); // Kamis di minggu itu menentukan tahun ISO
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

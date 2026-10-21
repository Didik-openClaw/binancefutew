export function compound(rets: number[]): number {
  return rets.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

export function maxDrawdownFromReturns(rets: number[]): number {
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const r of rets) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
  }
  return dd;
}

export function maxDrawdown(equity: ArrayLike<number>, from = 0, to = equity.length - 1): number {
  let peak = equity[from];
  let dd = 0;
  for (let i = from; i <= to; i++) {
    peak = Math.max(peak, equity[i]);
    if (peak > 0) dd = Math.max(dd, 1 - equity[i] / peak);
  }
  return dd;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Sharpe tahunan dari return mingguan.
export function weeklySharpe(rets: number[]): number {
  const s = std(rets);
  return s > 0 ? (mean(rets) / s) * Math.sqrt(52) : 0;
}

export function winRate(rets: number[]): number {
  const active = rets.filter((r) => r !== 0);
  return active.length ? active.filter((r) => r > 0).length / active.length : 0;
}

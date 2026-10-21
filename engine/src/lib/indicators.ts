// Indikator vektor. Nilai di indeks t hanya memakai data <= t (tanpa lookahead).

export function ema(src: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(src.length);
  const k = 2 / (period + 1);
  let prev = src[0];
  for (let i = 0; i < src.length; i++) {
    prev = i === 0 ? src[0] : src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(src: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function rollingStd(src: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    sumSq += src[i] * src[i];
    if (i >= period) {
      sum -= src[i - period];
      sumSq -= src[i - period] * src[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
    }
  }
  return out;
}

// Max/min dari window [t-period, t-1] (tidak termasuk bar sekarang) — untuk breakout.
export function priorMax(src: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < src.length; i++) {
    while (dq.length && dq[0] < i - period) dq.shift();
    if (i >= period) out[i] = src[dq[0]];
    while (dq.length && src[dq[dq.length - 1]] <= src[i]) dq.pop();
    dq.push(i);
  }
  return out;
}

export function priorMin(src: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < src.length; i++) {
    while (dq.length && dq[0] < i - period) dq.shift();
    if (i >= period) out[i] = src[dq[0]];
    while (dq.length && src[dq[dq.length - 1]] >= src[i]) dq.pop();
    dq.push(i);
  }
  return out;
}

export function trueRange(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>): Float64Array {
  const out = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const prevClose = i === 0 ? c[0] : c[i - 1];
    out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - prevClose), Math.abs(l[i] - prevClose));
  }
  return out;
}

// ATR dengan smoothing Wilder.
export function atr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, period: number): Float64Array {
  const tr = trueRange(h, l, c);
  const out = new Float64Array(c.length).fill(NaN);
  let acc = 0;
  for (let i = 0; i < c.length; i++) {
    if (i < period) {
      acc += tr[i];
      if (i === period - 1) out[i] = acc / period;
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return out;
}

export function rsi(c: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    const gain = Math.max(ch, 0);
    const loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

// Volatilitas realisasi tahunan dari log-return `window` bar terakhir.
export function realizedVol(c: ArrayLike<number>, window: number, barsPerYear: number): Float64Array {
  const rets = new Float64Array(c.length);
  for (let i = 1; i < c.length; i++) rets[i] = Math.log(c[i] / c[i - 1]);
  const sd = rollingStd(rets, window);
  const out = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = Number.isNaN(sd[i]) ? NaN : sd[i] * Math.sqrt(barsPerYear);
  return out;
}

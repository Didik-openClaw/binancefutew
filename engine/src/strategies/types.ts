export type Params = Record<string, number>;

// Data OHLCV per koin dalam bentuk array paralel. Semua koin dalam satu dataset punya timestamp yang sama.
export interface Series {
  t: number[];
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

export interface Dataset {
  interval: string;
  barsPerYear: number;
  t: number[];
  coins: string[];
  series: Record<string, Series>;
  synthetic: boolean;
}

interface BaseStrategy {
  id: string;
  name: string;
  family: 'trend' | 'breakout' | 'reversion' | 'momentum';
  description: string;
  grid: Params[];
  label(p: Params): string;
}

// Strategi satu aset: sinyal arah di [-1, 1] per bar, diputuskan pada close bar t.
export interface SingleStrategy extends BaseStrategy {
  kind: 'single';
  signal(s: Series, p: Params): Float64Array;
}

// Strategi portofolio: bobot arah per koin (gross <= 1) per bar.
export interface PortfolioStrategy extends BaseStrategy {
  kind: 'portfolio';
  minCoins: number;
  weights(d: Dataset, coins: string[], p: Params): Record<string, Float64Array>;
}

export type Strategy = SingleStrategy | PortfolioStrategy;

import type { RiskState } from '../../../shared/types';
import { nextWeekStart, weekStart } from '../lib/time';
import type { RiskProfile } from './profiles';

export interface RiskPersisted {
  weekStart: number;
  weekStartEquity: number;
  haltedUntil: number | null;
  peakEquity: number;
}

// Kill switch mingguan: rugi >= weeklyLossLimit dari ekuitas awal minggu -> tutup semua, berhenti sampai Senin.
export class RiskManager {
  constructor(
    public profile: RiskProfile,
    public s: RiskPersisted,
  ) {}

  static fresh(equity: number, now: number): RiskPersisted {
    return { weekStart: weekStart(now), weekStartEquity: equity, haltedUntil: null, peakEquity: equity };
  }

  // Dipanggil tiap tick. Mengembalikan 'halt' bila kill switch baru saja terpicu.
  // period = siklus yang berlaku (default minggu Senin–Senin UTC; bisa juga 7 hari sejak playbook dibuat).
  update(equity: number, now: number, period?: { start: number; end: number }): 'ok' | 'halt' | 'halted' {
    const ws = period?.start ?? weekStart(now);
    if (ws !== this.s.weekStart) {
      this.s.weekStart = ws;
      this.s.weekStartEquity = equity;
      if (this.s.haltedUntil !== null && now >= this.s.haltedUntil) this.s.haltedUntil = null;
    }
    this.s.peakEquity = Math.max(this.s.peakEquity, equity);
    if (this.s.haltedUntil !== null) {
      if (now < this.s.haltedUntil) return 'halted';
      this.s.haltedUntil = null;
    }
    if (this.lossFraction(equity) >= this.profile.weeklyLossLimit) {
      this.s.haltedUntil = period?.end ?? nextWeekStart(now);
      return 'halt';
    }
    return 'ok';
  }

  lossFraction(equity: number) {
    return this.s.weekStartEquity > 0 ? Math.max(0, 1 - equity / this.s.weekStartEquity) : 0;
  }

  view(equity: number): RiskState {
    return {
      profile: this.profile.id,
      maxGrossLeverage: this.profile.maxGrossLeverage,
      maxPositionLeverage: this.profile.maxPositionLeverage,
      weeklyLossLimit: this.profile.weeklyLossLimit,
      copyMultiplier: this.profile.copyMultiplier,
      weekStartEquity: this.s.weekStartEquity,
      weekLossUsed: this.lossFraction(equity) / this.profile.weeklyLossLimit,
      killSwitch: this.s.haltedUntil ? 'triggered' : 'armed',
      haltedUntil: this.s.haltedUntil,
    };
  }
}

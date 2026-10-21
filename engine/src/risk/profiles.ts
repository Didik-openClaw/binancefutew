import type { RiskProfileId } from '../../../shared/types';

export interface RiskProfile {
  id: RiskProfileId;
  label: string;
  // Sizing strategi: volatilitas tahunan yang ditargetkan per posisi dan batas leverage per koin.
  targetVol: number;
  maxPositionLeverage: number;
  // Batas total eksposur (gross notional / ekuitas).
  maxGrossLeverage: number;
  // Pengali ukuran posisi leader. 1.5 = 1.5x lebih besar dari proporsi leader.
  copyMultiplier: number;
  // Kill switch: rugi mingguan dari ekuitas awal minggu. Tercapai -> semua posisi ditutup, berhenti sampai Senin.
  weeklyLossLimit: number;
  // Penalti risiko pada skor turnamen (lebih kecil = lebih berani).
  downsidePenalty: number;
  drawdownCap: number;
  // Jumlah strategi dan leader yang dipakai sekaligus (lebih sedikit = lebih terkonsentrasi).
  strategySlots: number;
  leaderSlots: number;
  // Suhu softmax untuk bobot alokasi; kecil = bobot menumpuk ke juara.
  concentration: number;
}

export const RISK_PROFILES: Record<RiskProfileId, RiskProfile> = {
  balanced: {
    id: 'balanced',
    label: 'Seimbang',
    targetVol: 0.45,
    maxPositionLeverage: 2,
    maxGrossLeverage: 3,
    copyMultiplier: 1,
    weeklyLossLimit: 0.12,
    downsidePenalty: 1,
    drawdownCap: 0.15,
    strategySlots: 3,
    leaderSlots: 4,
    concentration: 1,
  },
  bold: {
    id: 'bold',
    label: 'Berani',
    targetVol: 0.9,
    maxPositionLeverage: 4,
    maxGrossLeverage: 6,
    copyMultiplier: 1.5,
    weeklyLossLimit: 0.25,
    downsidePenalty: 0.35,
    drawdownCap: 0.3,
    strategySlots: 2,
    leaderSlots: 3,
    concentration: 0.5,
  },
  extreme: {
    id: 'extreme',
    label: 'Ekstrem',
    targetVol: 1.5,
    maxPositionLeverage: 8,
    maxGrossLeverage: 10,
    copyMultiplier: 2.5,
    weeklyLossLimit: 0.4,
    downsidePenalty: 0.15,
    drawdownCap: 0.5,
    strategySlots: 1,
    leaderSlots: 2,
    concentration: 0.25,
  },
};

// Profil dengan pengali salin yang di-override dari .env (COPY_MULTIPLIER).
export function resolveProfile(id: RiskProfileId, copyMultiplier?: number): RiskProfile {
  const base = RISK_PROFILES[id];
  return copyMultiplier && copyMultiplier > 0 ? { ...base, copyMultiplier } : base;
}

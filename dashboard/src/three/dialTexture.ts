import { CanvasTexture, SRGBColorSpace } from 'three';

// Dial kronograf mingguan digambar di canvas: guilloché, trek 168 jam, label hari,
// dan tiga subdial (PnL minggu vs kill switch, leverage, detik).

export const DIAL_DAYS = ['SEN', 'SEL', 'RAB', 'KAM', 'JUM', 'SAB', 'MIN'];
export const SUB = { pnl: { x: -0.43, y: 0.02 }, lev: { x: 0.43, y: 0.02 }, sec: { x: 0, y: -0.47 }, r: 0.19 };
export const SWEEP = (120 * Math.PI) / 180;

interface DialOptions {
  lossLimit: number; // mis. 0.25
  maxLeverage: number; // mis. 6
  mono: string;
  display: string;
}

export function makeDialTexture(o: DialOptions): CanvasTexture {
  const S = 2048;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const R = S / 2;
  g.translate(R, R);

  // Dasar: graphite dengan cahaya lembut di tengah.
  const base = g.createRadialGradient(0, -R * 0.25, R * 0.1, 0, 0, R);
  base.addColorStop(0, '#2a2c30');
  base.addColorStop(0.6, '#17191c');
  base.addColorStop(1, '#0d0e10');
  g.fillStyle = base;
  g.beginPath();
  g.arc(0, 0, R, 0, Math.PI * 2);
  g.fill();

  // Guilloché: gelombang konsentris yang bergeser fase, menghasilkan moiré halus.
  g.lineWidth = 1.4;
  for (let i = 0; i < 120; i++) {
    const r0 = R * (0.12 + (i / 120) * 0.74);
    g.strokeStyle = `rgba(236, 226, 205, ${0.05 + 0.04 * Math.sin(i * 0.7) ** 2})`;
    g.beginPath();
    for (let k = 0; k <= 720; k++) {
      const th = (k / 720) * Math.PI * 2;
      const rr = r0 + R * 0.012 * Math.sin(18 * th + i * 0.21);
      const x = rr * Math.cos(th);
      const y = rr * Math.sin(th);
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  // Cincin trek luar (lebih gelap) untuk menegaskan skala.
  g.fillStyle = 'rgba(8, 9, 10, 0.55)';
  g.beginPath();
  g.arc(0, 0, R * 0.995, 0, Math.PI * 2);
  g.arc(0, 0, R * 0.885, 0, Math.PI * 2, true);
  g.fill();

  // 168 tick jam. Sudut 0 = jam 12, searah jarum jam.
  const at = (frac: number, r: number) => {
    const th = frac * Math.PI * 2 - Math.PI / 2;
    return [r * Math.cos(th), r * Math.sin(th)] as const;
  };
  for (let h = 0; h < 168; h++) {
    const day = h % 24 === 0;
    const six = h % 6 === 0;
    const r1 = R * 0.975;
    const r0 = R * (day ? 0.9 : six ? 0.925 : 0.948);
    g.strokeStyle = day ? 'rgba(232, 214, 170, 0.95)' : six ? 'rgba(220, 210, 190, 0.6)' : 'rgba(220, 210, 190, 0.28)';
    g.lineWidth = day ? 6 : six ? 3.2 : 2;
    const [x0, y0] = at(h / 168, r0);
    const [x1, y1] = at(h / 168, r1);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }

  // Label hari di tengah sektornya.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 64px ${o.mono}`;
  DIAL_DAYS.forEach((d, i) => {
    const [x, y] = at((i + 0.5) / 7, R * 0.79);
    g.fillStyle = i >= 5 ? 'rgba(200, 190, 170, 0.55)' : 'rgba(236, 228, 212, 0.86)';
    spaced(g, d, x, y, 10);
  });

  // Merek & keterangan.
  g.fillStyle = 'rgba(232, 214, 170, 0.95)';
  g.font = `500 108px ${o.display}`;
  spaced(g, 'KAIROS', 0, -R * 0.4, 18);
  g.fillStyle = 'rgba(220, 210, 190, 0.6)';
  g.font = `500 34px ${o.mono}`;
  spaced(g, 'SIKLUS MINGGUAN · UTC', 0, -R * 0.29, 8);

  // Subdial.
  const sub = (cx: number, cy: number) => {
    const x = cx * R;
    const y = -cy * R;
    const r = SUB.r * R;
    const grad = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, '#1d1f22');
    grad.addColorStop(1, '#0b0c0e');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    // Azurage: alur konsentris halus.
    for (let k = 1; k < 26; k++) {
      g.strokeStyle = `rgba(230, 220, 200, ${k % 2 ? 0.045 : 0.02})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, (r * k) / 26, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = 'rgba(205, 174, 110, 0.55)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    return { x, y, r };
  };
  // Sudut subdial: -SWEEP..+SWEEP dari arah jam 12.
  const subTick = (s: { x: number; y: number; r: number }, a: number, len: number, color: string, w: number) => {
    const th = a - Math.PI / 2;
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(s.x + Math.cos(th) * s.r * (0.9 - len), s.y + Math.sin(th) * s.r * (0.9 - len));
    g.lineTo(s.x + Math.cos(th) * s.r * 0.9, s.y + Math.sin(th) * s.r * 0.9);
    g.stroke();
  };
  const subArc = (s: { x: number; y: number; r: number }, a0: number, a1: number, color: string) => {
    g.strokeStyle = color;
    g.lineWidth = 10;
    g.beginPath();
    g.arc(s.x, s.y, s.r * 0.86, a0 - Math.PI / 2, a1 - Math.PI / 2);
    g.stroke();
  };
  const subLabel = (s: { x: number; y: number; r: number }, a: number, text: string) => {
    const th = a - Math.PI / 2;
    g.fillStyle = 'rgba(220, 210, 190, 0.75)';
    g.font = `500 28px ${o.mono}`;
    g.fillText(text, s.x + Math.cos(th) * s.r * 0.62, s.y + Math.sin(th) * s.r * 0.62);
  };
  const title = (s: { x: number; y: number; r: number }, text: string) => {
    g.fillStyle = 'rgba(232, 214, 170, 0.85)';
    g.font = `600 26px ${o.mono}`;
    spaced(g, text, s.x, s.y + s.r * 0.66, 4);
  };

  // PnL minggu: kiri = rugi sampai batas kill switch, kanan = profit setara.
  const p = sub(SUB.pnl.x, SUB.pnl.y);
  subArc(p, -SWEEP, -SWEEP * 0.8, 'rgba(209, 93, 81, 0.9)');
  for (let k = -10; k <= 10; k++) subTick(p, (k / 10) * SWEEP, k % 5 === 0 ? 0.16 : 0.08, 'rgba(225, 215, 195, 0.6)', k % 5 === 0 ? 4 : 2);
  const lim = Math.round(o.lossLimit * 100);
  subLabel(p, -SWEEP, `−${lim}`);
  subLabel(p, 0, '0');
  subLabel(p, SWEEP, `+${lim}`);
  title(p, 'PNL MINGGU');

  const l = sub(SUB.lev.x, SUB.lev.y);
  subArc(l, SWEEP * 0.7, SWEEP, 'rgba(200, 127, 44, 0.9)');
  const steps = Math.max(2, Math.round(o.maxLeverage));
  for (let k = 0; k <= steps * 2; k++) subTick(l, -SWEEP + (k / (steps * 2)) * 2 * SWEEP, k % 2 === 0 ? 0.16 : 0.08, 'rgba(225, 215, 195, 0.6)', k % 2 === 0 ? 4 : 2);
  subLabel(l, -SWEEP, '0');
  subLabel(l, 0, `${(o.maxLeverage / 2).toFixed(0)}`);
  subLabel(l, SWEEP, `${o.maxLeverage}×`);
  title(l, 'LEVERAGE');

  const s = sub(SUB.sec.x, SUB.sec.y);
  for (let k = 0; k < 60; k++) subTick(s, (k / 60) * Math.PI * 2, k % 5 === 0 ? 0.16 : 0.07, 'rgba(225, 215, 195, 0.55)', k % 5 === 0 ? 3.5 : 1.6);
  [15, 30, 45, 60].forEach((v) => subLabel(s, (v / 60) * Math.PI * 2, String(v)));

  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number) {
  const widths = [...text].map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
  let cx = x - total / 2;
  const align = g.textAlign;
  g.textAlign = 'left';
  [...text].forEach((ch, i) => {
    g.fillText(ch, cx, y);
    cx += widths[i] + tracking;
  });
  g.textAlign = align;
}

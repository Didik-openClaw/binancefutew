import { useCallback, useRef, useState } from 'react';
import { isoWeek, pct, tone } from '../data/format';

export function Sparkline({ values, width = 96, height = 26, color = 'var(--series-1)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (height - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'block' }}>
      <line x1={2} x2={width - 4} y1={y(0)} y2={y(0)} stroke="var(--rule)" strokeWidth={1} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill={color} />
    </svg>
  );
}

// Batang return mingguan: dua kutub (profit/rugi) dari garis nol, ujung data membulat 4px.
// Lebar elemen via callback ref, jadi tetap terukur bila elemen diganti (mis. dari kosong ke berisi).
export function useWidth(initial = 600) {
  const [w, setW] = useState(initial);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.current.observe(el);
  }, []);
  return [ref, w] as const;
}

export function WeeklyBars({ weeks, height = 150 }: { weeks: { weekStart: number; ret: number }[]; height?: number }) {
  const [hot, setHot] = useState<number | null>(null);
  const [ref, W] = useWidth();
  if (!weeks.length) return <p className="empty">Belum ada minggu yang selesai.</p>;
  const maxAbs = Math.max(0.01, ...weeks.map((w) => Math.abs(w.ret)));
  const slot = W / weeks.length;
  const bw = Math.min(slot * 0.62, 24);
  const mid = height / 2;
  const scale = (height / 2 - 18) / maxAbs;
  return (
    <div className="chart" style={{ height: height + 18 }} ref={ref}>
      <svg viewBox={`0 0 ${W} ${height}`} height={height} role="img" aria-label="Return per minggu">
        <line x1={0} x2={W} y1={mid} y2={mid} stroke="var(--rule)" strokeWidth={1} />
        {weeks.map((w, i) => {
          const h = Math.max(1, Math.abs(w.ret) * scale);
          const cx = i * slot + slot / 2;
          const up = w.ret >= 0;
          const yTop = up ? mid - h : mid;
          return (
            <g key={w.weekStart} onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot(null)}>
              <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
              <path d={roundedBar(cx - bw / 2, yTop, bw, h, up)} fill={up ? 'var(--up)' : 'var(--down)'} opacity={hot === null || hot === i ? 1 : 0.45} />
            </g>
          );
        })}
      </svg>
      <div style={{ position: 'absolute', inset: `${height + 2}px 0 0 0`, display: 'flex' }} aria-hidden="true">
        {weeks.map((w) => (
          <span key={w.weekStart} className="label" style={{ flex: 1, textAlign: 'center', fontSize: 9.5, letterSpacing: '0.04em' }}>
            {isoWeek(w.weekStart)}
          </span>
        ))}
      </div>
      {hot !== null && (
        <div className="tooltip" style={{ left: `clamp(0px, calc(${((hot + 0.5) / weeks.length) * 100}% - 75px), calc(100% - 160px))`, top: 0 }}>
          <div className="t">{isoWeek(weeks[hot].weekStart)}</div>
          <div className="row">
            <i className="key" style={{ background: weeks[hot].ret >= 0 ? 'var(--up)' : 'var(--down)' }} />
            <b className={tone(weeks[hot].ret)}>{pct(weeks[hot].ret)}</b>
            <span>return minggu</span>
          </div>
        </div>
      )}
    </div>
  );
}

function roundedBar(x: number, y: number, w: number, h: number, up: boolean) {
  const r = Math.min(4, w / 2, h);
  // Sudut membulat hanya di ujung data, persegi di baseline.
  if (up) return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

export function Meter({ label, value, display, ratio, zones }: { label: string; value: string; display?: string; ratio: number; zones: { warn: number; bad: number } }) {
  const r = Math.max(0, Math.min(1, ratio));
  const color = r >= zones.bad ? 'var(--down)' : r >= zones.warn ? 'var(--warn)' : 'var(--series-1)';
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="num">{value}</span>
      </div>
      <div className="meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r * 100)} aria-label={label}>
        <i style={{ width: `${r * 100}%`, background: color }} />
      </div>
      {display && <span className="meter-note">{display}</span>}
    </div>
  );
}

export function CoinBadge({ coin }: { coin: string }) {
  return <span className="coin-badge">{coin.replace(/^k/, '').slice(0, 4)}</span>;
}

export function Confirm({ title, body, confirm, danger, onConfirm, onCancel }: { title: string; body: string; confirm: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="row">
          <button className="btn" onClick={onCancel} autoFocus>
            Batal
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

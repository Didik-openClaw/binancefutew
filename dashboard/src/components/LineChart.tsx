import { useMemo, useState } from 'react';
import { useWidth } from './bits';

export interface Series {
  id: string;
  name: string;
  color: string;
  points: { t: number; v: number }[];
  area?: boolean;
}

interface Props {
  series: Series[];
  height?: number;
  formatY: (v: number) => string;
  formatX: (t: number) => string;
  formatTip?: (t: number) => string;
  markers?: { t: number; label: string }[];
  baseline?: number; // garis referensi (mis. 0% atau modal awal)
  ariaLabel: string;
}

// Grafik garis SVG: garis 2px, area 10%, grid rambut, crosshair yang menempel ke titik data terdekat.
export function LineChart({ series, height = 260, formatY, formatX, formatTip, markers = [], baseline, ariaLabel }: Props) {
  const [box, w] = useWidth(640);
  const [hover, setHover] = useState<number | null>(null);

  const pad = { l: 8, r: 64, t: 12, b: 26 };
  const plotW = w - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const { xs, x, y, ticks, xTicks } = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const t0 = Math.min(...all.map((p) => p.t));
    const t1 = Math.max(...all.map((p) => p.t));
    let lo = Math.min(...all.map((p) => p.v), baseline ?? Infinity);
    let hi = Math.max(...all.map((p) => p.v), baseline ?? -Infinity);
    const span = hi - lo || Math.abs(hi) * 0.1 || 1;
    lo -= span * 0.08;
    hi += span * 0.08;
    const ticks = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0]);
    hi = Math.max(hi, ticks[ticks.length - 1]);
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * plotH;
    const xs = [...new Set(series[0]?.points.map((p) => p.t) ?? [])];
    const n = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
    const xTicks = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
    return { xs, x, y, ticks, xTicks };
  }, [series, plotW, plotH, baseline]);

  const path = (pts: { t: number; v: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + pad.l;
    let best = 0;
    let bestD = Infinity;
    xs.forEach((t, i) => {
      const d = Math.abs(x(t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const ht = hover !== null ? xs[hover] : null;
  const rows = ht === null ? [] : series.map((s) => ({ s, p: nearest(s.points, ht) })).filter((r) => r.p);

  return (
    <div className="chart" ref={box}>
      <svg viewBox={`0 0 ${w} ${height}`} height={height} role="img" aria-label={ariaLabel}>
        <g className="axis">
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid-line" x1={pad.l} x2={pad.l + plotW} y1={y(v)} y2={y(v)} />
              <text x={pad.l + plotW + 10} y={y(v) + 3.5}>
                {formatY(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
              {formatX(t)}
            </text>
          ))}
        </g>
        {baseline !== undefined && <line className="zero-line" x1={pad.l} x2={pad.l + plotW} y1={y(baseline)} y2={y(baseline)} />}
        {markers.map((m) => (
          <g key={m.t}>
            <line x1={x(m.t)} x2={x(m.t)} y1={pad.t} y2={pad.t + plotH} stroke="var(--rule)" strokeWidth={1} />
            <text x={x(m.t) + 4} y={pad.t + 9} fill="var(--muted)" fontSize={9.5} fontFamily="var(--f-mono)">
              {m.label}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.id}>
            {s.area && s.points.length > 1 && (
              <path
                d={`${path(s.points)}L${x(s.points[s.points.length - 1].t)},${pad.t + plotH}L${x(s.points[0].t)},${pad.t + plotH}Z`}
                fill={s.color}
                opacity={0.1}
              />
            )}
            <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.points.length > 0 && (
              <circle cx={x(s.points[s.points.length - 1].t)} cy={y(s.points[s.points.length - 1].v)} r={4} fill={s.color} stroke="var(--plate)" strokeWidth={2} />
            )}
          </g>
        ))}
        {ht !== null && (
          <g pointerEvents="none">
            <line x1={x(ht)} x2={x(ht)} y1={pad.t} y2={pad.t + plotH} stroke="var(--ivory-2)" strokeWidth={1} opacity={0.5} />
            {rows.map(({ s, p }) => (
              <circle key={s.id} cx={x(p!.t)} cy={y(p!.v)} r={4.5} fill={s.color} stroke="var(--plate)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {ht !== null && (
        <div className="tooltip" style={{ left: Math.min(x(ht) + 14, w - 190), top: 8 }}>
          <div className="t">{(formatTip ?? formatX)(ht)}</div>
          {rows.map(({ s, p }) => (
            <div className="row" key={s.id}>
              <i className="key" style={{ background: s.color }} />
              <b>{formatY(p!.v)}</b>
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function nearest(points: { t: number; v: number }[], t: number) {
  let best = points[0];
  for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best;
}

export function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

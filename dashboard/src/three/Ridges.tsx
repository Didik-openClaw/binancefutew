import { Environment, Html, Line, Lightformer, OrbitControls } from '@react-three/drei';
import { Canvas, type ThreeEvent, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { usePrefersReducedMotion } from './motion';

// Lanskap turnamen: tiap punggung = kurva return kumulatif satu kandidat selama jendela seleksi.
// Sumbu X = minggu (lama -> baru), Z = peringkat skor, Y = return kumulatif. Juara berwarna kuningan.

export interface Ridge {
  id: string;
  label: string;
  cumulative: number[]; // mulai 0
  picked: boolean;
}

interface Props {
  ridges: Ridge[];
  hovered: string | null;
  onHover: (id: string | null) => void;
  weekLabels: string[];
}

const WIDTH = 6.6;
const SPACING = 0.5;
const SAMPLES = 10;

function catmull(points: [number, number][], samples: number): [number, number][] {
  if (points.length < 2) return points;
  const out: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function RidgeMesh({ ridge, z, scale, floor, index, hovered, onHover, reduced }: { ridge: Ridge; z: number; scale: number; floor: number; index: number; hovered: string | null; onHover: Props['onHover']; reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const born = useRef<number | null>(null);
  const n = ridge.cumulative.length;
  const curve = useMemo(() => {
    const pts = ridge.cumulative.map((v, i) => [(i / Math.max(1, n - 1) - 0.5) * WIDTH, v * scale] as [number, number]);
    return catmull(pts, SAMPLES);
  }, [ridge.cumulative, n, scale]);

  const geo = useMemo(() => {
    const pos: number[] = [];
    const idx: number[] = [];
    curve.forEach(([x, y], i) => {
      pos.push(x, y, 0, x, floor, 0);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [curve, floor]);

  const isHot = hovered === ridge.id;
  const dim = hovered !== null && !isHot;
  const color = ridge.picked ? '#d4b06a' : '#9aa3b2';
  const fillOpacity = ridge.picked ? 0.42 : 0.16;

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    if (born.current === null) born.current = state.clock.elapsedTime;
    const t = reduced ? 1 : Math.min(1, Math.max(0, (state.clock.elapsedTime - born.current - index * 0.07) / 1.1));
    g.scale.y = 1 - (1 - t) ** 3;
  });

  const end = curve[curve.length - 1];
  return (
    <group ref={group} position-z={z}>
      <mesh
        geometry={geo}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(ridge.id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <meshStandardMaterial
          color={color}
          transparent
          opacity={dim ? fillOpacity * 0.35 : isHot ? fillOpacity + 0.18 : fillOpacity}
          side={THREE.DoubleSide}
          metalness={ridge.picked ? 0.8 : 0.2}
          roughness={0.35}
          depthWrite={false}
        />
      </mesh>
      <Line
        points={curve.map(([x, y]) => [x, y, 0] as [number, number, number])}
        color={ridge.picked ? '#f0d39a' : '#d9dde5'}
        lineWidth={isHot || ridge.picked ? 2.4 : 1.4}
        transparent
        opacity={dim ? 0.25 : ridge.picked ? 1 : 0.62}
      />
      <mesh position={[end[0], end[1], 0]}>
        <sphereGeometry args={[ridge.picked ? 0.055 : 0.035, 20, 20]} />
        <meshStandardMaterial color={ridge.picked ? '#f0d39a' : '#d9dde5'} metalness={0.9} roughness={0.2} />
      </mesh>
      {isHot && (
        <Html position={[end[0], end[1], 0]} style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
          <div className="ridge-tip">
            <strong>{fmtPct(ridge.cumulative[n - 1])}</strong>
            <span>{ridge.label}</span>
          </div>
        </Html>
      )}
    </group>
  );
}

function fmtPct(x: number) {
  return `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
}

function Scene({ ridges, hovered, onHover, weekLabels }: Props) {
  const reduced = usePrefersReducedMotion();
  const all = ridges.flatMap((r) => r.cumulative);
  const maxAbs = Math.max(0.05, ...all.map(Math.abs));
  const scale = 2.1 / maxAbs;
  const floor = Math.min(0, ...all) * scale - 0.25;
  const depth = (ridges.length - 1) * SPACING;
  const ctrl = useRef<React.ComponentRef<typeof OrbitControls>>(null);

  useFrame((state) => {
    if (reduced || !ctrl.current) return;
    // Ayunan kamera pelan agar volume lanskap terbaca tanpa harus diseret.
    const t = state.clock.elapsedTime;
    ctrl.current.setAzimuthalAngle(0.55 + Math.sin(t * 0.12) * 0.18);
    ctrl.current.update();
  });

  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[4, 6, 5]} intensity={1.1} />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={1.6} color="#fff0d2" scale={[10, 4, 1]} position={[0, 6, 4]} rotation-x={Math.PI / 2.3} />
        <Lightformer form="rect" intensity={0.8} color="#cfdcff" scale={[3, 8, 1]} position={[-7, 2, 0]} rotation-y={Math.PI / 2} />
      </Environment>
      <group position={[0, -0.2, depth / 2]}>
        {/* Bidang break-even (return 0%) */}
        <mesh rotation-x={-Math.PI / 2} position={[0, 0, -depth / 2]}>
          <planeGeometry args={[WIDTH + 0.6, depth + 0.8]} />
          <meshBasicMaterial color="#cdae6e" transparent opacity={0.035} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        <Line
          points={[
            [-WIDTH / 2 - 0.3, 0, 0.4],
            [WIDTH / 2 + 0.3, 0, 0.4],
          ]}
          color="#cdae6e"
          lineWidth={1}
          transparent
          opacity={0.5}
        />
        {/* Garis minggu di lantai */}
        {weekLabels.map((_, i) => {
          const x = (i / Math.max(1, weekLabels.length - 1) - 0.5) * WIDTH;
          return (
            <Line
              key={i}
              points={[
                [x, floor, 0.4],
                [x, floor, -depth - 0.4],
              ]}
              color="#3a3d43"
              lineWidth={1}
              transparent
              opacity={0.7}
            />
          );
        })}
        {[...new Set([0, Math.floor((weekLabels.length - 1) / 2), weekLabels.length - 1])].map((i) => (
          <Html key={i} position={[(i / Math.max(1, weekLabels.length - 1) - 0.5) * WIDTH, floor, 0.75]} center style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
            <span className="ridge-axis">{weekLabels[i]}</span>
          </Html>
        ))}
        {ridges.map((r, i) => (
          <RidgeMesh key={r.id} ridge={r} z={-i * SPACING} scale={scale} floor={floor} index={i} hovered={hovered} onHover={onHover} reduced={reduced} />
        ))}
      </group>
      <OrbitControls ref={ctrl} enableZoom={false} enablePan={false} minPolarAngle={0.8} maxPolarAngle={1.4} target={[0.2, 0.45, -0.2]} />
    </>
  );
}

export default function Ridges(props: Props) {
  const reduced = usePrefersReducedMotion();
  return (
    <Canvas dpr={[1, 2]} camera={{ position: [4.4, 2.7, 7.4], fov: 38 }} gl={{ antialias: true, alpha: true }} frameloop={reduced ? 'demand' : 'always'} aria-label="Lanskap 3D turnamen strategi">
      <Scene {...props} />
    </Canvas>
  );
}

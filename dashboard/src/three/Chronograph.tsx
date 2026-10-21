import { Environment, Lightformer } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FONTS, fontsReady } from '../fonts';
import { usePrefersReducedMotion } from './motion';
import { DIAL_DAYS, makeDialTexture, SUB, SWEEP } from './dialTexture';

// Kronograf mingguan: jarum utama = progres minggu (rebalance tiap Senin 00:00 UTC),
// subdial kiri = PnL minggu terhadap batas kill switch, kanan = leverage, bawah = detik.

export interface ChronoProps {
  weekProgress: number; // 0..1
  pnlRatio: number; // PnL minggu / batas rugi, -1 = kill switch
  levRatio: number; // leverage / batas gross
  lossLimit: number;
  maxLeverage: number;
}

const DIAL_R = 2;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

function brass(roughness: number, color = '#c9a463') {
  return new THREE.MeshStandardMaterial({ color, metalness: 1, roughness, envMapIntensity: 1.25 });
}

function dauphine(length: number, width: number, tail: number) {
  const left = new THREE.Shape();
  left.moveTo(0, -tail);
  left.lineTo(-width, 0);
  left.lineTo(0, length);
  left.closePath();
  const right = new THREE.Shape();
  right.moveTo(0, -tail);
  right.lineTo(0, length);
  right.lineTo(width, 0);
  right.closePath();
  const opts = { depth: 0.018, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 };
  return [new THREE.ExtrudeGeometry(left, opts), new THREE.ExtrudeGeometry(right, opts)];
}

function Hand({ length, width, tail, z, angle, light, dark }: { length: number; width: number; tail: number; z: number; angle: React.MutableRefObject<number>; light: THREE.Material; dark: THREE.Material }) {
  const ref = useRef<THREE.Group>(null);
  const [l, r] = useMemo(() => dauphine(length, width, tail), [length, width, tail]);
  useFrame(() => {
    if (ref.current) ref.current.rotation.z = -angle.current;
  });
  return (
    <group ref={ref} position-z={z}>
      <mesh geometry={l} material={light} />
      <mesh geometry={r} material={dark} />
    </group>
  );
}

function Watch({ weekProgress, pnlRatio, levRatio, lossLimit, maxLeverage, reduced }: ChronoProps & { reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const [tex, setTex] = useState<THREE.CanvasTexture | null>(null);

  useEffect(() => {
    let alive = true;
    fontsReady().then(() => {
      if (!alive) return;
      setTex(makeDialTexture({ lossLimit, maxLeverage, mono: FONTS.mono, display: FONTS.display }));
    });
    return () => {
      alive = false;
    };
  }, [lossLimit, maxLeverage]);

  const mats = useMemo(
    () => ({
      caseMat: brass(0.34, '#b8955a'),
      bezel: brass(0.16, '#d4b274'),
      handLight: new THREE.MeshStandardMaterial({ color: '#f4dfb4', metalness: 0.85, roughness: 0.2, envMapIntensity: 1.4 }),
      handDark: new THREE.MeshStandardMaterial({ color: '#d8b77a', metalness: 0.75, roughness: 0.32, envMapIntensity: 1.4 }),
      index: brass(0.1, '#e2c58c'),
      needle: new THREE.MeshStandardMaterial({ color: '#efe7d8', metalness: 0.6, roughness: 0.25 }),
      second: new THREE.MeshStandardMaterial({ color: '#d1695c', metalness: 0.5, roughness: 0.3 }),
      arc: new THREE.MeshBasicMaterial({ color: '#d8b878', transparent: true, opacity: 0.9, toneMapped: false }),
      crystal: new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 0, roughness: 0.04, transparent: true, opacity: 0.1, clearcoat: 1, envMapIntensity: 2.2, depthWrite: false }),
    }),
    [],
  );

  const caseGeo = useMemo(() => {
    const pts = [
      [2.0, 0.0],
      [2.03, 0.15],
      [2.09, 0.22],
      [2.3, 0.22],
      [2.39, 0.16],
      [2.45, 0.02],
      [2.45, -0.2],
      [2.36, -0.32],
      [2.0, -0.32],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const g = new THREE.LatheGeometry(pts, 160);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);

  const crystalGeo = useMemo(() => {
    const R = 7;
    const g = new THREE.SphereGeometry(R, 96, 8, 0, Math.PI * 2, 0, Math.asin(2.06 / R));
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, 0.3 - R);
    return g;
  }, []);

  // Sudut animasi (intro: jarum menyapu dari nol ke nilainya).
  const t0 = useRef<number | null>(null);
  const main = useRef(0);
  const pnl = useRef(0);
  const lev = useRef(-SWEEP);
  const sec = useRef(0);
  const target = { main: weekProgress * Math.PI * 2, pnl: Math.max(-1.1, Math.min(1.1, pnlRatio)) * SWEEP, lev: -SWEEP + Math.max(0, Math.min(1.05, levRatio)) * 2 * SWEEP };
  const arcRef = useRef<THREE.Mesh>(null);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useFrame((state, dt) => {
    const now = state.clock.elapsedTime;
    if (t0.current === null) t0.current = now;
    const k = reduced ? 1 : easeOut(Math.min(1, (now - t0.current) / 2.2));
    main.current = target.main * k;
    pnl.current = target.pnl * k;
    lev.current = -SWEEP + (target.lev + SWEEP) * k;
    // Detik menyapu halus seperti kaliber otomatis (8 ketukan/detik).
    const s = (Date.now() % 60_000) / 1000;
    sec.current = reduced ? 0 : (Math.floor(s * 8) / 8 / 60) * Math.PI * 2;
    if (arcRef.current) {
      const geo = arcRef.current.geometry as THREE.RingGeometry;
      const len = Math.max(0.0001, main.current);
      if (Math.abs((geo.parameters.thetaLength ?? 0) - len) > 0.002) {
        geo.dispose();
        arcRef.current.geometry = new THREE.RingGeometry(1.705, 1.725, 256, 1, Math.PI / 2 - len, len);
      }
    }
    if (group.current && !reduced) {
      const g = group.current;
      g.rotation.x = THREE.MathUtils.damp(g.rotation.x, -0.22 - pointer.current.y * 0.07, 3, dt);
      g.rotation.y = THREE.MathUtils.damp(g.rotation.y, -0.14 + pointer.current.x * 0.12, 3, dt);
      g.position.y = Math.sin(now * 0.6) * 0.03;
    }
  });

  const subPos = (p: { x: number; y: number }) => [p.x * DIAL_R, p.y * DIAL_R] as const;
  const [px, py] = subPos(SUB.pnl);
  const [lx, ly] = subPos(SUB.lev);
  const [sx, sy] = subPos(SUB.sec);
  const subLen = SUB.r * DIAL_R * 0.85;

  return (
    <group ref={group} rotation={[-0.22, -0.14, 0]}>
      <mesh geometry={caseGeo} material={mats.caseMat} />
      <mesh position-z={0.225} material={mats.bezel}>
        <torusGeometry args={[2.2, 0.012, 12, 200]} />
      </mesh>
      {/* Mahkota di posisi jam 3 */}
      <mesh position={[2.56, 0, -0.06]} rotation-z={Math.PI / 2} material={mats.caseMat}>
        <cylinderGeometry args={[0.14, 0.14, 0.2, 28, 1]} />
      </mesh>
      <mesh position={[2.68, 0, -0.06]} rotation-z={Math.PI / 2} material={mats.bezel}>
        <cylinderGeometry args={[0.1, 0.12, 0.05, 28, 1]} />
      </mesh>

      <mesh position-z={0}>
        <circleGeometry args={[DIAL_R + 0.02, 128]} />
        {tex ? (
          <meshPhysicalMaterial map={tex} metalness={0.35} roughness={0.5} clearcoat={0.6} clearcoatRoughness={0.25} envMapIntensity={0.7} />
        ) : (
          <meshStandardMaterial color="#15171a" roughness={0.6} />
        )}
      </mesh>

      {/* Indeks hari terapan; Senin (rebalance) berindeks ganda */}
      {DIAL_DAYS.map((_, i) => {
        const a = (i / 7) * Math.PI * 2;
        const r = 1.82;
        const pos = [Math.sin(a) * r, Math.cos(a) * r, 0.025] as const;
        return (
          <group key={i} position={pos} rotation-z={-a}>
            {i === 0 ? (
              <>
                <mesh position-x={-0.045} material={mats.index}>
                  <boxGeometry args={[0.045, 0.2, 0.04]} />
                </mesh>
                <mesh position-x={0.045} material={mats.index}>
                  <boxGeometry args={[0.045, 0.2, 0.04]} />
                </mesh>
              </>
            ) : (
              <mesh material={mats.index}>
                <boxGeometry args={[0.05, 0.16, 0.035]} />
              </mesh>
            )}
          </group>
        );
      })}

      {/* Busur progres minggu */}
      <mesh ref={arcRef} position-z={0.012} material={mats.arc}>
        <ringGeometry args={[1.705, 1.725, 8, 1, Math.PI / 2, 0.0001]} />
      </mesh>

      {/* Subdial */}
      <group position={[px, py, 0.03]}>
        <Hand length={subLen} width={0.025} tail={0.06} z={0} angle={pnl} light={mats.needle} dark={mats.needle} />
        <mesh rotation-x={Math.PI / 2} material={mats.bezel} position-z={0.02}>
          <cylinderGeometry args={[0.04, 0.04, 0.03, 20]} />
        </mesh>
      </group>
      <group position={[lx, ly, 0.03]}>
        <Hand length={subLen} width={0.025} tail={0.06} z={0} angle={lev} light={mats.needle} dark={mats.needle} />
        <mesh rotation-x={Math.PI / 2} material={mats.bezel} position-z={0.02}>
          <cylinderGeometry args={[0.04, 0.04, 0.03, 20]} />
        </mesh>
      </group>
      <group position={[sx, sy, 0.03]}>
        <Hand length={subLen} width={0.014} tail={0.08} z={0} angle={sec} light={mats.second} dark={mats.second} />
        <mesh rotation-x={Math.PI / 2} material={mats.second} position-z={0.02}>
          <cylinderGeometry args={[0.03, 0.03, 0.03, 20]} />
        </mesh>
      </group>

      {/* Jarum utama minggu */}
      <Hand length={1.62} width={0.085} tail={0.28} z={0.06} angle={main} light={mats.handLight} dark={mats.handDark} />
      <mesh rotation-x={Math.PI / 2} position-z={0.1} material={mats.bezel}>
        <cylinderGeometry args={[0.085, 0.085, 0.05, 32]} />
      </mesh>

      <mesh geometry={crystalGeo} material={mats.crystal} renderOrder={10} />
    </group>
  );
}

export default function Chronograph(props: ChronoProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 10.8], fov: 30 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      frameloop={reduced ? 'demand' : 'always'}
      aria-label="Kronograf mingguan 3D"
    >
      <ambientLight intensity={0.12} />
      <directionalLight position={[3, 5, 6]} intensity={1.4} color="#fff4e2" />
      <directionalLight position={[-5, -2, 3]} intensity={0.35} color="#bcd2ff" />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.4} color="#fff1d6" scale={[12, 3, 1]} position={[0, 6, 3]} rotation-x={Math.PI / 2.4} />
        <Lightformer form="rect" intensity={1.1} color="#cfdcff" scale={[2.5, 10, 1]} position={[-7, 0, 2]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.6} color="#ffd9a3" scale={[2.5, 10, 1]} position={[7, 1, 1]} rotation-y={-Math.PI / 2} />
        <Lightformer form="ring" intensity={0.9} color="#ffffff" scale={4} position={[0, -2, 9]} />
      </Environment>
      <Watch {...props} reduced={reduced} />
    </Canvas>
  );
}

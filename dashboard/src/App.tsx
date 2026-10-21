import { useCallback, useEffect, useState } from 'react';
import { Confirm } from './components/bits';
import { IconDial, IconLedger, IconPeople, IconRidges, IconShield } from './components/icons';
import { countdown, dateTime, timeOnly } from './data/format';
import { useSnapshot } from './data/useSnapshot';
import { Journal } from './views/Journal';
import { Lab } from './views/Lab';
import { Leaders } from './views/Leaders';
import { Overview } from './views/Overview';
import { Risk } from './views/Risk';

const VIEWS = [
  { id: 'ringkasan', label: 'Ringkasan', icon: IconDial },
  { id: 'lab', label: 'Lab Strategi', icon: IconRidges },
  { id: 'trader', label: 'Trader', icon: IconPeople },
  { id: 'jurnal', label: 'Jurnal', icon: IconLedger },
  { id: 'risiko', label: 'Risiko', icon: IconShield },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

const fromHash = (): ViewId => {
  const h = location.hash.replace('#', '');
  return (VIEWS.find((v) => v.id === h)?.id ?? 'ringkasan') as ViewId;
};

type Pending = { action: string; extra: Record<string, unknown>; title: string; body: string; label: string; danger?: boolean };

export default function App() {
  const { snap, conn, control, login } = useSnapshot();
  const [view, setView] = useState<ViewId>(fromHash);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  useEffect(() => {
    const on = () => setView(fromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const go = useCallback((v: string) => {
    location.hash = v;
    window.scrollTo({ top: 0 });
  }, []);

  const run = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      try {
        await control(action, extra);
        setToast(
          {
            pause: 'Engine dijeda. Posisi dibiarkan terbuka.',
            resume: 'Engine dilanjutkan.',
            flatten: 'Semua posisi ditutup, engine dijeda.',
            'run-cycle': 'Seleksi mingguan dijalankan. Hasil muncul dalam 1–2 menit.',
            'apply-playbook': 'Playbook disetujui dan aktif.',
            'set-profile': 'Profil risiko diganti.',
          }[action] ?? 'Selesai.',
        );
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
    },
    [control],
  );

  const act = useCallback(
    (action: string, extra: Record<string, unknown> = {}, confirm?: { title: string; body: string; label: string; danger?: boolean }) => {
      if (confirm) setPending({ action, extra, ...confirm });
      else void run(action, extra);
    },
    [run],
  );

  const live = conn.kind === 'live';
  const now = live ? Date.now() : snap.generatedAt;
  const st = snap.status.state;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="mark">
          <b>KAIROS</b>
          <span>Copy desk · futures</span>
        </div>
        <nav className="nav" aria-label="Halaman">
          {VIEWS.map((v) => (
            <a key={v.id} href={`#${v.id}`} aria-current={view === v.id ? 'page' : undefined} onClick={() => window.scrollTo({ top: 0 })}>
              <span className="idx">
                <v.icon />
              </span>
              <span>{v.label}</span>
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="label">Pembaruan</span>
          <span className="num">{dateTime(snap.generatedAt)} WIB</span>
          <span>{snap.synthetic ? 'Sumber: simulasi demo' : `Tick ${snap.status.tickMs} ms`}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {snap.synthetic ? (
            <span className="chip warn">
              <i /> Demo · data sintetis
            </span>
          ) : (
            <span className={`chip ${snap.mode === 'live' ? 'bad' : 'warn'}`}>
              <i /> {snap.mode === 'live' ? 'Live · uang asli' : 'Paper · harga asli'}
            </span>
          )}
          <span className="chip">{snap.venue === 'binance' ? 'Binance USDⓈ-M' : 'Hyperliquid'}</span>
          <span className={`chip ${st === 'running' ? 'ok' : st === 'halted' ? 'bad' : 'warn'} hide-sm`}>
            <i /> {st === 'running' ? 'Berjalan' : st === 'halted' ? 'Kill switch' : st === 'paused' ? 'Dijeda' : 'Memulai'}
            {live && !conn.online ? ' · terputus' : ''}
          </span>
          <span className="spacer" />
          <span className="label hide-sm">
            Rebalance Senin {timeOnly(snap.status.nextRebalance)} WIB · {countdown(snap.status.nextRebalance - now)}
          </span>
          {st === 'running' ? (
            <button className="btn" disabled={!live} onClick={() => act('pause')} title={live ? undefined : 'Butuh engine yang berjalan'}>
              Jeda
            </button>
          ) : (
            <button className="btn" disabled={!live || st === 'halted'} onClick={() => act('resume')}>
              Lanjutkan
            </button>
          )}
          <button
            className="btn danger"
            disabled={!live || !snap.positions.length}
            onClick={() => act('flatten', {}, { title: 'Tutup semua posisi?', body: `${snap.positions.length} posisi ditutup dengan market order dan engine dijeda.`, label: 'Tutup semua', danger: true })}
          >
            Tutup semua
          </button>
        </header>

        {snap.synthetic && (
          <div className="demo-banner" role="note">
            <b>DEMO</b>
            <span>
              Semua angka di sini berasal dari simulasi pasar sintetis dengan kode engine yang sama, bukan harga atau hasil asli. Jalankan <code>npm run engine</code> untuk data Binance/Hyperliquid sungguhan.
            </span>
          </div>
        )}

        {view === 'ringkasan' && <Overview snap={snap} go={go} />}
        {view === 'lab' && <Lab snap={snap} />}
        {view === 'trader' && <Leaders snap={snap} />}
        {view === 'jurnal' && <Journal snap={snap} />}
        {view === 'risiko' && <Risk snap={snap} conn={conn} act={act} />}
      </main>

      {pending && (
        <Confirm
          title={pending.title}
          body={pending.body}
          confirm={pending.label}
          danger={pending.danger}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void run(p.action, p.extra);
          }}
        />
      )}

      {conn.kind === 'auth' && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="token-title">
          <form
            className="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              login(tokenInput.trim());
            }}
          >
            <h2 id="token-title">Token dashboard</h2>
            <p>Engine meminta token. Isi dengan nilai DASHBOARD_TOKEN di file .env.</p>
            <input id="token" type="password" autoComplete="current-password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} autoFocus />
            <div className="row">
              <button className="btn primary" type="submit">
                Masuk
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

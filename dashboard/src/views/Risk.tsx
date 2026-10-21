import type { DashboardSnapshot, RiskProfileId } from '@shared/types';
import type { Connection } from '../data/useSnapshot';

// Salinan parameter engine/src/risk/profiles.ts untuk ditampilkan.
const PROFILES: { id: RiskProfileId; label: string; tag: string; rows: [string, string][] }[] = [
  {
    id: 'balanced',
    label: 'Seimbang',
    tag: 'Untuk akun yang tidak boleh turun banyak.',
    rows: [
      ['Target volatilitas', '45% / thn'],
      ['Leverage per posisi', '2×'],
      ['Leverage total', '3×'],
      ['Pengali copy', '1.0×'],
      ['Kill switch mingguan', '−12%'],
      ['Strategi / trader', '3 / 4'],
    ],
  },
  {
    id: 'bold',
    label: 'Berani',
    tag: 'Default. Terkonsentrasi ke juara, siap menahan minggu buruk.',
    rows: [
      ['Target volatilitas', '90% / thn'],
      ['Leverage per posisi', '4×'],
      ['Leverage total', '6×'],
      ['Pengali copy', '1.5×'],
      ['Kill switch mingguan', '−25%'],
      ['Strategi / trader', '2 / 3'],
    ],
  },
  {
    id: 'extreme',
    label: 'Ekstrem',
    tag: 'Satu strategi, dua trader, leverage tinggi. Bisa habis separuh dalam seminggu.',
    rows: [
      ['Target volatilitas', '150% / thn'],
      ['Leverage per posisi', '8×'],
      ['Leverage total', '10×'],
      ['Pengali copy', '2.5×'],
      ['Kill switch mingguan', '−40%'],
      ['Strategi / trader', '1 / 2'],
    ],
  },
];

export function Risk({ snap, conn, act }: { snap: DashboardSnapshot; conn: Connection; act: (action: string, extra?: Record<string, unknown>, confirm?: { title: string; body: string; label: string; danger?: boolean }) => void }) {
  const live = conn.kind === 'live';
  const running = snap.status.state === 'running';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Risiko & <em>kontrol</em>
          </h1>
          <p>
            Profil menentukan ukuran posisi, leverage, dan seberapa terkonsentrasi pilihan mingguan. Perubahan profil langsung berlaku untuk batas risiko; seleksi strategi & trader ikut berubah pada siklus berikutnya.
          </p>
        </div>
      </div>

      <div className="profiles">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            className="profile"
            aria-pressed={snap.risk.profile === p.id}
            disabled={!live || snap.risk.profile === p.id}
            onClick={() => act('set-profile', { profile: p.id }, { title: `Ganti ke ${p.label}?`, body: p.tag, label: `Pakai ${p.label}` })}
          >
            <span className="label">{snap.risk.profile === p.id ? 'Aktif' : 'Profil'}</span>
            <h3>{p.label}</h3>
            <span className="flat" style={{ fontSize: 'var(--t-small)' }}>
              {p.tag}
            </span>
            <dl>
              {p.rows.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </button>
        ))}
      </div>

      <div className="grid" style={{ marginTop: 'var(--gap)' }}>
        <section className="panel span-6">
          <div className="panel-head">
            <h2>Kontrol engine</h2>
            <span className={`chip ${running ? 'ok' : snap.status.state === 'halted' ? 'bad' : 'warn'}`}>
              <i /> {running ? 'Berjalan' : snap.status.state === 'halted' ? 'Berhenti (kill switch)' : snap.status.state === 'paused' ? 'Dijeda' : 'Memulai'}
            </span>
          </div>
          <div className="controls">
            {running ? (
              <button className="btn" disabled={!live} onClick={() => act('pause')}>
                Jeda order baru
              </button>
            ) : (
              <button className="btn" disabled={!live || snap.status.state === 'halted'} onClick={() => act('resume')}>
                Lanjutkan
              </button>
            )}
            <button className="btn" disabled={!live} onClick={() => act('run-cycle', {}, { title: 'Jalankan seleksi sekarang?', body: 'Turnamen strategi dan scout trader dijalankan ulang dengan data terbaru. Playbook baru langsung aktif bila auto-apply menyala.', label: 'Jalankan' })}>
              Jalankan seleksi sekarang
            </button>
            {snap.playbook && !snap.playbook.appliedAt && (
              <button className="btn primary" disabled={!live} onClick={() => act('apply-playbook')}>
                Setujui playbook
              </button>
            )}
            <button
              className="btn danger"
              disabled={!live || !snap.positions.length}
              onClick={() => act('flatten', {}, { title: 'Tutup semua posisi?', body: `${snap.positions.length} posisi ditutup dengan market order dan engine dijeda. Lanjutkan manual setelahnya.`, label: 'Tutup semua', danger: true })}
            >
              Tutup semua posisi
            </button>
          </div>
          {!live && <p className="note warn">Tombol aktif saat dashboard terhubung ke engine yang berjalan (npm run engine). Tampilan ini memakai data demo.</p>}
        </section>

        <section className="panel span-6">
          <div className="panel-head">
            <h2>Menuju live</h2>
          </div>
          <ul className="pick-list" style={{ marginTop: 0 }}>
            <li>
              <span className="what">
                1 · Paper dulu, minimal 2 siklus mingguan
                <small>MODE=paper memakai harga asli tanpa uang sungguhan. Lihat apakah hasilnya sesuai uji walk-forward.</small>
              </span>
            </li>
            <li>
              <span className="what">
                2 · API key tanpa izin penarikan
                <small>Binance: aktifkan Futures saja, batasi IP. Hyperliquid: pakai API wallet (agent), bukan private key wallet utama.</small>
              </span>
            </li>
            <li>
              <span className="what">
                3 · Mulai dengan modal kecil
                <small>MODE=live butuh CONFIRM_LIVE=I_UNDERSTAND_THE_RISK. Kill switch mingguan tetap aktif.</small>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}

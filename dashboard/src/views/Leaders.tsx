import type { DashboardSnapshot } from '@shared/types';
import { IconExternal } from '../components/icons';
import { num, pct, shortAddr, tone, usdCompact } from '../data/format';

export function Leaders({ snap }: { snap: DashboardSnapshot }) {
  const ls = snap.leaders;
  const copying = ls.filter((l) => l.status === 'copying');
  const rejected = ls.filter((l) => l.status === 'rejected');
  const copyAlloc = snap.playbook?.allocation.copy ?? 0;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Trader <em>Hyperliquid</em>
          </h1>
          <p>
            Semua posisi wallet Hyperliquid bersifat publik, jadi engine bisa menyalinnya tanpa izin siapa pun. Tiap Senin, leaderboard disaring lalu kandidat terbaik dianalisis: riwayat fill 7 hari, drawdown 30 hari, dan
            frekuensi trading. Yang lolos dibobot menurut skor; profil Berani menumpuk bobot ke peringkat teratas.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="figures" style={{ marginTop: 0, borderTop: 0 }}>
          <div>
            <span className="label">Dianalisis</span>
            <b>{ls.length}</b>
          </div>
          <div>
            <span className="label">Disalin</span>
            <b>{copying.length}</b>
          </div>
          <div>
            <span className="label">Ditolak</span>
            <b>{rejected.length}</b>
          </div>
          <div>
            <span className="label">Porsi modal copy</span>
            <b>{Math.round(copyAlloc * 100)}%</b>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 'var(--gap)' }}>
        <div className="panel-head">
          <h2>Hasil scout minggu ini</h2>
          <span className="sub">Ukuran posisi = proporsi eksposur trader × modal sleeve × {snap.risk.copyMultiplier}</span>
        </div>
        {ls.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Trader</th>
                  <th className="r">Akun</th>
                  <th className="r">ROI 7h</th>
                  <th className="r">ROI 30h</th>
                  <th className="r">Win rate</th>
                  <th className="r">DD 30h</th>
                  <th className="r">Fill/hari</th>
                  <th className="r">Skor</th>
                  <th>Bobot</th>
                  <th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                {ls.map((l) => (
                  <tr key={l.address}>
                    <td>
                      <span className={`status-pill ${l.status}`}>{l.status === 'copying' ? 'Disalin' : l.status === 'candidate' ? 'Kandidat' : 'Ditolak'}</span>
                    </td>
                    <td>
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span>{l.label}</span>
                        {snap.synthetic || !l.address.startsWith('0x') ? (
                          <span className="label" style={{ letterSpacing: '0.04em', textTransform: 'none' }}>
                            {shortAddr(l.address)}
                            {snap.synthetic ? ' · demo' : ''}
                          </span>
                        ) : (
                          <a className="label" style={{ letterSpacing: '0.04em', textTransform: 'none', display: 'inline-flex', gap: 4, alignItems: 'center' }} href={`https://app.hyperliquid.xyz/explorer/address/${l.address}`} target="_blank" rel="noreferrer">
                            {shortAddr(l.address)} <IconExternal />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="r">{l.accountValue ? usdCompact(l.accountValue) : '—'}</td>
                    <td className={`r ${tone(l.weekRoi)}`}>{pct(l.weekRoi)}</td>
                    <td className={`r ${tone(l.monthRoi)}`}>{pct(l.monthRoi)}</td>
                    <td className="r">{l.winRate === null ? '—' : `${Math.round(l.winRate * 100)}%`}</td>
                    <td className="r">{l.maxDrawdown === null ? '—' : pct(-l.maxDrawdown, 0)}</td>
                    <td className="r">{l.fillsPerDay === null ? '—' : num(l.fillsPerDay, 0)}</td>
                    <td className="r">{l.status === 'rejected' ? '—' : l.score.toFixed(2)}</td>
                    <td>
                      <span className="weight">
                        <span className="bar">
                          <i style={{ width: `${l.weight * 100}%` }} />
                        </span>
                        <span className="num">{Math.round(l.weight * 100)}%</span>
                      </span>
                    </td>
                    <td className="wrap flat">{l.reason ?? (l.status === 'copying' ? `${l.openPositions} posisi terbuka` : 'Lolos, di luar slot')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">Scout belum berjalan. Hasil muncul setelah seleksi mingguan pertama.</p>
        )}
      </section>

      <div className="grid" style={{ marginTop: 'var(--gap)' }}>
        <section className="panel span-6">
          <div className="panel-head">
            <h2>Saringan</h2>
          </div>
          <ul className="pick-list" style={{ marginTop: 0 }}>
            <li>
              <span className="what">
                Akun minimal & ROI positif
                <small>Nilai akun ≥ $25k, ROI 7 hari ≥ 3%, ROI 30 hari dan PnL all-time positif.</small>
              </span>
            </li>
            <li>
              <span className="what">
                Bukan bot / market maker
                <small>Volume mingguan ≤ 200× akun dan ≤ 150 fill per hari. Gaya HFT tidak bisa disalin tepat waktu.</small>
              </span>
            </li>
            <li>
              <span className="what">
                Bukan untung sekali
                <small>Minimal 3 trade ditutup dalam 7 hari, dan profit tidak boleh &gt; 85% dari satu trade.</small>
              </span>
            </li>
            <li>
              <span className="what">
                Drawdown terkendali
                <small>Drawdown kurva PnL 30 hari ≤ 45%. Batas bisa diubah lewat SCOUT_MAX_DRAWDOWN.</small>
              </span>
            </li>
          </ul>
        </section>
        <section className="panel span-6">
          <div className="panel-head">
            <h2>Skor</h2>
          </div>
          <ul className="pick-list" style={{ marginTop: 0 }}>
            <li>
              <span className="what">ROI 7 hari</span>
              <span className="num">40%</span>
            </li>
            <li>
              <span className="what">ROI 30 hari</span>
              <span className="num">20%</span>
            </li>
            <li>
              <span className="what">Win rate trade 7 hari</span>
              <span className="num">15%</span>
            </li>
            <li>
              <span className="what">Profit factor</span>
              <span className="num">15%</span>
            </li>
            <li>
              <span className="what">Drawdown 30 hari (makin kecil makin baik)</span>
              <span className="num">10%</span>
            </li>
          </ul>
          <p className="note">Bobot berbasis peringkat persentil antar kandidat yang lolos, jadi satu angka ekstrem tidak mendominasi.</p>
        </section>
      </div>
    </>
  );
}

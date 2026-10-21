import type { DashboardSnapshot } from '@shared/types';
import { IconExternal } from '../components/icons';
import { num, pct, shortAddr, tone, usdCompact } from '../data/format';

export function Leaders({ snap }: { snap: DashboardSnapshot }) {
  const ls = snap.leaders;
  const copying = ls.filter((l) => l.status === 'copying');
  const rejected = ls.filter((l) => l.status === 'rejected');
  const copyAlloc = snap.playbook?.allocation.copy ?? 0;
  const sc = snap.scout;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Trader <em>Hyperliquid</em>
          </h1>
          <p>
            Semua posisi wallet Hyperliquid bersifat publik, jadi engine bisa menyalinnya tanpa izin siapa pun. Tiap Senin, leaderboard disaring lalu kandidat dianalisis mendalam per 20 trader (riwayat fill 7 hari, lama pegang
            posisi, drawdown & hari profit 30 hari) sampai yang lolos cukup untuk diadu. Kandidat teratas lalu disalin ulang dari fill aslinya ({sc?.vetDays ?? 180} hari, $1.000, dengan biaya): hanya yang lolos uji salin
            ini yang boleh disalin, diurutkan menurut pertumbuhan mingguannya.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="figures" style={{ marginTop: 0, borderTop: 0 }}>
          <div>
            <span className="label">Dianalisis</span>
            <b>
              {sc ? sc.analyzed : ls.length}
              {sc && <span className="flat" style={{ fontSize: 'var(--t-small)', fontWeight: 400 }}> dari {sc.leaderboardSize}</span>}
            </b>
          </div>
          {sc?.vetted != null && (
            <div>
              <span className="label">Lolos uji salin</span>
              <b>
                {sc.vetPassed}
                <span className="flat" style={{ fontSize: 'var(--t-small)', fontWeight: 400 }}> dari {sc.vetted}</span>
              </b>
            </div>
          )}
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

      {sc && (
        <p className="note" style={{ maxWidth: 'none' }}>
          Pencarian berhenti setelah {sc.rounds} putaran: {sc.qualified} trader lolos semua uji pada saringan awal {sc.levelLabel}
          {sc.level > 0 ? ' (saringan awal dilonggarkan karena saringan Ketat tidak menghasilkan cukup trader)' : ''}.
          {snap.synthetic ? ' Di dunia demo, beberapa trader sintetis sengaja diberi keunggulan buatan untuk menguji apakah scout bisa menemukannya, jadi hasil copy di demo lebih bagus dari yang wajar.' : ''}
        </p>
      )}

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
                  <th className="r">Hari profit</th>
                  <th className="r">Pegang</th>
                  <th className="r">Fill/hari</th>
                  <th className="r">Uji salin</th>
                  <th className="r">DD uji</th>
                  <th className="r">Minggu +</th>
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
                    <td className="r">{l.positiveDays == null ? '—' : `${Math.round(l.positiveDays * 100)}%`}</td>
                    <td className="r">{l.holdHours == null ? '—' : l.holdHours >= 24 ? `${(l.holdHours / 24).toFixed(1)} hari` : `${l.holdHours.toFixed(1)} jam`}</td>
                    <td className="r">{l.fillsPerDay === null ? '—' : num(l.fillsPerDay, 0)}</td>
                    <td className={`r ${l.vet ? tone(l.vet.totalReturn) : ''}`} title={l.vet ? `$1.000 → $${Math.round(1000 * (1 + l.vet.totalReturn)).toLocaleString('en-US')} dalam ${l.vet.days} hari` : undefined}>
                      {l.vet ? pct(l.vet.totalReturn, 0) : '—'}
                    </td>
                    <td className="r">{l.vet ? pct(-l.vet.maxDrawdown, 0) : '—'}</td>
                    <td className="r">{l.vet ? `${l.vet.weeksUp}/${l.vet.weeks}` : '—'}</td>
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
                <small>Nilai akun ≥ $25k, ROI 7 hari ≥ 3%, ROI 30 hari dan PnL all-time positif. Bila trader yang lolos kurang, saringan ini dilonggarkan bertahap; uji di bawahnya tidak pernah dilonggarkan.</small>
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
                Bukan scalper
                <small>Maksimal 50% PnL dari posisi yang dipegang &lt; 10 menit. Gerakan secepat itu sudah lewat sebelum sempat disalin.</small>
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
            <li>
              <span className="what">
                Lolos uji salin historis
                <small>
                  $1.000 menyalin trader dari fill aslinya {sc?.vetDays ?? 180} hari ke belakang, dengan fee, slippage, keterlambatan, funding dan kill switch. Wajib aktif di ≥ separuh minggu, untung, kill switch ≤ 1× per 10 minggu,
                  drawdown ≤ 2× batas kill switch, PSR mingguan ≥ 0.8.
                </small>
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
              <span className="num">35%</span>
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
              <span className="num">10%</span>
            </li>
            <li>
              <span className="what">Hari profit 30 hari</span>
              <span className="num">10%</span>
            </li>
            <li>
              <span className="what">Drawdown 30 hari (makin kecil makin baik)</span>
              <span className="num">10%</span>
            </li>
          </ul>
          <p className="note">
            Skor scout berbasis peringkat persentil antar kandidat yang lolos, jadi satu angka ekstrem tidak mendominasi. Skor ini menentukan siapa yang ikut uji salin; urutan akhir & bobot ditentukan pertumbuhan mingguan hasil uji
            salin.
          </p>
        </section>
      </div>
    </>
  );
}

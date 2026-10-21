import type { DashboardSnapshot } from '@shared/types';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Sparkline } from '../components/bits';
import { LineChart } from '../components/LineChart';
import { STRATEGY_INFO } from '../data/catalog';
import { dateShort, dateTime, isoWeek, pct, tone } from '../data/format';

const Ridges = lazy(() => import('../three/Ridges'));

const LEVEL_LABEL = ['Ketat', 'Standar', 'Longgar', 'Darurat'];

const GATE_TEXT = [
  'Lolos saringan Ketat: aktif, profit, profit di ≥ 2 dari 3 sub-periode, Sharpe signifikan setelah dikoreksi jumlah kandidat (DSR ≥ 0.9), tetap profit dengan biaya 2×, parameter tetangga juga profit, drawdown dalam batas.',
  'Tidak ada yang lolos saringan Ketat, jadi dipakai Standar: sama, tetapi signifikansi memakai PSR ≥ 0.9 tanpa koreksi jumlah kandidat dan batas drawdown 1.3×.',
  'Saringan Longgar: bukti statistik lemah (PSR ≥ 0.7). Pertimbangkan ukuran posisi lebih kecil minggu ini.',
  'Saringan Darurat: tidak ada kandidat yang profit dengan bukti apa pun; juara dipilih murni dari skor.',
];

const cumulative = (rets: number[]) => {
  let eq = 1;
  return [0, ...rets.map((r) => (eq *= 1 + r) - 1)];
};

export function Lab({ snap }: { snap: DashboardSnapshot }) {
  const t = snap.tournament;
  const [hovered, setHovered] = useState<string | null>(null);
  const picked = new Set(snap.playbook?.strategies.map((s) => s.id) ?? []);

  const ridges = useMemo(
    () => (t?.entries ?? []).slice(0, 10).map((e) => ({ id: e.id, label: e.label, cumulative: cumulative(e.weeklyReturns), picked: picked.has(e.id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, snap.playbook],
  );

  const policySeries = useMemo(() => {
    if (!t) return [];
    let p = 1;
    let b = 1;
    const start = t.policy.weeks[0]?.weekStart ?? 0;
    const pol = [{ t: start, v: 0 }, ...t.policy.weeks.map((w) => ({ t: w.weekStart + 7 * 86_400_000, v: (p *= 1 + w.ret) - 1 }))];
    const ben = [{ t: start, v: 0 }, ...t.policy.weeks.map((w) => ({ t: w.weekStart + 7 * 86_400_000, v: (b *= 1 + w.benchmark) - 1 }))];
    return [
      { id: 'policy', name: 'Rotasi mingguan', color: 'var(--series-1)', points: pol },
      { id: 'bench', name: `Buy & hold ${t.benchmarkCoin}`, color: 'var(--series-2)', points: ben },
    ];
  }, [t]);

  if (!t) {
    return (
      <div className="page-head">
        <div>
          <h1>
            Turnamen <em>strategi</em>
          </h1>
          <p>Belum ada hasil. Engine menjalankan turnamen setiap Senin 07:00 WIB, atau jalankan sekarang dari halaman Risiko.</p>
        </div>
      </div>
    );
  }

  const weekLabels = (() => {
    const n = t.entries[0]?.weeklyReturns.length ?? 0;
    const end = t.policy.weeks.length ? t.policy.weeks[t.policy.weeks.length - 1].weekStart + 7 * 86_400_000 : t.dataTo;
    return Array.from({ length: n + 1 }, (_, i) => (i === n ? 'sekarang' : `${isoWeek(end - (n - i) * 7 * 86_400_000)}`));
  })();

  const p = t.policy;
  const q = t.qualification;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Turnamen <em>strategi</em>
          </h1>
          <p>
            Tiap Senin 07:00 WIB, {t.qualification.tested} kombinasi strategi × parameter × koin di-backtest (candle {t.interval}, fee, slippage & funding dihitung). Hanya kandidat yang lolos uji kelayakan boleh ikut
            turnamen; bila tidak ada yang lolos, pencarian diperluas ke koin lain lalu saringan dilonggarkan bertahap. Juaranya dipakai satu minggu penuh.
          </p>
        </div>
        <span className="label">Dijalankan {dateTime(t.ranAt)} WIB</span>
      </div>

      <section className="panel ridges" aria-label="Lanskap turnamen 3D">
        <Suspense fallback={null}>
          <Ridges ridges={ridges} hovered={hovered} onHover={setHovered} weekLabels={weekLabels} />
        </Suspense>
        <div className="overlay">
          <h2>10 kandidat teratas</h2>
          <p>Return kumulatif selama jendela seleksi, kandidat yang lolos uji kelayakan di depan. Kuningan = dipakai minggu ini. Seret untuk memutar.</p>
        </div>
      </section>

      <div className="grid" style={{ marginTop: 'var(--gap)' }}>
        <section className="panel span-7">
          <div className="panel-head">
            <h2>Uji kelayakan sebelum turnamen</h2>
            <span className={`chip ${q.level === 0 ? 'ok' : q.level === 1 ? '' : 'warn'}`}>
              <i /> Saringan {q.levelLabel}
            </span>
          </div>
          <div className="funnel" role="list" aria-label="Corong kualifikasi">
            {q.funnel.map((f, i) => (
              <div className="funnel-row" role="listitem" key={f.label}>
                <span className="funnel-label">{f.label}</span>
                <span className="funnel-track" aria-hidden="true">
                  <i style={{ width: `${Math.max(0.6, (f.remaining / Math.max(1, q.tested)) * 100)}%`, opacity: i === q.funnel.length - 1 ? 1 : 0.55 }} />
                </span>
                <span className="num funnel-n">{f.remaining}</span>
              </div>
            ))}
          </div>
          <p className="note">
            {GATE_TEXT[q.level]} Dengan {q.tested} kandidat, juara "karena untung-untungan" saja bisa mencapai Sharpe tahunan ±{q.expectedMaxSharpe.toFixed(1)}; itulah ambang Deflated Sharpe (DSR) pada saringan Ketat.
            {q.expanded ? ' Pencarian minggu ini diperluas ke koin paling likuid karena tidak ada kandidat yang lolos saringan Ketat.' : ''}
          </p>
        </section>

        <section className="panel span-5">
          <div className="panel-head">
            <h2>Aturan seleksi</h2>
            <span className="sub">dipilih ulang tiap minggu</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Jendela · bobot</th>
                  <th className="r">OOS</th>
                  <th className="r">Max DD</th>
                  <th className="r">Mgg+</th>
                </tr>
              </thead>
              <tbody>
                {t.rules.map((r) => (
                  <tr key={r.id} className={r.chosen ? 'hot' : undefined}>
                    <td>
                      {r.label}
                      {r.chosen && (
                        <span className="status-pill copying" style={{ marginLeft: 10 }}>
                          dipakai
                        </span>
                      )}
                    </td>
                    <td className={`r ${tone(r.oosReturn)}`}>{pct(r.oosReturn)}</td>
                    <td className="r">{pct(-r.maxDrawdown)}</td>
                    <td className="r">{Math.round(r.winRateWeeks * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            Jendela = berapa minggu terakhir yang dinilai; paruh = setelah berapa minggu bobot sebuah minggu tinggal separuh. Tiap Senin dipakai aturan dengan hasil out-of-sample terbaik pada 8 minggu sebelumnya.
          </p>
        </section>

        <section className="panel span-12">
          <div className="panel-head">
            <h2>Papan skor</h2>
            <span className="sub">
              {t.lookbackWeeks} minggu terakhir, aturan {t.chosenRule} · data {dateShort(t.dataFrom)} – {dateShort(t.dataTo)}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Strategi</th>
                  <th className="r">Skor</th>
                  <th className="r">{t.lookbackWeeks} mgg</th>
                  <th className="r">Mgg lalu</th>
                  <th className="r">Max DD</th>
                  <th className="r">Sharpe</th>
                  <th className="r">Mgg profit</th>
                  <th className="r">Entri</th>
                  <th className="r">PSR</th>
                  <th className="r">DSR</th>
                  <th>Uji kelayakan</th>
                  <th>Jejak</th>
                </tr>
              </thead>
              <tbody>
                {t.entries.slice(0, 20).map((e, i) => (
                  <tr key={e.id} className={hovered === e.id ? 'hot' : undefined} onPointerEnter={() => setHovered(e.id)} onPointerLeave={() => setHovered(null)}>
                    <td className="num flat">{i + 1}</td>
                    <td>
                      {e.label}
                      {picked.has(e.id) && (
                        <span className="status-pill copying" style={{ marginLeft: 10 }}>
                          dipakai
                        </span>
                      )}
                    </td>
                    <td className="r">{e.score.toFixed(3)}</td>
                    <td className={`r ${tone(e.stats.totalReturn)}`}>{pct(e.stats.totalReturn)}</td>
                    <td className={`r ${tone(e.stats.lastWeek)}`}>{pct(e.stats.lastWeek)}</td>
                    <td className="r">{pct(-e.stats.maxDrawdown)}</td>
                    <td className="r">{e.stats.sharpe.toFixed(2)}</td>
                    <td className="r">{Math.round(e.stats.winRateWeeks * 100)}%</td>
                    <td className="r">{e.stats.trades}</td>
                    <td className="r">{e.gate.psr.toFixed(2)}</td>
                    <td className="r">{e.gate.dsr.toFixed(2)}</td>
                    <td className={e.gate.passed ? 'up' : 'flat'}>{e.gate.passed ? 'Lolos' : `Gagal: ${e.gate.failed}`}</td>
                    <td>
                      <Sparkline values={cumulative(e.weeklyReturns)} color={picked.has(e.id) ? 'var(--series-1)' : 'var(--ivory-2)'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel span-7">
          <div className="panel-head">
            <h2>Apakah rotasi mingguan berhasil?</h2>
            <span className="sub">{p.weeks.length} minggu out-of-sample</span>
          </div>
          <div className="legend" style={{ marginBottom: 10 }}>
            {policySeries.map((s) => (
              <span key={s.id}>
                <i className="key" style={{ background: s.color }} /> {s.name}
              </span>
            ))}
          </div>
          <LineChart series={policySeries} height={250} formatY={(v) => pct(v, 0)} formatX={dateShort} baseline={0} ariaLabel="Return kumulatif rotasi mingguan dibanding buy and hold" />
          <div className="figures">
            <div>
              <span className="label">Rotasi</span>
              <b className={tone(p.totalReturn)}>{pct(p.totalReturn)}</b>
            </div>
            <div>
              <span className="label">{t.benchmarkCoin} hold</span>
              <b className={tone(p.benchmarkReturn)}>{pct(p.benchmarkReturn)}</b>
            </div>
            <div>
              <span className="label">Max DD</span>
              <b>{pct(-p.maxDrawdown)}</b>
            </div>
            <div>
              <span className="label">Minggu profit</span>
              <b>{Math.round(p.winRateWeeks * 100)}%</b>
            </div>
          </div>
          <p className={`note ${p.totalReturn < p.benchmarkReturn ? 'warn' : ''}`}>
            Tiap minggu di grafik ini, aturan seleksi, saringan, dan juara dipilih hanya dengan data sebelum minggu itu, lalu hasilnya dicatat (nested walk-forward). Ini uji paling jujur untuk metode "pilih juara tiap Senin".{' '}
            {p.totalReturn >= p.benchmarkReturn
              ? `Pada periode ini rotasi mengungguli buy & hold ${t.benchmarkCoin} sebesar ${pct(p.totalReturn - p.benchmarkReturn)}.`
              : `Pada periode ini rotasi tertinggal dari buy & hold ${t.benchmarkCoin}; pertimbangkan profil lain atau tambah porsi copy trader.`}
            {t.synthetic ? ' Data demo bersifat sintetis, bukan harga pasar.' : ''}
          </p>
        </section>

        <section className="panel span-5">
          <div className="panel-head">
            <h2>Pilihan per minggu</h2>
            <span className="sub">terbaru di atas</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 470, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Minggu</th>
                  <th>Juara saat itu</th>
                  <th>Aturan</th>
                  <th className="r">Hasil</th>
                </tr>
              </thead>
              <tbody>
                {[...p.weeks].reverse().map((w) => (
                  <tr key={w.weekStart}>
                    <td className="num flat">{isoWeek(w.weekStart)}</td>
                    <td className="wrap">
                      {w.pickedLabel}
                      <span className="label" style={{ display: 'block', letterSpacing: '0.06em', textTransform: 'none' }}>
                        saringan {LEVEL_LABEL[w.level]}
                      </span>
                    </td>
                    <td className="flat">{w.rule}</td>
                    <td className={`r ${tone(w.ret)}`}>{pct(w.ret)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel span-12">
          <div className="panel-head">
            <h2>Katalog strategi</h2>
            <span className="sub">7 metode, 24 set parameter, diuji di setiap koin</span>
          </div>
          <div className="catalog">
            {Object.entries(STRATEGY_INFO).map(([id, s]) => (
              <article key={id}>
                <span className="label">{s.family}</span>
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

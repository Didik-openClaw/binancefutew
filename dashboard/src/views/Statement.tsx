import type { DashboardSnapshot } from '@shared/types';
import { useMemo } from 'react';
import { CoinBadge } from '../components/bits';
import { IconExternal } from '../components/icons';
import { LineChart } from '../components/LineChart';
import { dateShort, dateTime, pct, price, qty, shortAddr, tone, usd, usdCompact, usdSigned } from '../data/format';

// Laporan akun yang bisa diaudit: statement, rekonsiliasi ledger, bukti replay historis, asal data.
export function Statement({ snap }: { snap: DashboardSnapshot }) {
  const st = snap.statement;
  const pv = snap.provenance;
  const rp = snap.replay;
  const replaySeries = useMemo(
    () => (rp ? [{ id: 'replay', name: `$${rp.startEquity.toLocaleString('en-US')} menyalin ${rp.label}`, color: 'var(--series-1)', area: true, points: rp.equity.map((p) => ({ t: p.t, v: p.equity })) }] : []),
    [rp],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Laporan <em>&amp; bukti</em>
          </h1>
          <p>
            Semua angka di bawah diturunkan dari buku besar (setiap order dan funding) dan harga dari bursa. Engine menghitung ulang ekuitas dari buku besar setiap menit dan membandingkannya dengan saldo akun; hasilnya terlihat di
            bagian rekonsiliasi.
          </p>
        </div>
      </div>

      <div className="grid">
        <section className="panel span-7 statement">
          <div className="panel-head">
            <h2>Statement akun</h2>
            <span className="sub">
              {snap.mode === 'live' ? 'Akun live' : snap.synthetic ? 'Akun demo' : 'Akun paper'} · {snap.venue === 'binance' ? 'Binance USDⓈ-M' : 'Hyperliquid'}
              {st ? ` · ${dateTime(st.periodStart)} – ${dateTime(st.periodEnd)} WIB` : ''}
            </span>
          </div>
          {st ? (
            <dl className="ledger">
              <div>
                <dt>Modal awal</dt>
                <dd className="num">{usd(st.startEquity)}</dd>
              </div>
              <div>
                <dt>PnL terealisasi</dt>
                <dd className={`num ${tone(st.realized)}`}>{usdSigned(st.realized)}</dd>
              </div>
              <div>
                <dt>Fee trading</dt>
                <dd className="num down">{usdSigned(-st.fees)}</dd>
              </div>
              <div>
                <dt>Funding {st.funding >= 0 ? 'dibayar' : 'diterima'}</dt>
                <dd className={`num ${tone(-st.funding)}`}>{usdSigned(-st.funding)}</dd>
              </div>
              <div>
                <dt>PnL belum terealisasi</dt>
                <dd className={`num ${tone(st.unrealized)}`}>{usdSigned(st.unrealized)}</dd>
              </div>
              <div className="total">
                <dt>Ekuitas akhir</dt>
                <dd className="num">{usd(st.endEquity)}</dd>
              </div>
              <div>
                <dt>Hasil bersih</dt>
                <dd className={`num ${tone(st.netPnl)}`}>
                  {usdSigned(st.netPnl)} ({pct(st.startEquity ? st.netPnl / st.startEquity : 0)})
                </dd>
              </div>
            </dl>
          ) : (
            <p className="empty">Statement muncul setelah rekonsiliasi pertama (±1 menit setelah engine berjalan).</p>
          )}
        </section>

        <section className="panel span-5">
          <div className="panel-head">
            <h2>Rekonsiliasi</h2>
            {st && (
              <span className={`chip ${st.reconciled ? 'ok' : 'bad'}`}>
                <i /> {st.reconciled ? 'Cocok' : 'Tidak cocok'}
              </span>
            )}
          </div>
          {st ? (
            <>
              <dl className="ledger compact">
                <div>
                  <dt>Ekuitas menurut engine</dt>
                  <dd className="num">{usd(st.endEquity)}</dd>
                </div>
                <div>
                  <dt>Dihitung ulang dari buku besar</dt>
                  <dd className="num">{usd(st.ledgerEquity)}</dd>
                </div>
                <div>
                  <dt>Selisih</dt>
                  <dd className="num">{usd(st.diff)}</dd>
                </div>
                <div>
                  <dt>Isi buku besar</dt>
                  <dd className="num">
                    {st.tradeCount} order · {st.fundingEvents} funding
                  </dd>
                </div>
              </dl>
              <p className="note">
                Rumus: modal awal + Σ PnL terealisasi − Σ fee − Σ funding + Σ (ukuran × (harga mark − harga masuk)). Diperiksa {dateTime(st.checkedAt)} WIB. {snap.mode === 'live' ? 'Akun live: yang dicocokkan adalah posisi; saldo mengikuti bursa.' : ''}
              </p>
            </>
          ) : (
            <p className="empty">Belum diperiksa.</p>
          )}
        </section>

        {rp && (
          <section className="panel span-12">
            <div className="panel-head">
              <h2>
                Bukti historis: {usd(rp.startEquity, 0)} menyalin {rp.label} selama {rp.days} hari
              </h2>
              <span className="sub">
                {dateShort(rp.from)} – {dateShort(rp.to)} · dari fill asli trader
              </span>
            </div>
            <LineChart series={replaySeries} height={260} formatY={(v) => usdCompact(v)} formatX={dateShort} formatTip={dateTime} baseline={rp.startEquity} ariaLabel="Kurva ekuitas replay copy trading" />
            <div className="figures">
              <div>
                <span className="label">Hasil</span>
                <b className={tone(rp.totalReturn)}>
                  {usd(rp.endEquity)} · {pct(rp.totalReturn)}
                </b>
              </div>
              <div>
                <span className="label">Drawdown maks</span>
                <b>{pct(-rp.maxDrawdown)}</b>
              </div>
              <div>
                <span className="label">Biaya</span>
                <b>
                  fee {usd(rp.fees)} · funding {usdSigned(-rp.funding)}
                </b>
              </div>
              <div>
                <span className="label">Order · kill switch</span>
                <b>
                  {rp.trades} · {rp.killSwitchHits}×
                </b>
              </div>
            </div>
            <ul className="assumptions">
              {rp.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <p className="note">
              Hitung ulang sendiri: <code>npm run replay -- {rp.leader} --days={rp.days} --start={rp.startEquity}</code>. Input lengkap (fill, candle, funding, kurva modal trader) tersimpan dengan SHA-256{' '}
              <code className="hash">{rp.inputsSha256}</code>.
            </p>
          </section>
        )}

        <section className="panel span-7">
          <div className="panel-head">
            <h2>Buku besar order</h2>
            <span className="sub">{snap.trades.length} terbaru</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Waktu (WIB)</th>
                  <th>Koin</th>
                  <th>Sisi</th>
                  <th className="r">Jumlah</th>
                  <th className="r">Harga</th>
                  <th className="r">Fee</th>
                  <th className="r">Realisasi</th>
                  <th>Alasan</th>
                </tr>
              </thead>
              <tbody>
                {snap.trades.map((t) => (
                  <tr key={t.id}>
                    <td className="num flat">{dateTime(t.t)}</td>
                    <td>
                      <span className="coin">
                        <CoinBadge coin={t.coin} />
                        {t.coin}
                      </span>
                    </td>
                    <td>
                      <span className={`side ${t.side === 'buy' ? 'long' : 'short'}`}>{t.side === 'buy' ? 'beli' : 'jual'}</span>
                    </td>
                    <td className="r">{qty(t.qty)}</td>
                    <td className="r">{price(t.px)}</td>
                    <td className="r flat">{usd(t.fee)}</td>
                    <td className={`r ${tone(t.realizedPnl)}`}>{t.realizedPnl ? usdSigned(t.realizedPnl) : '—'}</td>
                    <td className="flat">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!snap.trades.length && <p className="empty">Belum ada order.</p>}
          </div>
        </section>

        <section className="panel span-5">
          <div className="panel-head">
            <h2>Funding</h2>
            <span className="sub">dibebankan per jam dengan tarif bursa</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Koin</th>
                  <th className="r">Tarif</th>
                  <th className="r">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {snap.fundingLog.map((f, i) => (
                  <tr key={`${f.t}-${f.coin}-${i}`}>
                    <td className="num flat">{dateTime(f.t)}</td>
                    <td>{f.coin}</td>
                    <td className="r">{(f.rate * 100).toFixed(4)}%</td>
                    <td className={`r ${tone(-f.amount)}`}>{usdSigned(-f.amount, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!snap.fundingLog.length && <p className="empty">Belum ada funding yang jatuh tempo.</p>}
          </div>
        </section>

        {pv && (
          <section className="panel span-12">
            <div className="panel-head">
              <h2>Asal data</h2>
              <span className="sub">{pv.codeVersion ? `kode engine ${pv.codeVersion}` : ''}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Sumber</th>
                    <th>Keterangan</th>
                  </tr>
                </thead>
                <tbody>
                  {pv.sources.map((x) => (
                    <tr key={x.label}>
                      <td>{x.label}</td>
                      <td>
                        <code>{x.endpoint}</code>
                      </td>
                      <td className="wrap flat">{x.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!!pv.leaders.length && (
              <div className="provenance-leaders">
                {pv.leaders.map((l) => {
                  const snapL = pv.lastLeaderSnapshots.find((s) => s.address === l.address);
                  return (
                    <div key={l.address} className="leader-proof">
                      <div>
                        <span className="label">Trader yang disalin</span>
                        <b>{l.label}</b>
                        {l.explorer ? (
                          <a href={l.explorer} target="_blank" rel="noreferrer" className="proof-link">
                            {shortAddr(l.address)} di explorer Hyperliquid <IconExternal />
                          </a>
                        ) : (
                          <span className="flat">{shortAddr(l.address)}</span>
                        )}
                      </div>
                      {snapL && (
                        <div>
                          <span className="label">Posisi terakhir yang dibaca · {dateTime(snapL.ts)} WIB</span>
                          <span className="num">
                            modal {usdCompact(snapL.equity)} · {snapL.positions.map((p) => `${p.coin} ${p.size > 0 ? 'long' : 'short'} ${qty(Math.abs(p.size))}`).join(' · ') || 'tidak ada posisi'}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {!!pv.files.length && (
              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>File buku besar (data/state)</th>
                      <th className="r">Baris</th>
                      <th>SHA-256</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pv.files.map((f) => (
                      <tr key={f.name}>
                        <td>
                          <code>{f.name}</code>
                        </td>
                        <td className="r">{f.lines}</td>
                        <td>
                          <code className="hash">{f.sha256}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}

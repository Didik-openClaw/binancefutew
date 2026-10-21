import type { DashboardSnapshot } from '@shared/types';
import { lazy, Suspense, useMemo } from 'react';
import { CoinBadge, Meter, WeeklyBars } from '../components/bits';
import { LineChart } from '../components/LineChart';
import { countdown, dateShort, dateTime, isoWeek, pct, price, qty, shortAddr, timeOnly, tone, usd, usdCompact, usdSigned, weekday, weekProgressAt } from '../data/format';

const Chronograph = lazy(() => import('../three/Chronograph'));

export function sourceName(snap: DashboardSnapshot, src: string) {
  if (src === 'strategy') return 'Strategi';
  return snap.leaders.find((l) => l.address === src)?.label ?? shortAddr(src);
}

export function Overview({ snap, go }: { snap: DashboardSnapshot; go: (v: string) => void }) {
  const a = snap.account;
  const r = snap.risk;
  const pb = snap.playbook;
  const now = snap.generatedAt;
  const progress = weekProgressAt(now);
  const [whole, cents] = usd(a.equity).split('.');

  const equitySeries = useMemo(
    () => [{ id: 'eq', name: 'Ekuitas', color: 'var(--series-1)', area: true, points: snap.equityCurve.map((p) => ({ t: p.t, v: p.equity })) }],
    [snap.equityCurve],
  );
  const markers = snap.weeklyReturns.slice(1).map((w) => ({ t: w.weekStart, label: isoWeek(w.weekStart) }));

  return (
    <>
      <section className="panel hero" aria-label="Ringkasan akun">
        <div className="hero-copy">
          <div className="label">
            Ekuitas · {snap.mode === 'live' ? 'akun live' : 'akun paper'} {snap.venue === 'binance' ? 'Binance USDⓈ-M' : 'Hyperliquid'}
          </div>
          <p className="hero-figure">
            {whole}
            <span className="cents">.{cents}</span>
          </p>
          <div className="deltas">
            <span className="delta">
              <span className="label">Minggu ini</span>
              <b className={tone(a.weekPnl)}>{pct(a.weekPnlPct)}</b>
              <span className="num flat">{usdSigned(a.weekPnl)}</span>
            </span>
            <span className="delta">
              <span className="label">Sejak mulai</span>
              <b className={tone(a.totalPnl)}>{pct(a.totalPnlPct)}</b>
              <span className="num flat">{usdSigned(a.totalPnl, 0)}</span>
            </span>
          </div>
          {pb && (
            <div className="holding">
              <span className="label">
                Dipegang minggu {isoWeek(pb.weekStart)}
                {snap.tournament ? ` · bukti ${snap.tournament.qualification.levelLabel.toLowerCase()}` : ''}
              </span>
              <ul>
                {pb.strategies.map((s) => (
                  <li key={s.id}>
                    <i className="key" style={{ background: 'var(--series-1)' }} />
                    <span>{s.label}</span>
                    <b className="num">{Math.round(s.weight * pb.allocation.strategy * 100)}%</b>
                  </li>
                ))}
                {pb.leaders.map((l) => (
                  <li key={l.address}>
                    <i className="key" style={{ background: 'var(--series-2)' }} />
                    <span>{l.label}</span>
                    <b className="num">{Math.round(l.weight * pb.allocation.copy * 100)}%</b>
                  </li>
                ))}
                {!pb.leaders.length && (
                  <li className="flat">
                    <i className="key" style={{ background: 'var(--rule)' }} />
                    <span>Tidak ada trader yang lolos scout</span>
                    <b className="num">0%</b>
                  </li>
                )}
              </ul>
            </div>
          )}
          <div className="stats">
            <div className="stat">
              <span className="label">Leverage</span>
              <span className="v">{a.leverage.toFixed(2)}×</span>
              <span className="s">batas {r.maxGrossLeverage}×</span>
            </div>
            <div className="stat">
              <span className="label">Gross</span>
              <span className="v">{usdCompact(a.grossExposure)}</span>
              <span className="s">{snap.positions.length} posisi</span>
            </div>
            <div className="stat">
              <span className="label">Net</span>
              <span className={`v ${tone(a.netExposure)}`}>{usdCompact(a.netExposure)}</span>
              <span className="s">{a.netExposure >= 0 ? 'condong long' : 'condong short'}</span>
            </div>
            <div className="stat">
              <span className="label">Rebalance</span>
              <span className="v">{countdown(snap.status.nextRebalance - now)}</span>
              <span className="s">Senin {timeOnly(snap.status.nextRebalance)} WIB</span>
            </div>
          </div>
        </div>
        <div className="instrument">
          <Suspense fallback={<div className="canvas-slot" />}>
            <Chronograph
              weekProgress={progress}
              pnlRatio={a.weekPnlPct / r.weeklyLossLimit}
              levRatio={a.leverage / r.maxGrossLeverage}
              lossLimit={r.weeklyLossLimit}
              maxLeverage={r.maxGrossLeverage}
            />
          </Suspense>
          <div className="legend-strip" aria-label="Cara membaca kronograf">
            <span>
              <i className="key" />
              <b>Jarum utama</b> {Math.round(progress * 100)}% minggu berjalan ({weekday(now)})
            </span>
            <span>
              <i className="key ivory" />
              <b>Kiri</b> PnL minggu {pct(a.weekPnlPct)} · batas −{Math.round(r.weeklyLossLimit * 100)}%
            </span>
            <span>
              <i className="key ivory" />
              <b>Kanan</b> leverage {a.leverage.toFixed(2)}× · batas {r.maxGrossLeverage}×
            </span>
          </div>
        </div>
      </section>

      <div className="grid" style={{ marginTop: 'var(--gap)' }}>
        <section className="panel span-8">
          <div className="panel-head">
            <h2>Kurva ekuitas</h2>
            <span className="sub">
              {dateShort(snap.equityCurve[0]?.t ?? now)} – {dateShort(now)} · garis tipis = awal minggu (Senin 07:00 WIB)
            </span>
          </div>
          <LineChart series={equitySeries} height={270} formatY={(v) => usdCompact(v)} formatX={dateShort} formatTip={dateTime} markers={markers} baseline={a.startEquity} ariaLabel="Kurva ekuitas akun" />
        </section>
        <section className="panel span-4">
          <div className="panel-head">
            <h2>Return mingguan</h2>
            <span className="sub">{snap.weeklyReturns.filter((w) => w.ret > 0).length} dari {snap.weeklyReturns.length} minggu profit</span>
          </div>
          <WeeklyBars weeks={snap.weeklyReturns} height={232} />
        </section>

        <section className="panel span-7">
          <div className="panel-head">
            <h2>Playbook minggu ini</h2>
            <button className="btn" onClick={() => go('lab')}>
              Lihat turnamen
            </button>
          </div>
          {pb ? (
            <>
              <div className="alloc">
                <div className="alloc-bar" aria-hidden="true">
                  {pb.allocation.strategy > 0 && <i style={{ flex: pb.allocation.strategy, background: 'var(--series-1)' }} />}
                  {pb.allocation.copy > 0 && <i style={{ flex: pb.allocation.copy, background: 'var(--series-2)' }} />}
                  {pb.allocation.strategy + pb.allocation.copy === 0 && <i style={{ flex: 1, background: 'var(--rule)' }} />}
                </div>
                <div className="alloc-legend">
                  <span>
                    <i className="key" style={{ background: 'var(--series-1)' }} /> Strategi {Math.round(pb.allocation.strategy * 100)}%
                  </span>
                  <span>
                    <i className="key" style={{ background: 'var(--series-2)' }} /> Copy trader {Math.round(pb.allocation.copy * 100)}%
                  </span>
                </div>
              </div>
              <ul className="pick-list">
                {pb.strategies.map((s) => (
                  <li key={s.id}>
                    <span className="what">
                      {s.label}
                      <small>Juara turnamen · {s.universe.length > 1 ? `${s.universe.length} koin` : s.universe[0]}</small>
                    </span>
                    <span className="num">{Math.round(s.weight * 100)}% dari sleeve</span>
                  </li>
                ))}
                {pb.leaders.map((l) => (
                  <li key={l.address}>
                    <span className="what">
                      {l.label}
                      <small>Trader Hyperliquid · {shortAddr(l.address)}</small>
                    </span>
                    <span className="num">{Math.round(l.weight * 100)}% dari sleeve</span>
                  </li>
                ))}
                {!pb.leaders.length && (
                  <li>
                    <span className="what">
                      Tidak ada trader yang lolos minggu ini
                      <small>Semua kandidat ditolak filter, modal copy dialihkan ke strategi.</small>
                    </span>
                    <button className="btn" onClick={() => go('trader')}>
                      Alasan
                    </button>
                  </li>
                )}
              </ul>
              <p className="note">
                Dibuat {weekday(pb.createdAt)} {dateTime(pb.createdAt)} WIB · profil {pb.riskProfile === 'bold' ? 'Berani' : pb.riskProfile === 'extreme' ? 'Ekstrem' : 'Seimbang'}
                {pb.appliedAt ? '' : ' · menunggu persetujuan'}. {pb.notes[1] ?? ''}
              </p>
            </>
          ) : (
            <p className="empty">Playbook pertama dibuat saat engine menyelesaikan seleksi mingguan.</p>
          )}
        </section>

        <section className="panel span-5">
          <div className="panel-head">
            <h2>Risiko</h2>
            <span className={`chip ${r.killSwitch === 'triggered' ? 'bad' : 'ok'}`}>
              <i /> Kill switch {r.killSwitch === 'triggered' ? 'aktif' : 'siaga'}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 20 }}>
            <Meter
              label="Rugi minggu ini vs batas"
              value={`${Math.round(Math.max(0, r.weekLossUsed) * 100)}% terpakai`}
              ratio={r.weekLossUsed}
              zones={{ warn: 0.6, bad: 0.85 }}
              display={`Semua posisi ditutup otomatis bila ekuitas turun ${Math.round(r.weeklyLossLimit * 100)}% dari ${usd(r.weekStartEquity, 0)} (awal minggu).`}
            />
            <Meter label="Leverage gross" value={`${a.leverage.toFixed(2)}× / ${r.maxGrossLeverage}×`} ratio={a.leverage / r.maxGrossLeverage} zones={{ warn: 0.7, bad: 0.9 }} />
            <div className="figures" style={{ marginTop: 0 }}>
              <div>
                <span className="label">Per posisi</span>
                <b>{r.maxPositionLeverage}×</b>
              </div>
              <div>
                <span className="label">Copy</span>
                <b>{r.copyMultiplier}×</b>
              </div>
              <div>
                <span className="label">Fee</span>
                <b>{usd(a.feesPaid, 0)}</b>
              </div>
              <div>
                <span className="label">Profil</span>
                <b>{r.profile === 'bold' ? 'Berani' : r.profile === 'extreme' ? 'Ekstrem' : 'Seimbang'}</b>
              </div>
            </div>
          </div>
        </section>

        <section className="panel span-12">
          <div className="panel-head">
            <h2>Posisi terbuka</h2>
            <span className="sub">{snap.positions.length ? `${usdCompact(a.grossExposure)} gross` : 'Flat'}</span>
          </div>
          <PositionsTable snap={snap} />
        </section>
        <section className="panel span-12">
          <div className="panel-head">
            <h2>Aktivitas terakhir</h2>
            <button className="btn" onClick={() => go('jurnal')}>
              Jurnal
            </button>
          </div>
          <ul className="feed two-col">
            {snap.trades.slice(0, 8).map((t) => (
              <li key={t.id}>
                <time>{dateTime(t.t)}</time>
                <span className="msg">
                  <b className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? 'Beli' : 'Jual'}</b> {qty(t.qty)} {t.coin} @ {price(t.px)} · {t.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

export function PositionsTable({ snap }: { snap: DashboardSnapshot }) {
  if (!snap.positions.length) return <p className="empty">Tidak ada posisi. Engine menunggu sinyal strategi atau leader.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Koin</th>
            <th>Arah</th>
            <th className="r">Ukuran</th>
            <th className="r">Notional</th>
            <th className="r">Entry</th>
            <th className="r">Mark</th>
            <th className="r">uPnL</th>
            <th>Sumber</th>
          </tr>
        </thead>
        <tbody>
          {snap.positions.map((p) => (
            <tr key={p.coin}>
              <td>
                <span className="coin">
                  <CoinBadge coin={p.coin} />
                  {p.coin}
                </span>
              </td>
              <td>
                <span className={`side ${p.side}`}>{p.side}</span>
              </td>
              <td className="r">{qty(p.size)}</td>
              <td className="r">{usd(p.notional, 0)}</td>
              <td className="r">{price(p.entryPx)}</td>
              <td className="r">{price(p.markPx)}</td>
              <td className={`r ${tone(p.upnl)}`}>
                {usdSigned(p.upnl)} <span className="flat">({pct(p.upnlPct)})</span>
              </td>
              <td className="flat">{p.sources.map((s) => sourceName(snap, s)).join(' + ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

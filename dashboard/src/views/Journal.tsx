import type { DashboardSnapshot } from '@shared/types';
import { useState } from 'react';
import { CoinBadge } from '../components/bits';
import { dateTime, price, qty, tone, usd, usdSigned } from '../data/format';
import { PositionsTable } from './Overview';

export function Journal({ snap }: { snap: DashboardSnapshot }) {
  const coins = [...new Set(snap.trades.map((t) => t.coin))].sort();
  const [coin, setCoin] = useState('all');
  const trades = coin === 'all' ? snap.trades : snap.trades.filter((t) => t.coin === coin);
  const realized = trades.reduce((a, t) => a + t.realizedPnl, 0);
  const fees = trades.reduce((a, t) => a + t.fee, 0);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Jurnal <em>eksekusi</em>
          </h1>
          <p>Setiap order yang dikirim engine, beserta alasannya. Waktu dalam WIB.</p>
        </div>
        <label className="label" htmlFor="coin-filter" style={{ display: 'grid', gap: 6 }}>
          Koin
          <select id="coin-filter" className="btn" value={coin} onChange={(e) => setCoin(e.target.value)}>
            <option value="all">Semua</option>
            {coins.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Posisi terbuka</h2>
        </div>
        <PositionsTable snap={snap} />
      </section>

      <section className="panel" style={{ marginTop: 'var(--gap)' }}>
        <div className="panel-head">
          <h2>Order</h2>
          <span className="sub">
            {trades.length} order · realisasi <b className={tone(realized)}>{usdSigned(realized)}</b> · fee {usd(fees)}
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Koin</th>
                <th>Sisi</th>
                <th className="r">Jumlah</th>
                <th className="r">Harga</th>
                <th className="r">Notional</th>
                <th className="r">PnL realisasi</th>
                <th className="r">Fee</th>
                <th>Alasan</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 120).map((t) => (
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
                  <td className="r">{usd(t.notional, 0)}</td>
                  <td className={`r ${tone(t.realizedPnl)}`}>{t.realizedPnl ? usdSigned(t.realizedPnl) : '—'}</td>
                  <td className="r flat">{usd(t.fee)}</td>
                  <td className="flat">{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 'var(--gap)' }}>
        <div className="panel-head">
          <h2>Log engine</h2>
        </div>
        <ul className="feed">
          {snap.alerts.map((a, i) => (
            <li key={i} className={a.level}>
              <time>{dateTime(a.t)}</time>
              <span className="msg">{a.message}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

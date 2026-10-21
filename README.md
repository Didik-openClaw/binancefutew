# Kairos Copy Desk

Platform copy trade futures untuk **Hyperliquid** dan **Binance USDⓈ-M**, dengan seleksi metode trading **tiap minggu** dan dashboard 3D.

Setiap Senin 07:00 WIB (00:00 UTC) engine:

1. **Menguji kelayakan semua kandidat strategi.** 7 metode × 24 set parameter × setiap koin (± 220 kandidat) di-backtest pada candle 1 jam, lengkap dengan fee, slippage, dan funding. Hanya kandidat yang lolos uji statistik boleh ikut turnamen (lihat *Uji kelayakan* di bawah).
2. **Mencari sampai dapat.** Bila tidak ada kandidat yang lolos saringan Ketat, pencarian diperluas ke 25 koin paling likuid, baru kemudian saringan dilonggarkan bertahap (Ketat → Standar → Longgar → Darurat). Tingkat yang dipakai selalu dilaporkan.
3. **Memilih aturan seleksi terbaik** (berapa minggu ke belakang, seberapa berat minggu terbaru) dengan *nested walk-forward*, lalu menjalankan turnamen. Juaranya dipakai satu minggu penuh.
4. **Mencari trader Hyperliquid terbaik.** Leaderboard publik disaring, lalu kandidat dianalisis mendalam per 20 trader sampai yang lolos cukup untuk diadu.
5. **Menyusun playbook** (porsi strategi vs copy trader) dan langsung mengeksekusinya ke akun Anda, dengan kill switch mingguan.

```
engine/      TypeScript: data, strategi, backtest, turnamen, scout, mesin copy, broker, API
dashboard/   React + three.js (React Three Fiber): kronograf mingguan 3D, lanskap turnamen 3D
shared/      Tipe data engine <-> dashboard
```

## Mulai cepat

Butuh Node.js 20.10+.

```bash
npm install
npm run build          # build dashboard
npm run demo           # pasar & trader SINTETIS, tanpa koneksi bursa -> http://127.0.0.1:8787
```

Data asli, uang simulasi (paper):

```bash
cp .env.example .env   # MODE=paper sudah default
npm run hunt           # cari metode & trader terbaik minggu ini dari data asli, lalu cetak kesimpulan
npm run engine         # jalankan engine + dashboard
```

Untuk mengembangkan dashboard dengan hot reload: `npm run engine` di satu terminal, `npm run dev` di terminal lain (Vite mem-proxy `/api` dan `/ws` ke engine).

## Metode mingguan

Pertanyaan "metode apa yang paling profitable minggu ini" tidak punya jawaban tetap: pasar kripto berganti rezim (tren, sideways, crash) dan metode yang menang ikut berganti. Jadi engine tidak mengunci satu metode; tiap minggu ia mengadu semua metode di data terbaru dan memilih juaranya.

| Metode | Keluarga | Ide |
|---|---|---|
| Donchian Breakout | Breakout | Ikut tembusan high/low N jam, keluar di channel separuhnya |
| EMA Trend + ATR Trail | Trend | Persilangan EMA dengan trailing stop k×ATR |
| Supertrend | Trend | Selalu di pasar, berbalik saat band ATR ditembus |
| Volatility Squeeze | Breakout | Masuk saat Bollinger yang menyempit pecah |
| RSI Snapback | Reversion | Lawan arah di RSI ekstrem, keluar di RSI 50 |
| Time-Series Momentum | Momentum | Arah = tanda return 3/7/14 hari terakhir |
| Cross-Sectional Rotation | Momentum | Tiap Senin long koin terkuat & short terlemah (atau kebalikannya) |

Momentum 1–4 minggu di kripto, baik per koin maupun antar koin, adalah salah satu efek yang paling konsisten di riset akademik (mis. Liu & Tsyvinski, *Risks and Returns of Cryptocurrency*; Liu, Tsyvinski & Wu, *Common Risk Factors in Cryptocurrency*). Karena itu dua metode momentum di atas memakai horizon mingguan.

**Uji kelayakan (sebelum turnamen).** Kandidat harus lolos semua gerbang ini, dengan ambang sesuai tingkat saringan:

| Gerbang | Ketat | Standar | Longgar |
|---|---|---|---|
| Aktif (entri dalam jendela) | ≥ 4 | ≥ 3 | ≥ 2 |
| Profit & skor positif | ya | ya | ya |
| Konsisten: profit di sub-periode (dari 3) | ≥ 2 | ≥ 2 | ≥ 1 |
| Signifikan: Probabilistic Sharpe Ratio | ≥ 0.95 | ≥ 0.9 | ≥ 0.7 |
| Signifikan setelah koreksi jumlah kandidat: Deflated Sharpe Ratio | ≥ 0.9 | – | – |
| Tahan biaya (fee+slippage dikali) | 2× | 2× | 1.5× |
| Parameter stabil: median return parameter tetangga | ≥ 0% | ≥ −5% | – |
| Drawdown ≤ batas profil × | 1.0 | 1.3 | 1.6 |

Deflated Sharpe Ratio (Bailey & López de Prado) menjawab pertanyaan kunci turnamen: dengan ± 220 kandidat yang diuji, juara bisa terlihat hebat murni karena untung-untungan. DSR hanya meloloskan kandidat yang Sharpe-nya melampaui ambang "juara karena untung" itu.

**Aturan seleksi (nested walk-forward).** Tujuh aturan diadu: jendela 4/8/12 minggu × paruh-umur bobot 2/4/8 minggu. Tiap Senin dipakai aturan yang hasil out-of-sample-nya terbaik pada 8 minggu sebelumnya. Seluruh pipeline (saringan, aturan, juara) diuji tanpa melihat masa depan.

**Skor (agresif).** Rata-rata return mingguan dengan bobot paruh-umur 4 minggu (minggu terbaru paling berat), dikurangi penalti downside dan penalti drawdown di atas batas profil. Profil *Berani* hanya memakai 2 juara dan menumpuk modal ke juara pertama.

**Ukuran posisi.** Volatility targeting: leverage = target volatilitas tahunan ÷ volatilitas realisasi 7 hari, dibatasi per posisi dan total.

**Validasi yang jujur.** `npm run hunt` juga mensimulasikan seluruh proses "pilih juara tiap Senin" pada 26 minggu terakhir, di mana tiap pilihan (aturan, saringan, juara) hanya memakai data sebelum minggu itu. Hasilnya dibandingkan dengan buy & hold BTC dan ditampilkan di halaman *Lab Strategi*. Kalau rotasi kalah dari buy & hold di data Anda, angka itu akan terlihat di sana, dan sebaiknya dipercaya.

## Copy trading

- **Leader Hyperliquid**: semua posisi wallet Hyperliquid publik, jadi cukup alamatnya (otomatis dari scout atau manual via `LEADERS`).
- **Scout sampai dapat**: kandidat dianalisis per 20 trader (fill 7 hari, posisi direkonstruksi untuk mengukur lama pegang, kurva PnL 30 hari) sampai yang lolos ≥ 2× jumlah slot, leaderboard habis, atau 40 trader (`SCOUT_DEEP_DIVE`). Bila kurang, saringan awal (ukuran akun, ROI 7 hari) dilonggarkan. Uji kelayakan salin (bukan bot, bukan scalper < 10 menit, bukan untung sekali, drawdown dalam batas) tidak pernah dilonggarkan.
- **Skor trader**: ROI 7 hari 35%, ROI 30 hari 20%, win rate 15%, profit factor 10%, drawdown 10%, hari profit 10% (peringkat persentil).
- **Ukuran**: target notional = (notional leader ÷ ekuitas leader) × modal sleeve × bobot leader × pengali copy. Posisi disinkronkan tiap tick (default 10 detik). Pengurangan & penutupan dieksekusi sebelum penambahan.
- **Eksekusi** ke Hyperliquid atau Binance (simbol `kPEPE` ↔ `1000PEPEUSDT` dipetakan otomatis; koin yang tidak ada di venue dilewati).
- **Data leader basi** (> 120 detik): rebalancing ditahan, bukan menebak.
- **Leader Binance**: akun Binance yang membagikan API key read-only (mis. akun sinyal Anda sendiri) bisa ikut disalin lewat `BINANCE_LEADER_API_KEY` / `BINANCE_LEADER_API_SECRET`. Posisi trader di leaderboard Binance tidak tersedia lewat API resmi, jadi scout otomatis hanya memakai Hyperliquid.

## Profil risiko

| | Seimbang | **Berani** (default) | Ekstrem |
|---|---|---|---|
| Target volatilitas | 45%/thn | 90%/thn | 150%/thn |
| Leverage per posisi / total | 2× / 3× | 4× / 6× | 8× / 10× |
| Pengali copy | 1.0× | 1.5× | 2.5× |
| Kill switch mingguan | −12% | −25% | −40% |
| Strategi / trader dipakai | 3 / 4 | 2 / 3 | 1 / 2 |

Kill switch: bila ekuitas turun sebesar batas dari ekuitas awal minggu, semua posisi ditutup dan engine berhenti sampai Senin berikutnya.

## Menuju live

1. Jalankan `MODE=paper` minimal 2 siklus mingguan dan bandingkan dengan validasi walk-forward.
2. Binance: API key dengan izin Futures saja, tanpa Withdraw, batasi IP. Hyperliquid: pakai **API wallet** (agent) dari app.hyperliquid.xyz/API, bukan private key wallet utama.
3. Set `MODE=live` dan `CONFIRM_LIVE=I_UNDERSTAND_THE_RISK`. Mulai dengan modal kecil.

Futures dengan leverage bisa menghabiskan modal. Tidak ada metode yang menjamin profit, termasuk juara mingguan: hasil masa lalu sering berbalik. Engine ini memilih secara sistematis dan membatasi kerugian per minggu, tetapi keputusan modal tetap di tangan Anda.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run engine` | Engine + API + dashboard (port 8787) |
| `npm run demo` | Engine dengan pasar sintetis, jam dipercepat |
| `npm run hunt` | Seleksi lengkap (uji kelayakan → turnamen → scout trader) dari data asli, cetak kesimpulan & simpan |
| `npm run hunt -- --demo` | Sama, di pasar & trader sintetis (tanpa internet) |
| `npm run tournament` | Hanya turnamen strategi |
| `npm run scout` | Hanya scout trader Hyperliquid |
| `npm run dev` | Dashboard dev server (Vite) |
| `npm run build` | Build dashboard ke `dashboard/dist` |
| `npm run build:single` | Dashboard satu file HTML dengan data demo |
| `npm run demo:snapshot` | Tulis ulang `dashboard/src/demo/snapshot.json` |
| `npm test` | Unit test engine |

Data & state disimpan di `data/` (cache candle, akun paper, trade, ekuitas).

## Pengujian

`npm test` menjalankan 39 test, termasuk:

- **Tanpa lookahead**: mengubah harga masa depan tidak boleh mengubah posisi masa lalu, untuk ketujuh strategi.
- Pemilihan minggu *k* tidak melihat return minggu *k*; seluruh pipeline nested walk-forward tidak berubah bila harga masa depan diubah.
- Kandidat dengan edge nyata lolos saringan Ketat di antara 80 kandidat noise; tanpa edge, saringan dilonggarkan dan juara tetap ditemukan.
- Scout terus menggali saat kandidat teratas ditolak, melonggarkan saringan awal bila perlu, dan menghormati batas analisis.
- Backtester, kill switch, PnL paper broker, matematika mirror & rencana order (flip, band, reduce-first), saringan scout.
- Leader yang datanya basi membekukan order; leader yang mati > 5× batas dikeluarkan dengan peringatan.
- Simulasi end-to-end: seleksi mingguan → copy leader → order → snapshot dashboard.

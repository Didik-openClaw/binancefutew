// Ringkasan katalog strategi engine (engine/src/strategies/catalog.ts) untuk ditampilkan di Lab.
export const STRATEGY_INFO: Record<string, { name: string; family: string; text: string }> = {
  donchian: {
    name: 'Donchian Breakout',
    family: 'Breakout',
    text: 'Masuk saat harga menembus high/low N jam terakhir, keluar di channel separuhnya. Menunggang tren besar, siap rugi kecil berkali-kali.',
  },
  'ema-trend': {
    name: 'EMA Trend + ATR Trail',
    family: 'Trend',
    text: 'Arah mengikuti persilangan EMA cepat/lambat. Trailing stop k×ATR mengunci profit; setelah kena stop, tunggu persilangan berikutnya.',
  },
  supertrend: {
    name: 'Supertrend',
    family: 'Trend',
    text: 'Band ATR yang mengikuti harga. Selalu di pasar: long di atas band, short di bawahnya. Cepat berbalik arah.',
  },
  squeeze: {
    name: 'Volatility Squeeze',
    family: 'Breakout',
    text: 'Tunggu Bollinger menyempit ke 20% terbawah, lalu ikut arah tembusan band. Keluar saat harga kembali ke garis tengah.',
  },
  'rsi-revert': {
    name: 'RSI Snapback',
    family: 'Reversion',
    text: 'Lawan arah saat RSI ekstrem, tutup saat RSI kembali ke 50. Kuat di pasar sideways, rawan di tren kuat.',
  },
  'ts-momentum': {
    name: 'Time-Series Momentum',
    family: 'Momentum',
    text: 'Long bila return N jam terakhir positif, short bila negatif, dievaluasi tiap 24 jam. Efek momentum 1–4 minggu di kripto terdokumentasi di riset akademik.',
  },
  'xs-momentum': {
    name: 'Cross-Sectional Rotation',
    family: 'Momentum',
    text: 'Tiap Senin semua koin diurutkan menurut return N jam. Momentum: long K terkuat, short K terlemah. Reversal: kebalikannya. Netral terhadap arah pasar.',
  },
};

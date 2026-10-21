import type { LeaderView, ScoutSummary } from '../../shared/types';
import { describePolicyEdge, fmtPct, GATES, type TournamentRun } from './backtest/tournament';

const pad = (s: string, n: number) => s.padStart(n);

// Laporan teks untuk terminal (perintah tournament / scout / hunt).
export function printTournament(run: TournamentRun, out: (s: string) => void = console.log) {
  const r = run.report;
  const q = r.qualification;
  out(`\nTURNAMEN STRATEGI · ${q.tested} kandidat · ${q.universe.length} koin${q.expanded ? ' (diperluas)' : ''} · data ${new Date(r.dataFrom).toISOString().slice(0, 10)} – ${new Date(r.dataTo).toISOString().slice(0, 10)}`);

  out('\nCorong kualifikasi (saringan ' + q.levelLabel + '):');
  for (const f of q.funnel) out(`  ${f.label.padEnd(22)} ${pad(String(f.remaining), 4)}`);
  out(`  Sharpe tahunan yang bisa dicapai juara karena untung-untungan: ${q.expectedMaxSharpe.toFixed(2)}`);
  if (q.level > 0) {
    out(`  Catatan: tidak ada kandidat yang lolos saringan ${GATES.slice(0, q.level).map((g) => g.label).join(' / ')}; dipakai saringan ${q.levelLabel}.`);
  }

  out('\nAturan seleksi (diuji out-of-sample, dipilih ulang tiap minggu):');
  out('  Aturan              OOS      MaxDD   Mgg+');
  for (const x of r.rules) out(`  ${(x.chosen ? '▶ ' : '  ') + x.label.padEnd(18)} ${pad(fmtPct(x.oosReturn), 7)}  ${pad(fmtPct(-x.maxDrawdown), 7)}  ${pad(`${Math.round(x.winRateWeeks * 100)}%`, 4)}`);

  out(`\nPapan skor (${r.lookbackWeeks} minggu terakhir, aturan ${r.chosenRule}):`);
  out('Rank  Lolos  Skor     Return   Mgg-lalu  MaxDD   PSR   DSR   Entri  Strategi');
  r.entries.slice(0, 20).forEach((e, i) => {
    out(
      `${pad(String(i + 1), 4)}  ${e.gate.passed ? '  ya ' : '  -  '}  ${pad(e.score.toFixed(4), 7)}  ${pad(fmtPct(e.stats.totalReturn), 7)}  ${pad(fmtPct(e.stats.lastWeek), 8)}  ${pad(fmtPct(-e.stats.maxDrawdown), 6)}  ${e.gate.psr.toFixed(2)}  ${e.gate.dsr.toFixed(2)}  ${pad(String(e.stats.trades), 5)}  ${e.label}${e.gate.failed ? `  (gagal: ${e.gate.failed})` : ''}`,
    );
  });

  out('\nJuara untuk minggu depan:');
  if (!run.picks.length) out('  (tidak ada — sleeve strategi flat)');
  for (const p of run.picks) out(`  ${pad(`${(p.weight * 100).toFixed(0)}%`, 4)}  ${p.candidate.label}  (skor ${p.score.toFixed(4)})`);
  out(`\nValidasi nested walk-forward (${r.policy.weeks.length} minggu): ${describePolicyEdge(r.policy)}`);
}

export function printScout(leaders: LeaderView[], summary: ScoutSummary | null, out: (s: string) => void = console.log) {
  if (summary) out(`\nSCOUT TRADER · ${summary.leaderboardSize} di leaderboard · ${summary.analyzed} dianalisis dalam ${summary.rounds} putaran · ${summary.qualified} lolos · saringan ${summary.levelLabel}`);
  out('\nStatus     Skor  Bobot  ROI-7h   ROI-30h  WinRate  DD-30h  Pegang  Fill/h  Trader');
  for (const l of leaders.slice(0, 25)) {
    out(
      `${l.status.padEnd(9)}  ${l.score.toFixed(2)}  ${pad(`${(l.weight * 100).toFixed(0)}%`, 5)}  ${pad(fmtPct(l.weekRoi), 7)}  ${pad(fmtPct(l.monthRoi), 7)}  ${l.winRate === null ? '     -' : pad(`${(l.winRate * 100).toFixed(0)}%`, 6)}  ${l.maxDrawdown === null ? '     -' : pad(fmtPct(-l.maxDrawdown), 6)}  ${l.holdHours === null ? '     -' : pad(`${l.holdHours.toFixed(1)}j`, 6)}  ${pad(l.fillsPerDay?.toFixed(0) ?? '-', 6)}  ${l.label} ${l.address}${l.reason ? `\n           ↳ ${l.reason}` : ''}`,
    );
  }
}

// Kesimpulan satu layar: apa yang dipakai minggu ini dan seberapa bisa dipercaya.
export function printVerdict(run: TournamentRun, leaders: LeaderView[] | null, allocStrategy: number, out: (s: string) => void = console.log) {
  const q = run.report.qualification;
  const p = run.report.policy;
  const copying = (leaders ?? []).filter((l) => l.status === 'copying' && l.weight > 0);
  out('\n================ KESIMPULAN ================');
  if (run.picks.length) {
    const top = run.report.entries.find((e) => e.id === run.picks[0].candidate.id);
    out(`Metode minggu ini : ${run.picks.map((x) => `${x.candidate.label} (${Math.round(x.weight * 100)}%)`).join(', ')}`);
    out(`Tingkat bukti     : saringan ${q.levelLabel}${top ? `, PSR ${top.gate.psr.toFixed(2)}, DSR ${top.gate.dsr.toFixed(2)}` : ''}${q.expanded ? ', setelah memperluas koin' : ''}`);
  } else out('Metode minggu ini : tidak ada (sleeve strategi flat)');
  out(`Aturan seleksi    : ${run.report.chosenRule}`);
  out(`Trader disalin    : ${copying.length ? copying.map((l) => `${l.label} (${Math.round(l.weight * 100)}%)`).join(', ') : 'tidak ada yang lolos'}`);
  const alloc = !copying.length ? 1 : !run.picks.length ? 0 : allocStrategy;
  out(`Alokasi modal     : strategi ${Math.round(alloc * 100)}% · copy ${Math.round((1 - alloc) * 100)}%`);
  out(`Uji 26 minggu     : ${fmtPct(p.totalReturn)} vs buy & hold ${run.report.benchmarkCoin} ${fmtPct(p.benchmarkReturn)}`);
  if (q.level >= 2) out('PERINGATAN        : tidak ada kandidat dengan bukti statistik kuat minggu ini; pertimbangkan ukuran posisi lebih kecil.');
  if (p.totalReturn < p.benchmarkReturn) out(`PERINGATAN        : metode rotasi kalah dari buy & hold ${run.report.benchmarkCoin} pada uji out-of-sample.`);
  out('============================================');
}

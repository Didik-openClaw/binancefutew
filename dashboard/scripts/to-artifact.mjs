// Ubah build satu-file Vite menjadi isi halaman Artifact (tanpa <html>/<head>/<body>; kerangka ditambahkan saat publish).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../dist-single/index.html', import.meta.url));
const out = fileURLToPath(new URL('../dist-single/kairos-preview.html', import.meta.url));
const html = readFileSync(src, 'utf8');

const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>Kairos Copy Desk</title>';
const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]);
const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0].replace(/\scrossorigin(="[^"]*")?/, ''));
if (!scripts.length) throw new Error('Tidak ada <script> di build single');

const page = [
  title,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...styles,
  '<div id="root"></div>',
  ...scripts,
].join('\n');
writeFileSync(out, page);
console.log(`Halaman pratinjau: ${out} (${(page.length / 1024).toFixed(0)} KB)`);

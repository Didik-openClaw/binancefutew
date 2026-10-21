import instrument from '@fontsource-variable/instrument-sans/files/instrument-sans-latin-standard-normal.woff2?url';
import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';
import newsreader from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url';
import newsreaderItalic from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2?url';
import marcellus from '@fontsource/marcellus-sc/files/marcellus-sc-latin-400-normal.woff2?url';

// Font dibundel (bukan CDN) supaya dashboard tetap rapi saat offline dan di build satu-file.
// Newsreader: angka & judul (figur lining-tabular). Marcellus SC: huruf ukir, TIDAK untuk angka
// (figurnya oldstyle). Instrument Sans: UI & data (sumbu lebar 75–100%). Geist Mono: alamat & kode.
export const FONTS = {
  display: "'Newsreader', 'Iowan Old Style', Georgia, serif",
  engr: "'Marcellus SC', Optima, Candara, serif",
  ui: "'Instrument Sans', 'Helvetica Neue', Arial, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};

let ready: Promise<void> | null = null;

export function fontsReady() {
  if (ready) return ready;
  const faces = [
    new FontFace('Newsreader', `url(${newsreader}) format('woff2')`, { weight: '200 800', style: 'normal' }),
    new FontFace('Newsreader', `url(${newsreaderItalic}) format('woff2')`, { weight: '200 800', style: 'italic' }),
    new FontFace('Instrument Sans', `url(${instrument}) format('woff2')`, { weight: '400 700', stretch: '75% 100%' }),
    new FontFace('Marcellus SC', `url(${marcellus}) format('woff2')`, { weight: '400' }),
    new FontFace('Geist Mono', `url(${geistMono}) format('woff2')`, { weight: '100 900' }),
  ];
  ready = Promise.all(
    faces.map((f) =>
      f
        .load()
        .then((loaded) => {
          document.fonts.add(loaded);
        })
        .catch(() => undefined),
    ),
  ).then(() => undefined);
  return ready;
}

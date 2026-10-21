import bodoni from '@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-opsz-normal.woff2?url';
import bodoniItalic from '@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-opsz-italic.woff2?url';
import geist from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';

// Font dibundel (bukan CDN) supaya dashboard tetap rapi saat offline dan di build satu-file.
export const FONTS = {
  display: "'Bodoni Moda', 'Bodoni 72', Didot, Georgia, serif",
  ui: "'Geist', 'Helvetica Neue', Arial, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};

let ready: Promise<void> | null = null;

export function fontsReady() {
  if (ready) return ready;
  const faces = [
    new FontFace('Bodoni Moda', `url(${bodoni}) format('woff2')`, { weight: '400 900', style: 'normal' }),
    new FontFace('Bodoni Moda', `url(${bodoniItalic}) format('woff2')`, { weight: '400 900', style: 'italic' }),
    new FontFace('Geist', `url(${geist}) format('woff2')`, { weight: '100 900' }),
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

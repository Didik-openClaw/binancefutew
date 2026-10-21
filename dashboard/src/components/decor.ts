import { useEffect } from 'react';

// Perilaku tampilan bersama untuk semua halaman (dipasang sekali di App):
// - pelat masuk sekali saat terlihat (opasitas + geser 14px; angka di dalamnya tidak dianimasikan),
// - tabel yang bisa digeser di ponsel diberi petunjuk pudar di tepi kanan.
export function useDecor(key: string) {
  useEffect(() => {
    const root = document.querySelector('.main');
    if (!root) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const panels = [...root.querySelectorAll<HTMLElement>('.panel:not(.hero), .profile')];
    const io = reduced
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              e.target.classList.add('in');
              io?.unobserve(e.target);
            }
          },
          { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
        );
    panels.forEach((p, i) => {
      if (!io || p.classList.contains('in')) return;
      const r = p.getBoundingClientRect();
      // Yang sudah terlihat saat halaman dibuka langsung tampil (tanpa kedip kosong).
      if (r.top < innerHeight) return;
      p.classList.add('reveal');
      p.style.setProperty('--i', String(i % 5));
      io.observe(p);
    });
    const wraps = [...root.querySelectorAll<HTMLElement>('.table-wrap')];
    const mark = (el: HTMLElement) => {
      el.classList.toggle('is-overflowing', el.scrollWidth > el.clientWidth + 1);
      el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
    };
    const ro = new ResizeObserver((entries) => entries.forEach((e) => mark(e.target as HTMLElement)));
    const onScroll = (e: Event) => mark(e.currentTarget as HTMLElement);
    wraps.forEach((w) => {
      ro.observe(w);
      w.addEventListener('scroll', onScroll, { passive: true });
    });
    return () => {
      io?.disconnect();
      ro.disconnect();
      wraps.forEach((w) => w.removeEventListener('scroll', onScroll));
    };
  }, [key]);
}

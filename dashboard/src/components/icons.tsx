// Ikon garis tipis buatan sendiri (stroke 1.25) agar senada dengan grafis jam.
const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const IconDial = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 5.5v1.5M18.5 12H17M12 18.5V17M5.5 12H7M12 12l3.5-2" />
  </svg>
);

export const IconRidges = () => (
  <svg {...base}>
    <path d="M3 18c3-1 4-6 6-6s3 3 5 3 3-6 7-8" />
    <path d="M3 21h18" />
  </svg>
);

export const IconPeople = () => (
  <svg {...base}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
    <path d="M15.5 6a3 3 0 0 1 0 5.6M17.5 14.8c1.6.6 2.6 1.9 3 4.2" />
  </svg>
);

export const IconLedger = () => (
  <svg {...base}>
    <rect x="5" y="3.5" width="14" height="17" rx="1" />
    <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
  </svg>
);

export const IconShield = () => (
  <svg {...base}>
    <path d="M12 3.5l7 2.5v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-2.5z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const IconExternal = () => (
  <svg {...base} width={12} height={12}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

export const IconSeal = () => (
  <svg {...base}>
    <circle cx="12" cy="10" r="6" />
    <path d="M9.5 10l1.7 1.7L14.8 8.2" />
    <path d="M8.5 15l-1.5 5.5L12 18l5 2.5L15.5 15" />
  </svg>
);

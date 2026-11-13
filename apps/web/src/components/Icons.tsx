/** Inline stroke icons (24px grid). Decorative unless given a title by the caller's label. */

import type { ReactElement } from 'react';

const paths: Record<string, ReactElement> = {
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </>
  ),
  chart: <path d="M4 19h16M5 15l4-5 4 3 6-7" />,
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3 4v4h4M12 7.5V12l3 2" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5L12 4l8 6.5V20H4z" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  chat: <path d="M5 5h14v10H10l-4 4v-4H5z" />,
  minus: <path d="M6 12h12" />,
  plus: <path d="M12 6v12M6 12h12" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  send: <path d="M4 12l16-8-6 16-2.5-6.5z" />,
  play: <path d="M7 5v14l12-7z" />,
  forward: <path d="M5 6l7 6-7 6zM13 6l7 6-7 6z" />,
  sunrise: (
    <>
      <path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 4v4M5 9l1.5 1.5M19 9l-1.5 1.5M9.5 6.5L12 4l2.5 2.5" />
    </>
  ),
  thermo: (
    <>
      <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />
      <path d="M12 10v6" />
    </>
  ),
  fan: (
    <>
      <circle cx="12" cy="12" r="1.8" />
      <path d="M12 10.2C11 6 12.5 3.5 15 4s2 4-3 6.2zM13.8 12c4.2-1 6.7.5 6.2 3s-4 2-6.2-3zM12 13.8c1 4.2-.5 6.7-3 6.2s-2-4 3-6.2zM10.2 12C6 13 3.5 11.5 4 9s4-2 6.2 3z" />
    </>
  ),
  drop: <path d="M12 3.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  dropOff: (
    <>
      <path d="M12 3.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
      <path d="M4 4l16 16" />
    </>
  ),
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  heart: <path d="M12 20s-7.5-4.5-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.5-7.5 10-7.5 10z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.8a3 3 0 0 1 0 5.4M17 14a5.5 5.5 0 0 1 3.5 5" />
    </>
  ),
  hand: <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L3.5 14a1.5 1.5 0 0 1 2.5-1.7L8 15" />,
  resume: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
    </>
  ),
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plane: <path d="M10.5 13.5L3 11l1.5-1.5 7 1L16 6a2 2 0 0 1 3 3l-4.5 4.5 1 7L14 22l-2.5-7.5L8 18v2.5L6.5 22 5 18.5 1.5 17 3 15.5h2.5z" />,
  bed: <path d="M3 18V7M3 13h18v5M21 13a3 3 0 0 0-3-3h-7v3M7 11.5a1.5 1.5 0 1 0 0-.01" />,
  glass: <path d="M7 3h10l-1 8a4 4 0 0 1-8 0zM12 15v5M8.5 20.5h7" />,
  dumbbell: <path d="M6 8v8M3.5 10v4M18 8v8M20.5 10v4M6 12h12" />,
  sick: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 15.5c1-1 2.2-1.5 3.5-1.5s2.5.5 3.5 1.5M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  curve: <path d="M3 8c3 0 3 8 6 8s3-10 6-10 3 6 6 6" />,
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  trash: <path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 13h9l1-13" />,
  flask: <path d="M9.5 3h5M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" />,
  snow: <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 6.5l2.5-2M9.5 19.5l2.5-2 2.5 2" />,
  leaf: <path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l7-7" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}

/** The product mark: a crescent over a thermostat dial. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--btn-bg)" />
      <path d="M20.5 8.5a8.5 8.5 0 1 0 3.5 13.2A7 7 0 0 1 20.5 8.5z" fill="var(--btn-text)" />
      <circle cx="21.5" cy="12.5" r="1.4" fill="var(--btn-text)" />
    </svg>
  );
}

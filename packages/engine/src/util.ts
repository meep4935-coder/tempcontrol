import type { Rng } from './types';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Round to the nearest multiple of `step` (thermostats usually accept 0.5 degree steps). */
export const roundTo = (v: number, step: number): number => Math.round(v / step) * step;

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Small, fast, seedable generator (mulberry32) so simulations and tests are reproducible. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box-Muller). */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Poisson draw (Knuth); fine for the small rates used here. */
export function poisson(rng: Rng, lambda: number): number {
  const limit = Math.exp(-Math.max(0, lambda));
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit && k < 200);
  return k - 1;
}

/** Stable string hash, used to derive per-entity seeds. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
  /** YYYY-MM-DD in the zone. */
  date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock fields of an instant in an IANA time zone. */
export function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? 'Sun'),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * The instant at which a zone's wall clock shows `date` `time` ("YYYY-MM-DD", "HH:MM").
 * Around a daylight-saving change the nearest valid instant is returned.
 */
export function zonedTimeToMs(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wanted = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wanted - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function parseClock(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;

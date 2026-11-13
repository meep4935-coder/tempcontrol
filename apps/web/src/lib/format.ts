/** Display formatting at the edge: temperatures, clock times and dates in the viewer's language and units. */

import type { Locale, Units } from '@tempcontrol/contracts';
import { cToF, formatDelta, formatTemp, fToC } from '@tempcontrol/engine';
import { frenchSpacing } from './i18n';

export interface Formatter {
  locale: Locale;
  units: Units;
  timeZone: string;
  /** "18.5 °C" / "18,5 °C" / "65 °F" */
  temp: (c: number) => string;
  /** Unsigned difference: "0.5 °C" / "1 °F". */
  delta: (c: number) => string;
  /** Signed difference with a true minus: "+0.5 °C" / "−1 °F". */
  signed: (c: number) => string;
  /** Celsius to the display scale (number). */
  toDisplay: (c: number) => number;
  /** Display scale back to Celsius. */
  fromDisplay: (v: number) => number;
  /** A number in the viewer's locale. */
  num: (v: number, digits?: number) => string;
  pct: (fraction: number) => string;
  money: (cents: number) => string;
  /** Clock time of an instant in the household's time zone. */
  clock: (ms: number) => string;
  /** Short hour label for axes: "10 p.m." / "22 h". */
  hour: (ms: number) => string;
  /** "HH:MM" wall-clock string in the viewer's style. */
  wall: (hhmm: string) => string;
  /** Calendar date "YYYY-MM-DD": long ("Friday, November 13"). */
  dateLong: (date: string) => string;
  /** Calendar date: short ("Nov 13"). */
  dateShort: (date: string) => string;
  /** Calendar date with weekday, compact ("Fri, Nov 13"). */
  dateMedium: (date: string) => string;
  /** Text with French spacing applied when needed. */
  text: (s: string) => string;
}

const tag = (locale: Locale): string => (locale === 'fr' ? 'fr-CA' : 'en-CA');

export function makeFormatter(locale: Locale, units: Units, timeZone: string): Formatter {
  const lt = tag(locale);
  const opts = { locale, units };
  const clockFmt = new Intl.DateTimeFormat(lt, { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: locale === 'fr' ? 'h23' : 'h12' });
  const hourFmt = new Intl.DateTimeFormat(lt, { timeZone, hour: 'numeric', hourCycle: locale === 'fr' ? 'h23' : 'h12' });
  const utcWall = new Intl.DateTimeFormat(lt, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hourCycle: locale === 'fr' ? 'h23' : 'h12' });
  const longFmt = new Intl.DateTimeFormat(lt, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const shortFmt = new Intl.DateTimeFormat(lt, { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const mediumFmt = new Intl.DateTimeFormat(lt, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const moneyFmt = new Intl.NumberFormat(lt, { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateOf = (d: string): Date => new Date(`${d}T12:00:00Z`);
  const text = (s: string): string => (locale === 'fr' ? frenchSpacing(s) : s);
  const minus = '−';

  return {
    locale,
    units,
    timeZone,
    temp: (c) => formatTemp(c, opts),
    delta: (c) => formatDelta(c, opts),
    signed: (c) => {
      const body = formatDelta(c, opts);
      if (Math.abs(c) < 0.05) return body;
      return `${c > 0 ? '+' : minus}${body}`;
    },
    toDisplay: (c) => (units === 'F' ? cToF(c) : c),
    fromDisplay: (v) => (units === 'F' ? fToC(v) : v),
    num: (v, digits = 1) => new Intl.NumberFormat(lt, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v).replace('-', minus),
    pct: (fraction) => new Intl.NumberFormat(lt, { style: 'percent', maximumFractionDigits: 0 }).format(fraction),
    money: (cents) => moneyFmt.format(cents / 100).replace('-', minus),
    clock: (ms) => clockFmt.format(new Date(ms)),
    hour: (ms) => (locale === 'fr' ? `${hourFmt.format(new Date(ms)).replace(/\D+$/, '')} h` : hourFmt.format(new Date(ms))),
    wall: (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return utcWall.format(new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)));
    },
    dateLong: (d) => longFmt.format(dateOf(d)),
    dateShort: (d) => shortFmt.format(dateOf(d)),
    dateMedium: (d) => mediumFmt.format(dateOf(d)),
    text,
  };
}

/** Round a Celsius value to the half degree the server settles on. */
export const halfDegree = (c: number): number => Math.round(c * 2) / 2;

/** Step a Celsius target by one display step (half a degree C, or one degree F). */
export function stepTarget(c: number, units: Units, dir: 1 | -1): number {
  if (units === 'F') {
    const f = Math.round(cToF(c)) + dir;
    return Math.round(fToC(f) * 10) / 10;
  }
  return halfDegree(c) + dir * 0.5;
}

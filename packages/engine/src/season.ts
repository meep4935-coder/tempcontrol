import { clamp } from './util';

/** Day of the year (1-366) for a YYYY-MM-DD date. */
export function dayOfYear(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(y!, 0, 0)) / 86_400_000);
}

/**
 * Where a date sits in the year for a given latitude:
 * +1 at midwinter, 0 in spring and autumn, -1 at midsummer.
 *
 * The coldest stretch lags the winter solstice by about a month, so the curve
 * peaks around 20 January in the northern hemisphere (20 July in the southern).
 * Near the equator the seasons flatten, so the amplitude fades below 30 degrees.
 */
export function calendarSeasonIndex(date: string, latitude: number): number {
  const north = Math.cos((2 * Math.PI * (dayOfYear(date) - 20)) / 365.25);
  const hemisphere = latitude >= 0 ? 1 : -1;
  const amplitude = clamp(Math.abs(latitude) / 30, 0, 1);
  return hemisphere * north * amplitude;
}

/** The same -1..+1 scale read from the outdoor overnight temperature instead of the calendar. */
export function weatherSeasonIndex(outdoorC: number): number {
  return clamp((7.5 - outdoorC) / 12.5, -1, 1);
}

/**
 * Season index used by the engine. The calendar gives the stable trend; when the
 * outdoor temperature is known it pulls the index toward what the weather is
 * actually doing (a cold snap in April counts as wintry).
 */
export function seasonIndex(date: string, latitude: number, outdoorC?: number): number {
  const calendar = calendarSeasonIndex(date, latitude);
  if (outdoorC === undefined || !Number.isFinite(outdoorC)) return calendar;
  return clamp(0.6 * calendar + 0.4 * weatherSeasonIndex(outdoorC), -1, 1);
}

export type SeasonName = 'winter' | 'spring' | 'summer' | 'autumn';

export function seasonName(date: string, latitude: number): SeasonName {
  const idx = calendarSeasonIndex(date, latitude);
  if (idx > 0.5) return 'winter';
  if (idx < -0.5) return 'summer';
  // Between the extremes, the direction of travel tells spring from autumn.
  const [y, m, d] = date.split('-').map(Number);
  const later = new Date(Date.UTC(y!, m! - 1, d! + 14)).toISOString().slice(0, 10);
  return calendarSeasonIndex(later, latitude) < idx ? 'spring' : 'autumn';
}

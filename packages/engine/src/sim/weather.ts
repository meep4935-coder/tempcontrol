/**
 * Simulated weather for the demo and tests. Stateless: the same seed and date
 * always give the same night, whatever order nights are simulated in.
 */

import { calendarSeasonIndex } from '../season';
import { addDays, gaussian, hashString, seededRng } from '../util';

export interface Climate {
  id: string;
  name: string;
  latitude: number;
  timeZone: string;
  /** Province or territory code. */
  region: string;
  /** Mean temperature over the year and half the summer-winter swing, in degrees C. */
  meanAnnualC: number;
  seasonalAmplitudeC: number;
  /** How far the overnight low sits below the daily mean. */
  overnightDropC: number;
}

/** Rounded climate normals for a few Canadian cities. */
export const CLIMATES: Record<string, Climate> = {
  montreal: { id: 'montreal', name: 'Montréal', latitude: 45.5, timeZone: 'America/Toronto', region: 'QC', meanAnnualC: 6.8, seasonalAmplitudeC: 15.5, overnightDropC: 4.5 },
  toronto: { id: 'toronto', name: 'Toronto', latitude: 43.7, timeZone: 'America/Toronto', region: 'ON', meanAnnualC: 9.4, seasonalAmplitudeC: 13, overnightDropC: 4 },
  ottawa: { id: 'ottawa', name: 'Ottawa', latitude: 45.4, timeZone: 'America/Toronto', region: 'ON', meanAnnualC: 6.6, seasonalAmplitudeC: 15.5, overnightDropC: 5 },
  vancouver: { id: 'vancouver', name: 'Vancouver', latitude: 49.3, timeZone: 'America/Vancouver', region: 'BC', meanAnnualC: 11, seasonalAmplitudeC: 7, overnightDropC: 3.5 },
  calgary: { id: 'calgary', name: 'Calgary', latitude: 51, timeZone: 'America/Edmonton', region: 'AB', meanAnnualC: 4.4, seasonalAmplitudeC: 12, overnightDropC: 6 },
  halifax: { id: 'halifax', name: 'Halifax', latitude: 44.6, timeZone: 'America/Halifax', region: 'NS', meanAnnualC: 7.5, seasonalAmplitudeC: 11.5, overnightDropC: 4 },
};

const dayNoise = (seed: number, date: string, salt: string): number => gaussian(seededRng(hashString(`${seed}:${salt}:${date}`)));

/** Weather that drifts over a few days instead of jumping independently each night. */
function smoothNoise(seed: number, date: string, salt: string): number {
  const a = dayNoise(seed, date, salt);
  const b = dayNoise(seed, addDays(date, -1), salt);
  const c = dayNoise(seed, addDays(date, -2), salt);
  return (0.6 * a + 0.3 * b + 0.1 * c) / Math.sqrt(0.36 + 0.09 + 0.01);
}

/** Mean outdoor temperature over the night that starts on the evening of `date`. */
export function overnightOutdoorC(date: string, climate: Climate, seed: number): number {
  const seasonal = climate.meanAnnualC - climate.seasonalAmplitudeC * calendarSeasonIndex(date, climate.latitude);
  return seasonal - climate.overnightDropC + 3.5 * smoothNoise(seed, date, 'temp');
}

/** Outdoor temperature at a point in the night: it keeps falling until shortly before dawn. */
export function outdoorAtC(overnightMeanC: number, fractionOfNight: number): number {
  return overnightMeanC + 1.5 - 3 * Math.min(1, Math.max(0, fractionOfNight));
}


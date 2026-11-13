/**
 * Travel support.
 *
 * A sleeper's model belongs to the person, not the room, so it follows them to
 * a hotel or cottage. What changes on a trip is the clock: this module lays out
 * a gradual shift of bedtime and wake time across time zones. The night plans
 * simply follow the shifted times, so the evening cool-down and the morning
 * warm-up arrive when the traveller's body is being asked to sleep and wake.
 *
 * Temperature is a supporting cue for the body clock; light exposure matters
 * more. The schedule is guidance, not treatment.
 */

import { addDays, formatClock, parseClock } from './util';

export interface JetLagInput {
  /** Usual bedtime and wake time, "HH:MM". */
  bedtime: string;
  wakeTime: string;
  /** Destination clock minus home clock, in hours. Positive means travelling east. */
  shiftHours: number;
  /** Date of the first night at the destination, YYYY-MM-DD. */
  arrivalDate: string;
  /** Nights before departure to start shifting (0-5). */
  prepareNights?: number;
}

export interface JetLagNight {
  date: string;
  where: 'home' | 'destination';
  /** In the local clock of `where`. */
  bedtime: string;
  wakeTime: string;
  /** Minutes this night differs from the usual schedule on that clock (negative = earlier). */
  offsetMin: number;
  /** Hours of mismatch left between body clock and destination clock after this night. */
  remainingHours: number;
}

/** Comfortable daily shift before leaving, and what the body manages once there. */
const PREPARE_STEP_MIN = { east: 45, west: 60 };
const ADAPT_STEP_MIN = { east: 60, west: 90 };
/** Largest departure from the local schedule asked for on any one night. */
const MAX_LOCAL_OFFSET_MIN = 120;

export function jetLagSchedule(input: JetLagInput): JetLagNight[] {
  const bed = parseClock(input.bedtime);
  const wake = parseClock(input.wakeTime);
  const shift = Math.max(-12, Math.min(12, input.shiftHours));
  const totalMin = Math.round(Math.abs(shift) * 60);
  if (totalMin === 0) return [];
  const direction = shift > 0 ? 'east' : 'west';
  // Travelling east the body must fall asleep earlier; west, later.
  const sign = shift > 0 ? -1 : 1;
  const prepareNights = Math.max(0, Math.min(5, Math.round(input.prepareNights ?? 3)));

  const nights: JetLagNight[] = [];
  let shifted = 0;

  for (let n = prepareNights; n >= 1; n--) {
    shifted = Math.min(totalMin, shifted + PREPARE_STEP_MIN[direction]);
    nights.push({
      date: addDays(input.arrivalDate, -n),
      where: 'home',
      bedtime: formatClock(bed + sign * shifted),
      wakeTime: formatClock(wake + sign * shifted),
      offsetMin: sign * shifted,
      remainingHours: (totalMin - shifted) / 60,
    });
  }

  // At the destination the body clock still lags; meet it part-way and close the gap nightly.
  for (let n = 0; n < 14 && shifted < totalMin; n++) {
    const lag = totalMin - shifted;
    const offset = -sign * Math.min(lag, MAX_LOCAL_OFFSET_MIN);
    shifted = Math.min(totalMin, shifted + ADAPT_STEP_MIN[direction]);
    nights.push({
      date: addDays(input.arrivalDate, n),
      where: 'destination',
      bedtime: formatClock(bed + offset),
      wakeTime: formatClock(wake + offset),
      offsetMin: offset,
      remainingHours: (totalMin - shifted) / 60,
    });
  }
  return nights;
}

/**
 * Tonight-specific adjustments layered on top of the learned ideal temperature.
 *
 * These are deliberately simple, transparent rules. Each one produces a named
 * modifier so the app can tell the user exactly why tonight differs from last
 * night. The learned model works in a "neutral context": before a night is
 * used for learning, these adjustments are subtracted back out.
 *
 * The sizes below are starting assumptions drawn from general sleep-physiology
 * guidance. They are not medical advice and the platform is not a medical device.
 */

import type { CyclePhase, Phase, SleeperOptions } from './types';
import { clamp } from './util';

export type ModifierId = 'cycle' | 'menopause' | 'strain' | 'alcohol' | 'illness' | 'humidity';

export interface Modifier {
  id: ModifierId;
  deltaC: number;
  /** Phases the adjustment applies to. */
  phases: readonly Phase[];
  /** Values the app can show in its explanation (for example the humidity reading). */
  detail?: Record<string, number | string>;
}

export interface RecoverySignals {
  /** Hard training day, or a workout that ended close to bedtime. */
  highStrain?: boolean;
  alcohol?: boolean;
  /** Signs of illness or fever. */
  illness?: boolean;
}

export interface NightContext {
  cyclePhase?: CyclePhase;
  recovery?: RecoverySignals;
  /** Bedroom relative humidity, percent. */
  humidityPct?: number;
}

const ALL_PHASES: readonly Phase[] = ['windDown', 'onset', 'deep', 'rem', 'wake'];
const FIRST_HALF: readonly Phase[] = ['windDown', 'onset', 'deep'];
const ASLEEP: readonly Phase[] = ['windDown', 'onset', 'deep', 'rem'];

/** Total adjustment is kept inside this band however many modifiers stack up. */
export const MODIFIER_RANGE: readonly [number, number] = [-1.5, 1.0];

/** Bedroom humidity is most comfortable for sleep in roughly this band. */
export const HUMIDITY_COMFORT: readonly [number, number] = [30, 55];

export function contextModifiers(ctx: NightContext, options: SleeperOptions): Modifier[] {
  const mods: Modifier[] = [];

  if (options.cycleTracking && ctx.cyclePhase === 'luteal') {
    // Body temperature runs a few tenths of a degree higher after ovulation.
    mods.push({ id: 'cycle', deltaC: -0.5, phases: ASLEEP, detail: { phase: 'luteal' } });
  }

  if (options.menopauseMode) {
    mods.push({ id: 'menopause', deltaC: -0.5, phases: ASLEEP });
  }

  const recovery = options.recoveryAware ? ctx.recovery : undefined;
  if (recovery?.illness) {
    // Comfort first: a little warmer, and no other recovery cooling on top.
    mods.push({ id: 'illness', deltaC: 0.5, phases: ALL_PHASES });
  } else if (recovery) {
    if (recovery.highStrain) {
      // The body is still shedding heat for hours after hard exercise.
      mods.push({ id: 'strain', deltaC: -0.5, phases: FIRST_HALF });
    }
    if (recovery.alcohol) {
      mods.push({ id: 'alcohol', deltaC: -0.5, phases: ASLEEP });
    }
  }

  if (ctx.humidityPct !== undefined && Number.isFinite(ctx.humidityPct)) {
    // Humid air slows the body's own cooling, so the same reading feels warmer.
    const delta = -Math.round(clamp((ctx.humidityPct - 55) / 20, 0, 1) * 2) / 2;
    if (delta !== 0) {
      mods.push({ id: 'humidity', deltaC: delta, phases: ASLEEP, detail: { humidityPct: Math.round(ctx.humidityPct) } });
    }
  }

  return mods;
}

/** Combined adjustment for one phase. */
export function modifierDelta(mods: readonly Modifier[], phase: Phase): number {
  const sum = mods.filter((m) => m.phases.includes(phase)).reduce((total, m) => total + m.deltaC, 0);
  return clamp(sum, MODIFIER_RANGE[0], MODIFIER_RANGE[1]);
}

/** Nights when something other than temperature dominated sleep teach the model nothing reliable. */
export function isConfoundedNight(ctx: NightContext): boolean {
  return Boolean(ctx.recovery?.illness || ctx.recovery?.alcohol);
}

/** Cycle phase from the first day of the last period. */
export function cyclePhaseOn(date: string, lastPeriodStart: string, cycleLengthDays = 28): CyclePhase {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${lastPeriodStart}T00:00:00Z`)) / 86_400_000);
  const length = clamp(Math.round(cycleLengthDays), 21, 40);
  const day = ((days % length) + length) % length; // 0-based day of cycle
  const ovulation = length - 14; // the luteal phase is close to 14 days whatever the cycle length
  if (day < 5) return 'menstrual';
  if (day < ovulation - 1) return 'follicular';
  if (day <= ovulation + 1) return 'ovulatory';
  return 'luteal';
}

export interface DailyReadings {
  /** Day strain on a 0..21 scale (Whoop-style); other vendors are mapped onto it by their adapter. */
  strain?: number;
  /** Minutes between the end of the last workout and bedtime. */
  workoutEndedMinBeforeBed?: number;
  skinTempDeviationC?: number;
  restingHrDeltaBpm?: number;
  /** Self-reported (journal entry or a tap in the app). */
  alcohol?: boolean;
}

/** Turn a wearable's daily readings into the recovery flags used above. */
export function deriveRecovery(d: DailyReadings): RecoverySignals {
  const lateWorkout = d.workoutEndedMinBeforeBed !== undefined && d.workoutEndedMinBeforeBed < 180;
  return {
    highStrain: (d.strain !== undefined && d.strain >= 15) || lateWorkout,
    alcohol: Boolean(d.alcohol),
    illness:
      d.skinTempDeviationC !== undefined &&
      d.skinTempDeviationC >= 0.8 &&
      d.restingHrDeltaBpm !== undefined &&
      d.restingHrDeltaBpm >= 5,
  };
}

export type HumidityAdvice = 'humidify' | 'dehumidify' | 'ok';

/** What to do about bedroom humidity, and the level a humidifier or dehumidifier should aim for. */
export function humidityAdvice(humidityPct: number | undefined): { advice: HumidityAdvice; targetPct?: number } {
  if (humidityPct === undefined || !Number.isFinite(humidityPct)) return { advice: 'ok' };
  if (humidityPct < HUMIDITY_COMFORT[0]) return { advice: 'humidify', targetPct: 40 };
  if (humidityPct > HUMIDITY_COMFORT[1]) return { advice: 'dehumidify', targetPct: 50 };
  return { advice: 'ok' };
}

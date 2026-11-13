/**
 * End-of-night learning: turn what happened into evidence for one sleeper's model.
 */

import { isConfoundedNight, modifierDelta, type NightContext } from './context';
import { observeNight, observePreference, phaseOffset, type ThermalModelState } from './model';
import { phaseAt, type NightPlan } from './plan';
import { scoreNight, type QualityScore } from './quality';
import type { FeedbackKind, NightMetrics, Phase } from './types';

export interface TempSample {
  t: number;
  roomTempC: number;
  /** Speed (0-3) of this sleeper's personal fan at the time, if they have one. */
  fanLevel?: number;
}

/**
 * How much cooler moving air makes a room feel, per fan speed step. A working
 * assumption: with a fan running, the same room is experienced as cooler, and
 * learning has to account for that or it would conclude the person likes a
 * warmer room than they do.
 */
export const FAN_COOLING_PER_LEVEL_C = 0.6;

export interface PreferenceEvent {
  kind: 'override' | FeedbackKind;
  /**
   * When it happened. Omit for whole-night feedback given the next morning,
   * which is read against the night's average.
   */
  t?: number;
  /** The temperature asked for (override) or reacted to (feedback at a moment). */
  tempC?: number;
  /** Noise level in degrees for inferred signals; omit for things the person said or did. */
  noiseC?: number;
}

/** Trust placed in a comfort signal inferred from the body rather than stated by the person. */
export const INFERRED_SIGNAL_NOISE_C = 1.25;

export interface NightEvidence {
  /** This sleeper's own plan for the night (their phases, season and context adjustments). */
  plan: NightPlan;
  /** Room temperature through the night, from the thermostat or a bedroom sensor. */
  samples: readonly TempSample[];
  /** What the wearable reported; null if it has not synced. */
  metrics: NightMetrics | null;
  context: NightContext;
  preferences: readonly PreferenceEvent[];
}

export interface NightLearning {
  model: ThermalModelState;
  /**
   * The temperature this sleeper effectively slept at, expressed as a
   * deep-sleep temperature in a neutral context: measured room temperature
   * (less the cooling effect of their fan, if it ran) with the phase offsets
   * and tonight's context adjustments removed.
   */
  experiencedCoreC: number | null;
  quality: QualityScore | null;
  /** Whether the night's outcome was used (it is skipped on confounded nights). */
  outcomeUsed: boolean;
  preferencesUsed: number;
}

const ASLEEP: readonly Phase[] = ['onset', 'deep', 'rem'];

export function experiencedCoreC(model: ThermalModelState, plan: NightPlan, samples: readonly TempSample[]): number | null {
  let sum = 0;
  let n = 0;
  for (const sample of samples) {
    if (sample.t < plan.bedtimeMs || sample.t >= plan.wakeMs) continue;
    const phase = phaseAt(plan, sample.t);
    if (!phase || !ASLEEP.includes(phase)) continue;
    const felt = sample.roomTempC - FAN_COOLING_PER_LEVEL_C * (sample.fanLevel ?? 0);
    sum += felt - phaseOffset(model, phase, plan.seasonIndex) - modifierDelta(plan.modifiers, phase);
    n++;
  }
  return n === 0 ? null : sum / n;
}

export function learnFromNight(model: ThermalModelState, evidence: NightEvidence): NightLearning {
  const { plan } = evidence;
  const s = plan.seasonIndex;
  const experienced = experiencedCoreC(model, plan, evidence.samples);
  const quality = evidence.metrics ? scoreNight(evidence.metrics) : null;

  let next = model;
  let outcomeUsed = false;
  if (experienced !== null && quality && !isConfoundedNight(evidence.context)) {
    next = observeNight(next, { experiencedCoreC: experienced, seasonIndex: s, quality: quality.thermal });
    outcomeUsed = true;
  }

  let preferencesUsed = 0;
  for (const pref of evidence.preferences) {
    if (pref.t !== undefined && pref.tempC !== undefined) {
      const phase = phaseAt(plan, pref.t) ?? 'deep';
      next = observePreference(next, {
        kind: pref.kind,
        tempC: pref.tempC - modifierDelta(plan.modifiers, phase),
        phase,
        seasonIndex: s,
        noiseC: pref.noiseC,
      });
      preferencesUsed++;
    } else if (experienced !== null && pref.kind !== 'override') {
      next = observePreference(next, { kind: pref.kind, tempC: experienced, phase: 'deep', seasonIndex: s, noiseC: pref.noiseC });
      preferencesUsed++;
    }
  }

  return { model: next, experiencedCoreC: experienced, quality, outcomeUsed, preferencesUsed };
}

/**
 * How quickly a room actually responds, learned from its temperature trace,
 * so the wind-down and wake-up can start early enough to arrive on time.
 */
export interface RoomResponse {
  /** Degrees per hour while warming toward a higher setpoint. */
  heatRateCPerHour?: number;
  /** Degrees per hour while cooling toward a lower setpoint. */
  coolRateCPerHour?: number;
}

export function updateRoomResponse(
  prev: RoomResponse,
  samples: readonly (TempSample & { setpointC: number | null })[],
): RoomResponse {
  const rates = { heat: [] as number[], cool: [] as number[] };
  let start: (TempSample & { setpointC: number | null }) | null = null;
  let direction: 'heat' | 'cool' | null = null;

  const close = (end: TempSample): void => {
    if (!start || !direction) return;
    const hours = (end.t - start.t) / 3_600_000;
    const moved = Math.abs(end.roomTempC - start.roomTempC);
    if (hours >= 1 / 6 && moved >= 0.4) rates[direction].push(moved / hours);
    start = null;
    direction = null;
  };

  let previous: (TempSample & { setpointC: number | null }) | null = null;
  for (const sample of samples) {
    if (sample.setpointC === null) {
      if (previous) close(previous);
      previous = sample;
      continue;
    }
    const gap = sample.setpointC - sample.roomTempC;
    const wanted: 'heat' | 'cool' | null = gap >= 0.4 ? 'heat' : gap <= -0.4 ? 'cool' : null;
    if (wanted !== direction) {
      if (previous) close(previous);
      if (wanted) {
        start = sample;
        direction = wanted;
      }
    }
    previous = sample;
  }
  if (previous) close(previous);

  const blend = (old: number | undefined, fresh: number[]): number | undefined => {
    if (fresh.length === 0) return old;
    const observed = fresh.reduce((a, b) => a + b, 0) / fresh.length;
    return old === undefined ? observed : 0.7 * old + 0.3 * observed;
  };
  return {
    heatRateCPerHour: blend(prev.heatRateCPerHour, rates.heat),
    coolRateCPerHour: blend(prev.coolRateCPerHour, rates.cool),
  };
}

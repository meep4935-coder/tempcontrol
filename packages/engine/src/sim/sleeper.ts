/**
 * A simulated sleeper with a hidden "true" temperature preference, used by the
 * demo and tests in place of a real person and their wearable.
 *
 * The engine never sees the truth below. It only sees what a wearable would
 * report (nightly metrics, and live readings if the device offers them), plus
 * the occasional override or piece of feedback. Whether the engine's estimate
 * converges on the hidden truth is the test of the algorithm.
 *
 * The response of sleep to temperature here is a plausible stand-in, not a
 * physiological model.
 */

import type { NightContext } from '../context';
import type { FeedbackKind, LiveVitals, NightMetrics, Phase, Rng } from '../types';
import { clamp, gaussian, MIN, poisson, roundTo } from '../util';

export interface SleeperTruth {
  /** True ideal deep-sleep temperature in a neutral context, mid-season. */
  idealCoreC: number;
  /** How sharply sleep degrades away from the ideal (1 = typical). */
  sensitivity: number;
  /** Extra warmth wanted at midwinter relative to mid-season. */
  seasonShiftC: number;
  /** True preferred offsets from the core temperature. */
  phaseOffsets: { onset: number; rem: number; wake: number };
  /** Extra wake-up warmth wanted at midwinter. */
  winterWakeBoostC: number;
  /** How this person really responds to things the engine only has rules of thumb for. */
  lutealShiftC: number;
  strainShiftC: number;
  alcoholShiftC: number;
  /** Degrees cooler wanted when humidity is 20 points above comfortable. */
  humidityShiftC: number;
  baseline: {
    efficiency: number;
    awakenings: number;
    restlessness: number;
    deepShare: number;
    remShare: number;
    hrvMs: number;
    restingHr: number;
    latencyMin: number;
  };
  /** Night-to-night scatter unrelated to temperature (1 = typical). */
  noise: number;
  /** Chance of leaving feedback in the morning after an uncomfortable night. */
  feedbackRate: number;
  /** Chance of getting up to change the thermostat when very uncomfortable. */
  overrideRate: number;
  hotFlashesPerNight: number;
}

export const DEFAULT_TRUTH: SleeperTruth = {
  idealCoreC: 18.5,
  sensitivity: 1,
  seasonShiftC: 0,
  phaseOffsets: { onset: 0.5, rem: 0.5, wake: 1 },
  winterWakeBoostC: 1.5,
  lutealShiftC: -0.4,
  strainShiftC: -0.4,
  alcoholShiftC: -0.5,
  humidityShiftC: -0.8,
  baseline: { efficiency: 0.91, awakenings: 1.5, restlessness: 0.09, deepShare: 0.2, remShare: 0.23, hrvMs: 55, restingHr: 56, latencyMin: 12 },
  noise: 1.5,
  feedbackRate: 0.5,
  overrideRate: 0.35,
  hotFlashesPerNight: 0,
};

export interface TruthContext extends NightContext {
  seasonIndex: number;
}

/** What this person would really want the room to be at this moment. */
export function trueIdealC(truth: SleeperTruth, phase: Phase, ctx: TruthContext): number {
  const s = ctx.seasonIndex;
  let t = truth.idealCoreC + truth.seasonShiftC * s;
  if (phase === 'onset' || phase === 'windDown') t += truth.phaseOffsets.onset;
  else if (phase === 'rem') t += truth.phaseOffsets.rem;
  else if (phase === 'wake') t += truth.phaseOffsets.wake + truth.winterWakeBoostC * Math.max(0, s);

  if (phase !== 'wake') {
    if (ctx.cyclePhase === 'luteal') t += truth.lutealShiftC;
    if (ctx.recovery?.alcohol) t += truth.alcoholShiftC;
    if (ctx.recovery?.highStrain && phase !== 'rem') t += truth.strainShiftC;
    if (ctx.humidityPct !== undefined) t += truth.humidityShiftC * clamp((ctx.humidityPct - 55) / 20, 0, 1);
  }
  if (ctx.recovery?.illness) t += 0.5;
  return t;
}

export interface SleeperNightState {
  ticks: number;
  sumSquared: number;
  sumSigned: number;
  onsetSquared: number;
  onsetTicks: number;
  extraAwakenings: number;
  /** Times at which a hot flash begins. */
  flashes: number[];
  uncomfortableSinceMs: number | null;
  overrideUsed: boolean;
  willOverride: boolean;
}

const FLASH_MS = 15 * MIN;

export function startSleeperNight(truth: SleeperTruth, bedtimeMs: number, wakeMs: number, rng: Rng): SleeperNightState {
  const flashes: number[] = [];
  const count = truth.hotFlashesPerNight > 0 ? poisson(rng, truth.hotFlashesPerNight) : 0;
  for (let i = 0; i < count; i++) flashes.push(bedtimeMs + (0.1 + 0.75 * rng()) * (wakeMs - bedtimeMs));
  return {
    ticks: 0,
    sumSquared: 0,
    sumSigned: 0,
    onsetSquared: 0,
    onsetTicks: 0,
    extraAwakenings: 0,
    flashes: flashes.sort((a, b) => a - b),
    uncomfortableSinceMs: null,
    overrideUsed: false,
    willOverride: rng() < truth.overrideRate,
  };
}

export interface SleeperTick {
  state: SleeperNightState;
  /** What a live-capable wearable would report right now. */
  vitals: LiveVitals;
  /** Degrees warmer (+) or cooler (-) than this person wants at this moment. */
  discomfortC: number;
  /** Set when the person gets up and changes the thermostat themselves. */
  override?: { targetC: number };
}

/** One moment of the night for a sleeper who is in bed. */
export function sleeperTick(
  truth: SleeperTruth,
  prev: SleeperNightState,
  input: { t: number; roomTempC: number; phase: Phase; ctx: TruthContext },
  rng: Rng,
): SleeperTick {
  const state = { ...prev };
  const ideal = trueIdealC(truth, input.phase, input.ctx);

  const flashStart = state.flashes.find((f) => input.t >= f && input.t < f + FLASH_MS);
  const flash = flashStart === undefined ? 0 : Math.sin((Math.PI * (input.t - flashStart + 2.5 * MIN)) / (FLASH_MS + 5 * MIN));

  // During a hot flash the same room feels well over a degree too warm.
  const discomfort = input.roomTempC - ideal + 1.6 * flash;
  // An unrelieved flash often wakes the sleeper; quick cooling makes that less likely.
  if (flash > 0.9 && rng() < clamp(0.35 * discomfort, 0, 0.8)) state.extraAwakenings += 1;
  // Sleeping too warm disrupts sleep somewhat more than sleeping too cool.
  const felt = discomfort > 0 ? 1.15 * discomfort : 0.85 * discomfort;

  state.ticks += 1;
  state.sumSquared += felt * felt;
  state.sumSigned += discomfort;
  if (input.phase === 'onset') {
    state.onsetSquared += felt * felt;
    state.onsetTicks += 1;
  }

  const vitals: LiveVitals = {
    movement: clamp(0.06 + 0.16 * truth.sensitivity * Math.max(0, Math.abs(discomfort) - 0.4) + 0.05 * Math.abs(gaussian(rng)), 0, 1),
    heartRate: truth.baseline.restingHr + 2 + 1.8 * Math.max(0, discomfort) + 12 * flash + 1.5 * gaussian(rng),
    heartRateBaseline: truth.baseline.restingHr + 2,
    skinTempDeltaC: 0.22 * (input.roomTempC - ideal) + 1.0 * flash + 0.07 * gaussian(rng),
    awake: false,
  };

  let override: SleeperTick['override'];
  if (Math.abs(input.roomTempC - ideal) > 1.75) {
    state.uncomfortableSinceMs ??= input.t;
    const asleepPhase = input.phase === 'onset' || input.phase === 'deep' || input.phase === 'rem';
    if (asleepPhase && state.willOverride && !state.overrideUsed && input.t - state.uncomfortableSinceMs >= 40 * MIN) {
      state.overrideUsed = true;
      state.extraAwakenings += 1;
      vitals.awake = true;
      override = { targetC: roundTo(ideal + 0.3 * gaussian(rng), 0.5) };
    }
  } else {
    state.uncomfortableSinceMs = null;
  }

  return { state, vitals, discomfortC: discomfort, override };
}

export interface SleeperNightResult {
  /** What the wearable reports in the morning. */
  metrics: NightMetrics;
  /** Optional comfort feedback the person leaves in the app. */
  feedback?: FeedbackKind;
  /** Mean signed discomfort over the night (not visible to the engine; for demo diagnostics). */
  meanDiscomfortC: number;
}

/** Turn the night's accumulated discomfort into the metrics a wearable would report. */
export function finishSleeperNight(
  truth: SleeperTruth,
  state: SleeperNightState,
  input: { timeInBedMin: number; ctx: TruthContext },
  rng: Rng,
): SleeperNightResult {
  const b = truth.baseline;
  const n = Math.max(1, state.ticks);
  const meanSquared = state.sumSquared / n;
  const meanSigned = state.sumSigned / n;
  // "Penalty": how much the night's temperature hurt this person's sleep.
  const penalty = Math.min(12, truth.sensitivity * meanSquared);
  const noise = truth.noise;
  const rough = (input.ctx.recovery?.illness ? 4 : 0) + (input.ctx.recovery?.alcohol ? 2.5 : 0);
  const p = penalty + rough;

  const efficiency = clamp(b.efficiency - 0.0042 * p + 0.012 * noise * gaussian(rng), 0.55, 0.985);
  const onsetSquared = state.onsetTicks > 0 ? state.onsetSquared / state.onsetTicks : 0;
  const latency = clamp(b.latencyMin + 2 * onsetSquared + 4 * noise * Math.abs(gaussian(rng)), 2, 90);
  const totalSleep = Math.max(120, input.timeInBedMin * efficiency);
  const awakenings = poisson(rng, b.awakenings + 0.32 * p + 0.25 * (noise - 1)) + state.extraAwakenings;
  const deepShare = clamp(b.deepShare - 0.0042 * p + 0.015 * noise * gaussian(rng), 0.05, 0.35);
  const remShare = clamp(b.remShare - 0.0035 * p + 0.015 * noise * gaussian(rng), 0.05, 0.35);

  const metrics: NightMetrics = {
    timeInBedMin: Math.round(input.timeInBedMin),
    totalSleepMin: Math.round(totalSleep),
    sleepEfficiency: Math.round(efficiency * 1000) / 1000,
    deepMin: Math.round(totalSleep * deepShare),
    remMin: Math.round(totalSleep * remShare),
    awakenings,
    restlessness: Math.round(clamp(b.restlessness + 0.012 * p + 0.02 * noise * gaussian(rng), 0.02, 0.6) * 1000) / 1000,
    sleepLatencyMin: Math.round(latency),
    hrvMs: Math.round((b.hrvMs * (1 - 0.007 * p) + 3.5 * noise * gaussian(rng)) * 10) / 10,
    restingHr: Math.round((b.restingHr + 0.18 * p + 1.2 * noise * gaussian(rng)) * 10) / 10,
    hrvBaselineMs: b.hrvMs,
    restingHrBaseline: b.restingHr,
    skinTempDeviationC: Math.round((0.1 * meanSigned + (input.ctx.recovery?.illness ? 0.9 : 0) + 0.1 * gaussian(rng)) * 100) / 100,
  };

  let feedback: FeedbackKind | undefined;
  if (meanSigned > 1 && rng() < truth.feedbackRate) feedback = 'tooHot';
  else if (meanSigned < -1 && rng() < truth.feedbackRate) feedback = 'tooCold';
  else if (Math.abs(meanSigned) < 0.5 && rng() < 0.25 * truth.feedbackRate) feedback = 'justRight';

  return { metrics, feedback, meanDiscomfortC: meanSigned };
}

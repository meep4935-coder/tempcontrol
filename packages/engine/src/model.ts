/**
 * Per-sleeper thermal preference model.
 *
 * The model answers one question: in a neutral context, what bedroom temperature
 * does this person sleep best at during deep sleep (their "core" temperature),
 * and how sure are we?
 *
 * It fuses two independent sources of evidence:
 *
 *  1. Sleep outcomes. Each night contributes (temperature experienced, sleep
 *     quality). Quality is modelled as falling off with the square of the
 *     distance from the ideal:
 *         quality = a - k * (x - m - c*s)^2 + d*s
 *     where x is degrees away from the prior, s the season index, m the ideal,
 *     c how far the ideal moves with the season, and d a seasonal change in
 *     sleep that has nothing to do with temperature. How sharply quality falls
 *     off (k) differs a lot between people and is hard to pin down from few
 *     nights, so instead of estimating one value the model keeps a handful of
 *     candidate values, weighs each by how well it explains the nights so far,
 *     and averages their answers. For a given k the model is linear with a
 *     Gaussian prior, so each answer is exact and stable even on little data.
 *
 *  2. Stated preferences. Manual overrides and "too hot / too cold / just right"
 *     feedback are direct, noisy statements about the ideal temperature. They
 *     feed a second small regression, ideal = m + c*s.
 *
 * The two estimates are combined as a product of Gaussians, so whichever source
 * is more certain dominates. Before any data arrives the answer is the
 * population prior, which is why the platform works from the first night.
 *
 * Old evidence is gradually forgotten, and evidence that strongly contradicts
 * the current belief speeds that up, so the model follows a person whose
 * preferences change (new duvet, new season of life).
 *
 * State is a plain JSON-serialisable object and every update returns a new one.
 */

import {
  addMat,
  addVec,
  cholesky,
  diag,
  dot,
  invertSpd,
  matVec,
  outer,
  quadForm,
  scaleMat,
  scaleVec,
  zeros,
  zerosMat,
  type Mat,
  type Vec,
} from './linalg';
import type { FeedbackKind, Phase } from './types';
import { clamp } from './util';

export const MODEL_VERSION = 1 as const;

/** Phases whose offset from the core temperature is learned per person. */
export type LearnedPhase = 'onset' | 'rem' | 'wake';

/**
 * Starting assumptions. They describe a typical adult, not any individual:
 * every one of them is revised by that person's own data.
 */
export const MODEL_DEFAULTS = {
  /** Typical ideal deep-sleep room temperature for an adult. */
  priorCoreC: 18.5,
  /** One standard deviation of the spread between people. */
  priorSdC: 1.5,
  /** Typical thermal-quality score at the ideal temperature. */
  priorQuality: 70,
  priorQualitySd: 20,
  /**
   * How many quality points are lost per degree-squared away from the ideal:
   * the typical value, and how much people are assumed to differ around it
   * (as a spread in the logarithm, so 0.8 covers roughly 0.35 to 8).
   */
  curvature: 1.7,
  curvatureLogSd: 0.8,
  /** How far the ideal may move between mid-season and midwinter, one sd. */
  seasonShiftSdC: 0.75,
  /** Seasonal change in sleep quality unrelated to temperature, one sd. */
  seasonQualitySd: 5,
  /** Night-to-night scatter of the quality score, one sd. */
  noiseSd: 8,
  /** Fraction of past evidence kept after each new night (about a 140-night half-life). */
  forgetting: 0.995,
  /** Extra warmth before waking at midwinter, on top of the usual wake-up lift. */
  winterWakeBoostC: 1.5,
  /**
   * While the ideal is still uncertain, nights alternate this far above and
   * below the current estimate: enough to learn from, too little to notice much.
   */
  explorationStepC: 0.5,
  /** Exploration stops once the estimate is known to within this (one sd). */
  explorationStopSdC: 0.4,
} as const;

/**
 * Candidate curvatures, from barely sensitive to very sensitive. Neighbours
 * differ by about a quarter, fine enough that the gaps between them do not
 * matter, and each starts with a plausibility taken from the spread above.
 */
const CURVATURES: readonly number[] = Array.from({ length: 13 }, (_, i) => 0.5 * 2 ** (i / 3));
const CURVATURE_LOG_PRIOR: readonly number[] = (() => {
  const raw = CURVATURES.map((k) => -((Math.log(k) - Math.log(MODEL_DEFAULTS.curvature)) ** 2) / (2 * MODEL_DEFAULTS.curvatureLogSd ** 2));
  const total = Math.log(raw.reduce((sum, v) => sum + Math.exp(v), 0));
  return raw.map((v) => v - total);
})();

/** The ideal is never placed further than this from the population prior. */
const X_MAX = 4.5;
/**
 * Sleep outcomes only say something about temperatures that were actually
 * tried, so the outcome-based estimate may not reach more than this far beyond
 * the range experienced so far. The range widens night by night as the plan
 * follows the estimate.
 */
const TRUST_MARGIN_C = 1.0;
/** Share of old evidence kept when a stated preference contradicts the current belief. */
const SURPRISE_KEEP_PREFERENCES = 0.25;
const SURPRISE_KEEP_OUTCOMES = 0.7;
/**
 * Thermostats move in half-degree steps, so knowing the ideal more tightly
 * than this changes nothing: at this spread the model counts as fully personalised.
 */
const RESOLUTION_SD_C = 0.2;
const NOISE_VAR_MIN = 16;
const NOISE_VAR_MAX = 196;

/** Noise assumed for each kind of stated preference, in degrees (one sd). */
const PREFERENCE_NOISE: Record<'override' | FeedbackKind, number> = {
  override: 0.75,
  tooHot: 1.0,
  tooCold: 1.0,
  justRight: 0.9,
};
/** "Too hot" is read as "about this much cooler would have been right". */
const FEEDBACK_SHIFT_C = 1.0;

const PHASE_PRIORS: Record<LearnedPhase, { mean: number; var: number }> = {
  // Slightly warmer while falling asleep and in late, REM-heavy sleep, when the
  // body regulates its own temperature less well; warmer again to ease waking.
  onset: { mean: 0.5, var: 0.25 },
  rem: { mean: 0.5, var: 0.25 },
  wake: { mean: 1.0, var: 0.5625 },
};
const PHASE_OFFSET_RANGE: Record<LearnedPhase, [number, number]> = {
  onset: [-1, 2],
  rem: [-1, 2],
  wake: [-0.5, 3.5],
};

export interface ThermalModelState {
  version: typeof MODEL_VERSION;
  priorCoreC: number;
  priorSdC: number;
  /**
   * Evidence from sleep outcomes: weighted sums over nights of f*fT, f*quality
   * and quality^2, with f = [1, x, x^2, s*x, s].
   */
  xtx: Mat;
  xty: Vec;
  yty: number;
  /** Range of temperatures experienced so far, as degrees from the prior. */
  xRange: [number, number];
  /** Evidence from stated preferences about (m, c) in ideal = m + c*s, information form. */
  prefPrecision: Mat;
  prefInfo: Vec;
  /** Running estimate of the quality score's night-to-night variance. */
  noiseVar: number;
  forgetting: number;
  /** Nights of outcome data absorbed. */
  nights: number;
  /** Stated preferences absorbed. */
  preferences: number;
  phaseOffsets: Record<LearnedPhase, { mean: number; var: number }>;
}

export interface IdealEstimate {
  /** Best estimate of the ideal deep-sleep temperature at this point of the year. */
  coreC: number;
  /** One standard deviation of that estimate. */
  sdC: number;
  /** 0 (population guess) to 1 (well known). */
  confidence: number;
  /** Quality points lost per degree-squared away from the ideal. */
  sensitivity: number;
  /** Learned difference between midwinter and mid-season ideal temperatures. */
  seasonShiftC: number;
  nights: number;
  preferences: number;
}

/** Older adults tend to sleep best in a somewhat warmer room; the prior reflects that. */
export function priorCoreForAge(age?: number): number {
  const base = MODEL_DEFAULTS.priorCoreC;
  if (age === undefined || !Number.isFinite(age) || age <= 55) return base;
  if (age >= 65) return base + 1.5;
  return base + ((age - 55) / 10) * 1.5;
}

export function createModel(opts: { priorCoreC?: number; age?: number } = {}): ThermalModelState {
  const d = MODEL_DEFAULTS;
  return {
    version: MODEL_VERSION,
    priorCoreC: opts.priorCoreC ?? priorCoreForAge(opts.age),
    priorSdC: d.priorSdC,
    xtx: zerosMat(5),
    xty: zeros(5),
    yty: 0,
    xRange: [0, 0],
    // Deliberately weak: this source should say nothing until the person does.
    prefPrecision: diag([1 / 25, 1]),
    prefInfo: [0, 0],
    noiseVar: d.noiseSd ** 2,
    forgetting: d.forgetting,
    nights: 0,
    preferences: 0,
    phaseOffsets: { onset: { ...PHASE_PRIORS.onset }, rem: { ...PHASE_PRIORS.rem }, wake: { ...PHASE_PRIORS.wake } },
  };
}

const features = (x: number, s: number): Vec => [1, x, x * x, s * x, s];

/** Positions in the feature vector of everything except x^2, whose weight is the (fixed) curvature. */
const LINEAR = [0, 1, 3, 4] as const;
const SQUARE = 2;

interface Gaussian {
  mean: number;
  var: number;
}

const fuse = (a: Gaussian, b: Gaussian): Gaussian => {
  const pa = 1 / a.var;
  const pb = 1 / b.var;
  return { mean: (a.mean * pa + b.mean * pb) / (pa + pb), var: 1 / (pa + pb) };
};

/** A weighted set of Gaussians collapsed to its overall mean and variance. */
const mix = (parts: readonly (Gaussian & { weight: number })[]): Gaussian => {
  const mean = parts.reduce((sum, p) => sum + p.weight * p.mean, 0);
  const second = parts.reduce((sum, p) => sum + p.weight * (p.var + p.mean * p.mean), 0);
  return { mean, var: Math.max(second - mean * mean, 1e-9) };
};

interface CurvatureFit {
  k: number;
  /** How plausible this curvature is given the nights so far. */
  weight: number;
  /** Posterior over the linear weights [intercept, x, s*x, s] for this curvature. */
  mean: Vec;
  cov: Mat;
}

/**
 * Fit the outcome evidence once per candidate curvature. With the curvature
 * fixed, quality + k*x^2 is linear in the remaining weights, so the posterior
 * and the evidence (how well this curvature explains the data) are exact.
 */
function fitOutcomes(state: ThermalModelState): CurvatureFit[] {
  const d = MODEL_DEFAULTS;
  const noise = state.noiseVar;
  const gram = LINEAR.map((i) => LINEAR.map((j) => state.xtx[i]![j]!));

  const fits = CURVATURES.map((k, index) => {
    // The prior on the ideal is the same whatever the curvature, so the prior
    // on the slope weights scales with it.
    const priorVar = [d.priorQualitySd ** 2, (2 * k * state.priorSdC) ** 2, (2 * k * d.seasonShiftSdC) ** 2, d.seasonQualitySd ** 2];
    const priorMean = [d.priorQuality, 0, 0, 0];

    const precision = addMat(diag(priorVar.map((v) => 1 / v)), scaleMat(gram, 1 / noise));
    const moment = LINEAR.map((i) => state.xty[i]! + k * state.xtx[i]![SQUARE]!);
    const info = addVec(
      priorMean.map((m, i) => m / priorVar[i]!),
      scaleVec(moment, 1 / noise),
    );
    const cov = invertSpd(precision);
    const mean = matVec(cov, info);

    const targetSquares = state.yty + 2 * k * state.xty[SQUARE]! + k * k * state.xtx[SQUARE]![SQUARE]!;
    const priorSquares = priorMean.reduce((sum, m, i) => sum + (m * m) / priorVar[i]!, 0);
    const logDetPrecision = 2 * cholesky(precision).reduce((sum, row, i) => sum + Math.log(row[i]!), 0);
    const logDetPrior = priorVar.reduce((sum, v) => sum + Math.log(v), 0);
    const logEvidence = -0.5 * (targetSquares / noise + priorSquares - dot(info, mean)) - 0.5 * (logDetPrecision + logDetPrior);

    return { k, logEvidence, logPrior: CURVATURE_LOG_PRIOR[index]!, mean, cov };
  });

  const scores = fits.map((f) => f.logEvidence + f.logPrior);
  const top = Math.max(...scores);
  const raw = scores.map((v) => Math.exp(v - top));
  const total = raw.reduce((a, b) => a + b, 0);
  return fits.map((f, i) => ({ k: f.k, weight: raw[i]! / total, mean: f.mean, cov: f.cov }));
}

const sensitivityOf = (fits: readonly CurvatureFit[]): number => fits.reduce((sum, f) => sum + f.weight * f.k, 0);

/** Ideal temperature (as degrees from the prior) according to sleep outcomes. */
function outcomeEstimate(state: ThermalModelState, fits: readonly CurvatureFit[], s: number): Gaussian {
  const combined = mix(
    fits.map((f) => ({
      weight: f.weight,
      mean: (f.mean[1]! + f.mean[2]! * s) / (2 * f.k),
      var: (f.cov[1]![1]! + 2 * s * f.cov[1]![2]! + s * s * f.cov[2]![2]!) / (4 * f.k * f.k),
    })),
  );
  const lo = Math.max(-X_MAX, state.xRange[0] - TRUST_MARGIN_C);
  const hi = Math.min(X_MAX, state.xRange[1] + TRUST_MARGIN_C);
  return { mean: clamp(combined.mean, lo, hi), var: combined.var };
}

/** How far the ideal moves between mid-season and midwinter, according to sleep outcomes. */
function outcomeSeasonShift(fits: readonly CurvatureFit[]): Gaussian {
  return mix(fits.map((f) => ({ weight: f.weight, mean: f.mean[2]! / (2 * f.k), var: f.cov[2]![2]! / (4 * f.k * f.k) })));
}

/** Ideal temperature (as degrees from the prior) according to stated preferences. */
function preferenceEstimate(state: ThermalModelState, s: number): Gaussian {
  const cov = invertSpd(state.prefPrecision);
  const mc = matVec(cov, state.prefInfo);
  return { mean: mc[0]! + mc[1]! * s, var: Math.max(quadForm(cov, [1, s]), 1e-6) };
}

function fusedEstimate(state: ThermalModelState, s: number, fits = fitOutcomes(state)): Gaussian {
  const fromOutcomes = outcomeEstimate(state, fits, s);
  const fused = state.preferences > 0 ? fuse(fromOutcomes, preferenceEstimate(state, s)) : fromOutcomes;
  return { mean: clamp(fused.mean, -X_MAX, X_MAX), var: fused.var };
}

/** What the model currently believes about a person's ideal temperature at season index `s`. */
export function estimateIdeal(state: ThermalModelState, s: number): IdealEstimate {
  const fits = fitOutcomes(state);
  const fused = fusedEstimate(state, s, fits);
  const sd = Math.sqrt(fused.var);
  const priorSd = Math.sqrt(state.priorSdC ** 2 + (s * MODEL_DEFAULTS.seasonShiftSdC) ** 2);

  let shift = outcomeSeasonShift(fits);
  if (state.preferences > 0) {
    const prefCov = invertSpd(state.prefPrecision);
    const mc = matVec(prefCov, state.prefInfo);
    shift = fuse(shift, { mean: mc[1]!, var: Math.max(prefCov[1]![1]!, 1e-6) });
  }

  return {
    coreC: state.priorCoreC + fused.mean,
    sdC: sd,
    confidence: clamp(1 - (sd - RESOLUTION_SD_C) / (priorSd - RESOLUTION_SD_C), 0, 1),
    sensitivity: sensitivityOf(fits),
    seasonShiftC: shift.mean,
    nights: state.nights,
    preferences: state.preferences,
  };
}

/**
 * Tonight's deliberate variation from the estimate, in degrees.
 *
 * Sleeping at exactly the same temperature every night teaches nothing about
 * whether a slightly different one would be better. So while the estimate is
 * still uncertain, nights alternate half a degree above and below it in a
 * fixed two-up, two-down rhythm. Once the estimate is tight the variation
 * stops by itself; it resumes if the model later becomes unsure again.
 */
export function explorationC(state: ThermalModelState, s: number): number {
  const sd = Math.sqrt(fusedEstimate(state, s).var);
  if (sd < MODEL_DEFAULTS.explorationStopSdC) return 0;
  const rhythm = [1, -1, -1, 1];
  return rhythm[state.nights % rhythm.length]! * MODEL_DEFAULTS.explorationStepC;
}

function predictWith(fits: readonly CurvatureFit[], x: number, s: number): Gaussian {
  const linear = [1, x, s * x, s];
  return mix(fits.map((f) => ({ weight: f.weight, mean: dot(linear, f.mean) - f.k * x * x, var: quadForm(f.cov, linear) })));
}

/** Expected thermal-quality score if the person slept at `coreC` in season `s`. */
export function predictQuality(state: ThermalModelState, coreC: number, s: number): number {
  return predictWith(fitOutcomes(state), coreC - state.priorCoreC, s).mean;
}

/**
 * The offset from the core temperature the person is believed to want in a phase.
 * The wake-up lift grows toward midwinter (s = +1): cold, dark mornings get a warmer room.
 */
export function phaseOffset(state: ThermalModelState, phase: Phase, s: number): number {
  switch (phase) {
    case 'deep':
      return 0;
    case 'windDown':
    case 'onset':
      return state.phaseOffsets.onset.mean;
    case 'rem':
      return state.phaseOffsets.rem.mean;
    case 'wake':
      return state.phaseOffsets.wake.mean + MODEL_DEFAULTS.winterWakeBoostC * Math.max(0, s);
  }
}

const learnedPhase = (phase: Phase): LearnedPhase | null =>
  phase === 'deep' ? null : phase === 'windDown' ? 'onset' : phase;

function forget(state: ThermalModelState, keepOutcomes: number, keepPreferences = keepOutcomes): ThermalModelState {
  const weakPref = diag([1 / 25, 1]);
  // Preference evidence decays toward its weak prior, never below it.
  const prefData = addMat(state.prefPrecision, scaleMat(weakPref, -1));
  return {
    ...state,
    xtx: scaleMat(state.xtx, keepOutcomes),
    xty: scaleVec(state.xty, keepOutcomes),
    yty: state.yty * keepOutcomes,
    prefPrecision: addMat(weakPref, scaleMat(prefData, keepPreferences)),
    prefInfo: scaleVec(state.prefInfo, keepPreferences),
  };
}

export interface NightObservation {
  /**
   * Core-equivalent temperature the person actually slept in: the measured room
   * temperature with phase offsets and context adjustments removed. Using what
   * was experienced, not what was requested, keeps the model honest when the
   * heating or cooling could not reach the target.
   */
  experiencedCoreC: number;
  seasonIndex: number;
  /** Thermal-quality score, 0..100. */
  quality: number;
}

/** Absorb one night's outcome. */
export function observeNight(state: ThermalModelState, obs: NightObservation): ThermalModelState {
  if (!Number.isFinite(obs.quality) || !Number.isFinite(obs.experiencedCoreC)) return state;
  const s = clamp(obs.seasonIndex, -1, 1);
  const x = clamp(obs.experiencedCoreC - state.priorCoreC, -8, 8);
  const phi = features(x, s);

  const predicted = predictWith(fitOutcomes(state), x, s);
  const residual = obs.quality - predicted.mean;
  const predictiveVar = state.noiseVar + predicted.var;

  // Once there is a baseline to judge against, a wildly unexpected night (a
  // sick child, a storm) is weighted down instead of dragging the estimate.
  const z = Math.abs(residual) / Math.sqrt(predictiveVar);
  const weight = state.nights >= 8 && z > 3 ? 3 / z : 1;

  // Track how noisy this person's scores are. Early residuals also reflect the
  // model's own uncertainty, so only the share attributable to noise is counted.
  const noiseShare = (Math.min(residual * residual, 400) * state.noiseVar) / predictiveVar;
  const rate = Math.max(1 / (state.nights + 4), 0.05);
  const noiseVar = clamp(state.noiseVar + rate * (noiseShare - state.noiseVar), NOISE_VAR_MIN, NOISE_VAR_MAX);

  const next = forget(state, state.forgetting);
  return {
    ...next,
    xtx: addMat(next.xtx, scaleMat(outer(phi, phi), weight)),
    xty: addVec(next.xty, scaleVec(phi, weight * obs.quality)),
    yty: next.yty + weight * obs.quality * obs.quality,
    xRange: [Math.min(state.xRange[0], x), Math.max(state.xRange[1], x)],
    noiseVar,
    nights: state.nights + 1,
  };
}

export interface PreferenceObservation {
  kind: 'override' | FeedbackKind;
  /**
   * For an override: the temperature the person asked for.
   * For feedback: the room temperature they were reacting to.
   * Context adjustments (humidity, cycle, recovery...) must already be removed.
   */
  tempC: number;
  /** The phase the person was in, which decides how the statement is interpreted. */
  phase: Phase;
  seasonIndex: number;
  /**
   * How much to trust this statement, as a noise level in degrees (one sd).
   * Defaults to the level for its kind; pass a larger value for inferred
   * signals such as an in-night adjustment triggered by restlessness.
   */
  noiseC?: number;
}

/** Absorb an override or a piece of comfort feedback. */
export function observePreference(state: ThermalModelState, obs: PreferenceObservation): ThermalModelState {
  if (!Number.isFinite(obs.tempC)) return state;
  const s = clamp(obs.seasonIndex, -1, 1);
  const lp = learnedPhase(obs.phase);
  const offset = phaseOffset(state, obs.phase, s);
  const shift = obs.kind === 'tooHot' ? -FEEDBACK_SHIFT_C : obs.kind === 'tooCold' ? FEEDBACK_SHIFT_C : 0;
  const noiseVar = (obs.noiseC ?? PREFERENCE_NOISE[obs.kind]) ** 2;

  // What this statement implies for the core temperature, as degrees from the prior.
  const y = clamp(obs.tempC + shift - offset - state.priorCoreC, -8, 8);

  const belief = fusedEstimate(state, s);
  const phaseVar = lp ? state.phaseOffsets[lp].var : 0;
  const innovation = y - belief.mean;
  const total = belief.var + phaseVar + noiseVar;

  // "Too hot" only says the ideal is cooler than what was experienced. If the
  // model already believes something cooler still (for instance because the
  // room could not get down to the target), the remark carries no new
  // information, and must never pull the estimate warmer. Likewise for "too cold".
  if ((obs.kind === 'tooHot' && innovation > 0) || (obs.kind === 'tooCold' && innovation < 0)) return state;

  // A statement far outside what the model expected suggests the person has
  // changed (or the model was wrong): loosen old evidence so it can catch up.
  let next = state;
  if (Math.abs(innovation) / Math.sqrt(total) > 2) next = forget(next, SURPRISE_KEEP_OUTCOMES, SURPRISE_KEEP_PREFERENCES);

  // The statement may be about the core temperature or about this phase's
  // offset; each takes the share of the surprise its own uncertainty warrants.
  const h = [1, s];
  const coreNoise = noiseVar + phaseVar;
  next = {
    ...next,
    prefPrecision: addMat(next.prefPrecision, scaleMat(outer(h, h), 1 / coreNoise)),
    prefInfo: addVec(next.prefInfo, scaleVec(h, y / coreNoise)),
    preferences: state.preferences + 1,
  };

  if (lp) {
    const gain = phaseVar / total;
    const [lo, hi] = PHASE_OFFSET_RANGE[lp];
    next = {
      ...next,
      phaseOffsets: {
        ...next.phaseOffsets,
        [lp]: {
          mean: clamp(state.phaseOffsets[lp].mean + gain * innovation, lo, hi),
          // Keep a little uncertainty so phase preferences can still drift later.
          var: Math.max((1 - gain) * phaseVar, 0.02),
        },
      },
    };
  }
  return next;
}

/** Forget everything learned and return to the population starting point. */
export function resetModel(state: ThermalModelState): ThermalModelState {
  return createModel({ priorCoreC: state.priorCoreC });
}

import { describe, expect, it } from 'vitest';
import {
  createModel,
  estimateIdeal,
  explorationC,
  gaussian,
  MODEL_DEFAULTS,
  observeNight,
  observePreference,
  phaseOffset,
  predictQuality,
  priorCoreForAge,
  resetModel,
  seededRng,
  type ThermalModelState,
} from '../src/index';

/** Feed nights from a known quadratic response and return the model. */
function trainOnOutcomes(opts: { idealC: number; curvature: number; noiseSd: number; nights: number; seed: number; spread?: number }): ThermalModelState {
  const rng = seededRng(opts.seed);
  let model = createModel();
  for (let n = 0; n < opts.nights; n++) {
    const tempC = 18.5 + (opts.spread ?? 2) * (rng() * 2 - 1);
    const quality = 78 - opts.curvature * (tempC - opts.idealC) ** 2 + opts.noiseSd * gaussian(rng);
    model = observeNight(model, { experiencedCoreC: tempC, seasonIndex: 0, quality });
  }
  return model;
}

describe('thermal preference model', () => {
  it('starts at the population prior, with no confidence', () => {
    const estimate = estimateIdeal(createModel(), 0);
    expect(estimate.coreC).toBeCloseTo(MODEL_DEFAULTS.priorCoreC, 6);
    expect(estimate.sdC).toBeCloseTo(MODEL_DEFAULTS.priorSdC, 6);
    expect(estimate.confidence).toBeCloseTo(0, 6);
    // Sensitivity starts as the average over the candidate values: near the typical one.
    expect(estimate.sensitivity).toBeGreaterThan(MODEL_DEFAULTS.curvature);
    expect(estimate.sensitivity).toBeLessThan(MODEL_DEFAULTS.curvature + 1);
    expect(estimate.seasonShiftC).toBeCloseTo(0, 6);
  });

  it('starts older adults somewhat warmer', () => {
    expect(priorCoreForAge(undefined)).toBe(18.5);
    expect(priorCoreForAge(30)).toBe(18.5);
    expect(priorCoreForAge(60)).toBeCloseTo(19.25, 6);
    expect(priorCoreForAge(80)).toBe(20);
    expect(estimateIdeal(createModel({ age: 72 }), 0).coreC).toBe(20);
  });

  it('recovers the ideal temperature from sleep outcomes alone', () => {
    for (const idealC of [17, 18.5, 20]) {
      const model = trainOnOutcomes({ idealC, curvature: 3, noiseSd: 5, nights: 80, seed: 8 });
      const estimate = estimateIdeal(model, 0);
      expect(Math.abs(estimate.coreC - idealC)).toBeLessThan(0.5);
      expect(estimate.confidence).toBeGreaterThan(0.6);
      expect(estimate.sdC).toBeLessThan(0.6);
    }
  });

  it('learns how temperature-sensitive the sleeper is', () => {
    const sensitive = estimateIdeal(trainOnOutcomes({ idealC: 18.5, curvature: 4, noiseSd: 4, nights: 120, seed: 3 }), 0);
    const robust = estimateIdeal(trainOnOutcomes({ idealC: 18.5, curvature: 0.8, noiseSd: 4, nights: 120, seed: 3 }), 0);
    expect(sensitive.sensitivity).toBeGreaterThan(robust.sensitivity + 1);
  });

  it('becomes more certain as nights accumulate', () => {
    const few = estimateIdeal(trainOnOutcomes({ idealC: 19, curvature: 3, noiseSd: 5, nights: 5, seed: 11 }), 0);
    const many = estimateIdeal(trainOnOutcomes({ idealC: 19, curvature: 3, noiseSd: 5, nights: 60, seed: 11 }), 0);
    expect(many.sdC).toBeLessThan(few.sdC);
    expect(many.confidence).toBeGreaterThan(few.confidence);
  });

  it('moves toward a manual override, and further with repetition', () => {
    let model = createModel();
    model = observePreference(model, { kind: 'override', tempC: 21, phase: 'deep', seasonIndex: 0 });
    const once = estimateIdeal(model, 0);
    expect(once.coreC).toBeGreaterThan(19.5);
    expect(once.coreC).toBeLessThan(21);
    for (let i = 0; i < 4; i++) model = observePreference(model, { kind: 'override', tempC: 21, phase: 'deep', seasonIndex: 0 });
    const repeated = estimateIdeal(model, 0);
    expect(repeated.coreC).toBeGreaterThan(once.coreC);
    expect(repeated.coreC).toBeCloseTo(21, 0);
    expect(repeated.sdC).toBeLessThan(once.sdC);
  });

  it('reads "too hot" as cooler and "too cold" as warmer, never the reverse', () => {
    const base = createModel();
    const hot = estimateIdeal(observePreference(base, { kind: 'tooHot', tempC: 18.5, phase: 'deep', seasonIndex: 0 }), 0);
    const cold = estimateIdeal(observePreference(base, { kind: 'tooCold', tempC: 18.5, phase: 'deep', seasonIndex: 0 }), 0);
    expect(hot.coreC).toBeLessThan(18.5);
    expect(cold.coreC).toBeGreaterThan(18.5);

    // The room was stuck at 21 while the model already believes 17: "too hot" adds nothing.
    let cool = base;
    for (let i = 0; i < 5; i++) cool = observePreference(cool, { kind: 'override', tempC: 17, phase: 'deep', seasonIndex: 0 });
    const before = estimateIdeal(cool, 0).coreC;
    const after = estimateIdeal(observePreference(cool, { kind: 'tooHot', tempC: 21, phase: 'deep', seasonIndex: 0 }), 0).coreC;
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeCloseTo(before, 6);
  });

  it('"just right" confirms the current temperature', () => {
    let model = createModel();
    for (let i = 0; i < 6; i++) model = observePreference(model, { kind: 'justRight', tempC: 19.5, phase: 'deep', seasonIndex: 0 });
    const estimate = estimateIdeal(model, 0);
    expect(estimate.coreC).toBeGreaterThan(19.2);
    expect(estimate.coreC).toBeLessThan(19.6);
  });

  it('attributes a phase-specific override partly to that phase', () => {
    let model = createModel();
    const wakeBefore = phaseOffset(model, 'wake', 0);
    // Repeatedly asking for 23 during the wake-up phase: mostly a wake preference.
    for (let i = 0; i < 6; i++) model = observePreference(model, { kind: 'override', tempC: 23, phase: 'wake', seasonIndex: 0 });
    expect(phaseOffset(model, 'wake', 0)).toBeGreaterThan(wakeBefore + 0.5);
    // The deep-sleep phase has no offset to absorb anything.
    expect(phaseOffset(model, 'deep', 0)).toBe(0);
  });

  it('warms the wake-up more in winter than in summer', () => {
    const model = createModel();
    expect(phaseOffset(model, 'wake', 1) - phaseOffset(model, 'wake', -1)).toBeCloseTo(MODEL_DEFAULTS.winterWakeBoostC, 6);
    expect(phaseOffset(model, 'wake', -1)).toBeCloseTo(phaseOffset(model, 'wake', 0), 6);
  });

  it('learns a seasonal shift from preferences stated in different seasons', () => {
    let model = createModel();
    for (let i = 0; i < 8; i++) {
      model = observePreference(model, { kind: 'override', tempC: 20, phase: 'deep', seasonIndex: 0.9 });
      model = observePreference(model, { kind: 'override', tempC: 18, phase: 'deep', seasonIndex: -0.9 });
    }
    expect(estimateIdeal(model, 0.9).coreC).toBeGreaterThan(estimateIdeal(model, -0.9).coreC + 1);
    expect(estimateIdeal(model, 0).seasonShiftC).toBeGreaterThan(0.5);
  });

  it('follows a person whose preference changes', () => {
    let model = createModel();
    for (let i = 0; i < 30; i++) model = observePreference(model, { kind: 'override', tempC: 17, phase: 'deep', seasonIndex: 0 });
    expect(estimateIdeal(model, 0).coreC).toBeCloseTo(17, 0);
    // New duvet: now they keep asking for 20. Three nights of that should be enough to mostly follow.
    for (let i = 0; i < 3; i++) model = observePreference(model, { kind: 'override', tempC: 20, phase: 'deep', seasonIndex: 0 });
    expect(estimateIdeal(model, 0).coreC).toBeGreaterThan(19);
    for (let i = 0; i < 3; i++) model = observePreference(model, { kind: 'override', tempC: 20, phase: 'deep', seasonIndex: 0 });
    expect(estimateIdeal(model, 0).coreC).toBeGreaterThan(19.5);
  });

  it('is only nudged by a one-off request that goes against a long habit', () => {
    let model = createModel();
    for (let i = 0; i < 30; i++) model = observePreference(model, { kind: 'override', tempC: 17, phase: 'deep', seasonIndex: 0 });
    model = observePreference(model, { kind: 'override', tempC: 21, phase: 'deep', seasonIndex: 0 });
    expect(estimateIdeal(model, 0).coreC).toBeLessThan(17.75);
  });

  it('does not extrapolate far beyond temperatures that were actually tried', () => {
    // Every night was spent between 18 and 19, and warmer always scored better.
    const rng = seededRng(1);
    let model = createModel();
    for (let n = 0; n < 60; n++) {
      const tempC = 18 + rng();
      model = observeNight(model, { experiencedCoreC: tempC, seasonIndex: 0, quality: 60 + 12 * (tempC - 18) + 3 * gaussian(rng) });
    }
    const estimate = estimateIdeal(model, 0);
    expect(estimate.coreC).toBeGreaterThan(19);
    expect(estimate.coreC).toBeLessThanOrEqual(20 + 1e-9);
  });

  it('is not thrown by a single terrible night', () => {
    const model = trainOnOutcomes({ idealC: 19, curvature: 3, noiseSd: 4, nights: 40, seed: 5 });
    const before = estimateIdeal(model, 0).coreC;
    const after = estimateIdeal(observeNight(model, { experiencedCoreC: 19, seasonIndex: 0, quality: 5 }), 0).coreC;
    expect(Math.abs(after - before)).toBeLessThan(0.3);
  });

  it('ignores unusable input', () => {
    const model = createModel();
    expect(observeNight(model, { experiencedCoreC: Number.NaN, seasonIndex: 0, quality: 70 })).toBe(model);
    expect(observeNight(model, { experiencedCoreC: 19, seasonIndex: 0, quality: Number.NaN })).toBe(model);
    expect(observePreference(model, { kind: 'override', tempC: Number.NaN, phase: 'deep', seasonIndex: 0 })).toBe(model);
  });

  it('keeps estimates finite and bounded under absurd evidence', () => {
    let model = createModel();
    for (let i = 0; i < 50; i++) {
      model = observePreference(model, { kind: 'override', tempC: 60, phase: 'rem', seasonIndex: 1 });
      model = observeNight(model, { experiencedCoreC: -40, seasonIndex: -1, quality: 100 });
    }
    const estimate = estimateIdeal(model, 1);
    expect(Number.isFinite(estimate.coreC)).toBe(true);
    expect(estimate.coreC).toBeLessThanOrEqual(MODEL_DEFAULTS.priorCoreC + 4.5);
    expect(estimate.coreC).toBeGreaterThanOrEqual(MODEL_DEFAULTS.priorCoreC - 4.5);
    expect(estimate.sdC).toBeGreaterThan(0);
  });

  it('survives a JSON round trip and updates without mutating', () => {
    const model = trainOnOutcomes({ idealC: 19.5, curvature: 3, noiseSd: 5, nights: 20, seed: 9 });
    const frozen = JSON.stringify(model);
    const copy = JSON.parse(frozen) as ThermalModelState;
    expect(estimateIdeal(copy, 0.3)).toEqual(estimateIdeal(model, 0.3));
    observeNight(model, { experiencedCoreC: 20, seasonIndex: 0, quality: 60 });
    observePreference(model, { kind: 'tooCold', tempC: 18, phase: 'onset', seasonIndex: 0 });
    expect(JSON.stringify(model)).toBe(frozen);
  });

  it('varies the plan by half a degree either way while unsure, then stops', () => {
    // Fresh model: two nights up, two nights down, averaging to no change.
    let model = createModel();
    const steps: number[] = [];
    for (let night = 0; night < 8; night++) {
      steps.push(explorationC(model, 0));
      model = observeNight(model, { experiencedCoreC: 18.5, seasonIndex: 0, quality: 75 });
    }
    expect(new Set(steps.map(Math.abs))).toEqual(new Set([MODEL_DEFAULTS.explorationStepC]));
    expect(steps.reduce((a, b) => a + b, 0)).toBe(0);

    // Once the ideal is well known there is nothing left to test.
    let known = createModel();
    for (let i = 0; i < 12; i++) known = observePreference(known, { kind: 'override', tempC: 19.5, phase: 'deep', seasonIndex: 0 });
    expect(estimateIdeal(known, 0).sdC).toBeLessThan(MODEL_DEFAULTS.explorationStopSdC);
    expect(explorationC(known, 0)).toBe(0);
  });

  it('moves smoothly: no single ordinary night shifts the estimate much', () => {
    const rng = seededRng(21);
    let model = createModel();
    let previous = estimateIdeal(model, 0).coreC;
    let largest = 0;
    for (let n = 0; n < 60; n++) {
      // A room that barely varies: the hardest case for finding an optimum.
      const tempC = 19.6 + 0.3 * (rng() * 2 - 1);
      model = observeNight(model, { experiencedCoreC: tempC, seasonIndex: 0, quality: 76 + 6 * gaussian(rng) });
      const now = estimateIdeal(model, 0).coreC;
      largest = Math.max(largest, Math.abs(now - previous));
      previous = now;
    }
    expect(largest).toBeLessThan(0.5);
  });

  it('predicts lower quality away from the learned ideal', () => {
    const model = trainOnOutcomes({ idealC: 19, curvature: 3, noiseSd: 3, nights: 100, seed: 4 });
    const best = predictQuality(model, 19, 0);
    expect(best).toBeGreaterThan(predictQuality(model, 21.5, 0) + 5);
    expect(best).toBeGreaterThan(predictQuality(model, 16.5, 0) + 5);
  });

  it('can be reset to the starting point', () => {
    const model = trainOnOutcomes({ idealC: 21, curvature: 3, noiseSd: 5, nights: 30, seed: 6 });
    expect(estimateIdeal(resetModel(model), 0)).toEqual(estimateIdeal(createModel(), 0));
  });
});

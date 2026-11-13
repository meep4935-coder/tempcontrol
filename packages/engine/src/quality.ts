import type { NightMetrics } from './types';
import { clamp } from './util';

export interface QualityScore {
  /** Headline 0..100 score shown to the user. */
  overall: number;
  /**
   * 0..100 score weighted toward what room temperature plausibly affects
   * (staying asleep, restlessness, deep and REM sleep). The model learns from
   * this one so that, say, a short night caused by a late flight does not look
   * like a temperature problem.
   */
  thermal: number;
  components: Partial<Record<Component, number>>;
}

type Component = 'efficiency' | 'continuity' | 'restorative' | 'recovery' | 'duration';

/** Linear 0..1 score between a "poor" and a "great" reference value. */
const scale = (value: number, poor: number, great: number): number => clamp((value - poor) / (great - poor), 0, 1);

const OVERALL_WEIGHTS: Record<Component, number> = {
  efficiency: 0.3,
  continuity: 0.2,
  restorative: 0.2,
  recovery: 0.2,
  duration: 0.1,
};

const THERMAL_WEIGHTS: Record<Component, number> = {
  efficiency: 0.35,
  continuity: 0.35,
  restorative: 0.2,
  recovery: 0.1,
  duration: 0,
};

/**
 * One comparable score per night from whatever a wearable reports. Vendors
 * publish their own scores on different scales; computing ours from the
 * underlying metrics keeps nights comparable across brands and across partners.
 * Components a device does not report are left out and the rest re-weighted.
 */
export function scoreNight(m: NightMetrics): QualityScore {
  const components: Partial<Record<Component, number>> = {};

  components.efficiency = scale(m.sleepEfficiency, 0.7, 0.95);

  const continuityParts: number[] = [];
  if (m.awakenings !== undefined) continuityParts.push(scale(m.awakenings, 8, 0));
  if (m.restlessness !== undefined) continuityParts.push(scale(m.restlessness, 0.35, 0.05));
  if (continuityParts.length > 0) {
    components.continuity = continuityParts.reduce((a, b) => a + b, 0) / continuityParts.length;
  }

  if (m.deepMin !== undefined && m.remMin !== undefined && m.totalSleepMin > 0) {
    components.restorative = scale((m.deepMin + m.remMin) / m.totalSleepMin, 0.25, 0.5);
  }

  const recoveryParts: number[] = [];
  if (m.hrvMs !== undefined && m.hrvBaselineMs) recoveryParts.push(scale(m.hrvMs / m.hrvBaselineMs, 0.8, 1.2));
  if (m.restingHr !== undefined && m.restingHrBaseline !== undefined) {
    recoveryParts.push(scale(m.restingHr - m.restingHrBaseline, 5, -3));
  }
  if (recoveryParts.length > 0) {
    components.recovery = recoveryParts.reduce((a, b) => a + b, 0) / recoveryParts.length;
  }

  components.duration = scale(m.totalSleepMin, 300, 450);

  const weighted = (weights: Record<Component, number>): number => {
    let sum = 0;
    let total = 0;
    for (const key of Object.keys(weights) as Component[]) {
      const value = components[key];
      if (value === undefined || weights[key] === 0) continue;
      sum += value * weights[key];
      total += weights[key];
    }
    return total === 0 ? 0 : (100 * sum) / total;
  };

  return { overall: weighted(OVERALL_WEIGHTS), thermal: weighted(THERMAL_WEIGHTS), components };
}

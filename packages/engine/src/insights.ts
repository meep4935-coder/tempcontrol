/**
 * Plain-data observations about a sleeper's history. The app renders them in
 * the user's language, and the AI assistant is given them as grounding so its
 * advice rests on numbers that were actually computed, not guessed.
 *
 * Every insight has a minimum amount of data behind it; with too few nights it
 * is simply not produced.
 */

import type { ModifierId } from './context';
import { estimateIdeal, type ThermalModelState } from './model';
import type { FeedbackKind } from './types';
import { mean } from './util';

export interface NightRecord {
  date: string;
  seasonIndex: number;
  /** Deep-sleep-equivalent temperature the sleeper experienced. */
  experiencedCoreC: number | null;
  thermalQuality: number | null;
  overallQuality: number | null;
  humidityPct?: number;
  modifiers: ModifierId[];
  /** Manual changes made during the night. */
  overrides: number;
  /** Net direction of those changes: positive means the user asked for warmer. */
  overrideDeltaC?: number;
  feedback?: FeedbackKind;
  liveAdjustments: number;
  /**
   * Average of (room temperature - setpoint) while asleep. Persistently
   * positive means the room could not get as cool as asked; negative, as warm.
   */
  trackingErrorC?: number;
  energyKWh?: number;
  baselineKWh?: number;
  costCents?: number;
  baselineCostCents?: number;
}

export type Insight =
  /** Still calibrating: how far along the model is. */
  | { id: 'learning'; nights: number; confidence: number }
  /** The model's current answer, with its plausible range. */
  | { id: 'ideal'; coreC: number; lowC: number; highC: number; confidence: number }
  /** Nights inside this temperature band scored better than nights outside it. */
  | { id: 'bestBand'; lowC: number; highC: number; gain: number; nightsIn: number; nightsOut: number }
  /** The ideal temperature differs between winter and the rest of the year. */
  | { id: 'seasonShift'; shiftC: number }
  /** Humid nights scored worse. */
  | { id: 'humidNights'; nights: number; drop: number; averagePct: number }
  /** The user keeps correcting the plan in one direction. */
  | { id: 'overrides'; count: number; direction: 'warmer' | 'cooler' }
  /** Recent nights compared with the ones before. */
  | { id: 'trend'; delta: number; nights: number }
  /** The room regularly fails to reach the temperature asked for. */
  | { id: 'cannotReach'; direction: 'cooler' | 'warmer'; nights: number; shortfallC: number }
  /** In-night adjustments made over the period. */
  | { id: 'liveAdjustments'; count: number; nights: number }
  /** Energy used against the "thermostat left alone" baseline. */
  | { id: 'energy'; savedKWh: number; savedCents: number; nights: number };

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function buildInsights(model: ThermalModelState, history: readonly NightRecord[], seasonIndexNow: number): Insight[] {
  const out: Insight[] = [];
  const estimate = estimateIdeal(model, seasonIndexNow);
  const scored = history.filter(
    (n): n is NightRecord & { experiencedCoreC: number; thermalQuality: number } =>
      n.experiencedCoreC !== null && n.thermalQuality !== null,
  );

  if (estimate.confidence < 0.6) {
    out.push({ id: 'learning', nights: model.nights, confidence: estimate.confidence });
  }
  out.push({
    id: 'ideal',
    coreC: round1(estimate.coreC),
    lowC: round1(estimate.coreC - estimate.sdC),
    highC: round1(estimate.coreC + estimate.sdC),
    confidence: estimate.confidence,
  });

  // Best one-degree band: compare nights inside it with nights outside it.
  if (scored.length >= 10) {
    let best: { lowC: number; gain: number; nightsIn: number; nightsOut: number } | null = null;
    const temps = scored.map((n) => n.experiencedCoreC);
    for (let lowC = Math.floor(Math.min(...temps) * 2) / 2; lowC <= Math.max(...temps); lowC += 0.5) {
      const inside = scored.filter((n) => n.experiencedCoreC >= lowC && n.experiencedCoreC < lowC + 1);
      const outside = scored.filter((n) => n.experiencedCoreC < lowC || n.experiencedCoreC >= lowC + 1);
      if (inside.length < 4 || outside.length < 4) continue;
      const gain = mean(inside.map((n) => n.thermalQuality)) - mean(outside.map((n) => n.thermalQuality));
      if (!best || gain > best.gain) best = { lowC, gain, nightsIn: inside.length, nightsOut: outside.length };
    }
    if (best && best.gain >= 2) {
      out.push({ id: 'bestBand', lowC: best.lowC, highC: best.lowC + 1, gain: round1(best.gain), nightsIn: best.nightsIn, nightsOut: best.nightsOut });
    }
  }

  if (Math.abs(estimate.seasonShiftC) >= 0.4 && model.nights + model.preferences >= 20) {
    out.push({ id: 'seasonShift', shiftC: round1(estimate.seasonShiftC) });
  }

  const withHumidity = scored.filter((n) => n.humidityPct !== undefined);
  const humid = withHumidity.filter((n) => n.humidityPct! > 60);
  const comfortable = withHumidity.filter((n) => n.humidityPct! <= 60);
  if (humid.length >= 4 && comfortable.length >= 4) {
    const drop = mean(comfortable.map((n) => n.thermalQuality)) - mean(humid.map((n) => n.thermalQuality));
    if (drop >= 2) {
      out.push({ id: 'humidNights', nights: humid.length, drop: round1(drop), averagePct: Math.round(mean(humid.map((n) => n.humidityPct!))) });
    }
  }
  const recent = history.slice(-14);
  const overridden = recent.filter((n) => n.overrides > 0 && n.overrideDeltaC !== undefined && n.overrideDeltaC !== 0);
  if (overridden.length >= 3) {
    const warmer = overridden.filter((n) => n.overrideDeltaC! > 0).length;
    if (warmer >= overridden.length * 0.75) out.push({ id: 'overrides', count: overridden.length, direction: 'warmer' });
    else if (warmer <= overridden.length * 0.25) out.push({ id: 'overrides', count: overridden.length, direction: 'cooler' });
  }

  const qualities = history.filter((n) => n.overallQuality !== null).map((n) => n.overallQuality!);
  if (qualities.length >= 14) {
    const latest = qualities.slice(-7);
    const before = qualities.slice(-14, -7);
    const delta = mean(latest) - mean(before);
    if (Math.abs(delta) >= 2) out.push({ id: 'trend', delta: round1(delta), nights: 7 });
  }

  const tooWarm = recent.filter((n) => n.trackingErrorC !== undefined && n.trackingErrorC >= 0.75);
  const tooCool = recent.filter((n) => n.trackingErrorC !== undefined && n.trackingErrorC <= -0.75);
  if (tooWarm.length >= 4) {
    out.push({ id: 'cannotReach', direction: 'cooler', nights: tooWarm.length, shortfallC: round1(mean(tooWarm.map((n) => n.trackingErrorC!))) });
  } else if (tooCool.length >= 4) {
    out.push({ id: 'cannotReach', direction: 'warmer', nights: tooCool.length, shortfallC: round1(-mean(tooCool.map((n) => n.trackingErrorC!))) });
  }

  const adjustments = recent.reduce((sum, n) => sum + n.liveAdjustments, 0);
  if (adjustments >= 3) out.push({ id: 'liveAdjustments', count: adjustments, nights: recent.length });

  const metered = history.filter((n) => n.energyKWh !== undefined && n.baselineKWh !== undefined);
  if (metered.length >= 3) {
    const savedKWh = metered.reduce((sum, n) => sum + (n.baselineKWh! - n.energyKWh!), 0);
    const savedCents = metered.reduce((sum, n) => sum + ((n.baselineCostCents ?? 0) - (n.costCents ?? 0)), 0);
    out.push({ id: 'energy', savedKWh: round1(savedKWh), savedCents: Math.round(savedCents), nights: metered.length });
  }

  return out;
}

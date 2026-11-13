/**
 * Turns what the model believes into a concrete schedule of thermostat setpoints
 * for one sleeper and one night.
 *
 * Shape of a night (times scale with the length of the sleep window):
 *
 *   wind-down  room is brought to the falling-asleep temperature before bedtime
 *   onset      slightly above the core temperature while falling asleep
 *   deep       the core temperature: the coolest part of the night
 *   rem        slightly warmer for late, REM-heavy sleep
 *   wake       warmed in two steps so getting up is easier (more so in winter)
 */

import { contextModifiers, modifierDelta, type Modifier, type NightContext } from './context';
import { estimateIdeal, explorationC as explorationFor, phaseOffset, type ThermalModelState } from './model';
import { HARD_LIMITS, type ComfortLimits, type Phase, type SleeperOptions } from './types';
import { clamp, HOUR, MIN, roundTo } from './util';

export interface PlanSegment {
  phase: Phase;
  startMs: number;
  endMs: number;
  targetC: number;
}

export interface NightPlan {
  kind: 'night' | 'nap';
  sleeperId?: string;
  bedtimeMs: number;
  wakeMs: number;
  /** Start of wind-down: when the platform takes control of the room. */
  startMs: number;
  /** When control is handed back to the thermostat's normal schedule. */
  endMs: number;
  seasonIndex: number;
  /** The model's estimate of the ideal core temperature when the plan was made. */
  idealC: number;
  idealSdC: number;
  confidence: number;
  /** Deliberate test variation added tonight while the model is still learning. */
  explorationC: number;
  /** Deep-sleep target after exploration, before tonight's context adjustments. */
  coreC: number;
  modifiers: Modifier[];
  segments: PlanSegment[];
}

export interface PlanInput {
  sleeperId?: string;
  model: ThermalModelState;
  limits: ComfortLimits;
  options: SleeperOptions;
  bedtimeMs: number;
  wakeMs: number;
  seasonIndex: number;
  context?: NightContext;
  /** Minutes before bedtime to start conditioning the room (learned from how fast the room responds). */
  windDownMin?: number;
  /** Minutes before the wake time to start warming. */
  wakeRampMin?: number;
  /**
   * The wake-up warming stops here, typically at or just above the home's
   * daytime setting: warming a bedroom past the temperature the household is
   * comfortable at when awake wastes energy for no comfort. It never pulls the
   * wake-up below the late-sleep temperature.
   */
  wakeCapC?: number;
  /** Thermostat setpoint resolution. */
  stepC?: number;
}

const AFTER_WAKE_HOLD = 15 * MIN;

export function effectiveLimits(limits: ComfortLimits): ComfortLimits {
  const minC = clamp(limits.minC, HARD_LIMITS.minC, HARD_LIMITS.maxC);
  const maxC = clamp(limits.maxC, HARD_LIMITS.minC, HARD_LIMITS.maxC);
  return minC <= maxC ? { minC, maxC } : { minC: maxC, maxC: minC };
}

/** Snap a temperature to the thermostat's step and the user's comfort limits. */
export function settle(tempC: number, limits: ComfortLimits, stepC = 0.5): number {
  const { minC, maxC } = effectiveLimits(limits);
  return clamp(roundTo(tempC, stepC), Math.ceil(minC / stepC) * stepC, Math.floor(maxC / stepC) * stepC);
}

/** Join neighbouring segments that ask for the same thing. */
export function mergeSegments(segments: PlanSegment[]): PlanSegment[] {
  const out: PlanSegment[] = [];
  for (const seg of segments) {
    if (seg.endMs <= seg.startMs) continue;
    const last = out[out.length - 1];
    if (last && last.phase === seg.phase && last.targetC === seg.targetC && last.endMs === seg.startMs) {
      last.endMs = seg.endMs;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

export function buildNightPlan(input: PlanInput): NightPlan {
  const { model, options, bedtimeMs, wakeMs } = input;
  const duration = wakeMs - bedtimeMs;
  if (!(duration >= 2 * HOUR && duration <= 16 * HOUR)) {
    throw new Error('buildNightPlan: the sleep window must be between 2 and 16 hours');
  }
  const stepC = input.stepC ?? 0.5;
  const s = clamp(input.seasonIndex, -1, 1);
  const context = input.context ?? {};
  const modifiers = contextModifiers(context, options);
  const ideal = estimateIdeal(model, s);

  // While the estimate is uncertain, try half a degree either side of it; never on sick nights.
  const explorationC = options.explore && !context.recovery?.illness ? explorationFor(model, s) : 0;
  const coreC = ideal.coreC + explorationC;

  const target = (phase: Phase): number =>
    settle(coreC + phaseOffset(model, phase, s) + modifierDelta(modifiers, phase), input.limits, stepC);

  const windDown = clamp(input.windDownMin ?? 45, 20, 150) * MIN;
  const ramp = Math.min(clamp(input.wakeRampMin ?? 45, 20, 90) * MIN, duration / 4);
  const rampStart = wakeMs - ramp;
  const remStart = Math.min(bedtimeMs + 0.55 * duration, rampStart - 20 * MIN);
  const onsetEnd = Math.min(bedtimeMs + clamp(0.17 * duration, 45 * MIN, 90 * MIN), remStart - 20 * MIN);
  const endMs = wakeMs + AFTER_WAKE_HOLD;

  const remTarget = target('rem');
  const cap = input.wakeCapC === undefined ? Infinity : Math.max(settle(input.wakeCapC, input.limits, stepC), remTarget);
  const wakeTarget = Math.min(target('wake'), cap);
  const halfway = settle((remTarget + wakeTarget) / 2, input.limits, stepC);

  const segments = mergeSegments([
    { phase: 'windDown', startMs: bedtimeMs - windDown, endMs: bedtimeMs, targetC: target('onset') },
    { phase: 'onset', startMs: bedtimeMs, endMs: onsetEnd, targetC: target('onset') },
    { phase: 'deep', startMs: onsetEnd, endMs: remStart, targetC: target('deep') },
    { phase: 'rem', startMs: remStart, endMs: rampStart, targetC: remTarget },
    { phase: 'wake', startMs: rampStart, endMs: rampStart + ramp / 2, targetC: halfway },
    { phase: 'wake', startMs: rampStart + ramp / 2, endMs, targetC: wakeTarget },
  ]);

  return {
    kind: 'night',
    sleeperId: input.sleeperId,
    bedtimeMs,
    wakeMs,
    startMs: bedtimeMs - windDown,
    endMs,
    seasonIndex: s,
    idealC: ideal.coreC,
    idealSdC: ideal.sdC,
    confidence: ideal.confidence,
    explorationC,
    coreC,
    modifiers,
    segments,
  };
}

export interface NapInput {
  sleeperId?: string;
  model: ThermalModelState;
  limits: ComfortLimits;
  startMs: number;
  minutes: number;
  seasonIndex: number;
  stepC?: number;
}

/** A short plan for a nap: settle at the falling-asleep temperature, then warm to wake. */
export function buildNapPlan(input: NapInput): NightPlan {
  const minutes = clamp(input.minutes, 10, 180);
  const stepC = input.stepC ?? 0.5;
  const s = clamp(input.seasonIndex, -1, 1);
  const ideal = estimateIdeal(input.model, s);
  const endOfNap = input.startMs + minutes * MIN;
  const ramp = Math.min(10, minutes / 3) * MIN;
  const at = (phase: Phase): number => settle(ideal.coreC + phaseOffset(input.model, phase, s), input.limits, stepC);
  return {
    kind: 'nap',
    sleeperId: input.sleeperId,
    bedtimeMs: input.startMs,
    wakeMs: endOfNap,
    startMs: input.startMs,
    endMs: endOfNap + 5 * MIN,
    seasonIndex: s,
    idealC: ideal.coreC,
    idealSdC: ideal.sdC,
    confidence: ideal.confidence,
    explorationC: 0,
    coreC: ideal.coreC,
    modifiers: [],
    segments: mergeSegments([
      { phase: 'onset', startMs: input.startMs, endMs: endOfNap - ramp, targetC: at('onset') },
      { phase: 'wake', startMs: endOfNap - ramp, endMs: endOfNap + 5 * MIN, targetC: at('wake') },
    ]),
  };
}

/** The segment in force at time `t`, or undefined outside the plan. */
export function segmentAt(plan: NightPlan, t: number): PlanSegment | undefined {
  return plan.segments.find((seg) => t >= seg.startMs && t < seg.endMs);
}

export function phaseAt(plan: NightPlan, t: number): Phase | undefined {
  if (t < plan.startMs || t >= plan.endMs) return undefined;
  if (t < plan.bedtimeMs) return 'windDown';
  return segmentAt(plan, t)?.phase;
}

/**
 * Replace the algorithm's temperatures with a user-defined curve (a manual preset
 * such as "onset 20, deep 18, late night 19, wake 22"). Timing is kept.
 */
export function withPhaseTargets(
  plan: NightPlan,
  temps: Partial<Record<'onset' | 'deep' | 'rem' | 'wake', number>>,
  limits: ComfortLimits,
  stepC = 0.5,
): NightPlan {
  const segments = plan.segments.map((seg) => {
    const key = seg.phase === 'windDown' ? 'onset' : seg.phase;
    const wanted = temps[key];
    return wanted === undefined ? seg : { ...seg, targetC: settle(wanted, limits, stepC) };
  });
  return { ...plan, segments: mergeSegments(segments), explorationC: 0 };
}

/** How long the room needs to move `deltaC` degrees at its learned rate, with sensible bounds. */
export function leadMinutes(deltaC: number, rateCPerHour: number | undefined, min = 30, max = 120): number {
  if (!rateCPerHour || rateCPerHour <= 0) return clamp(45, min, max);
  return clamp((Math.abs(deltaC) / rateCPerHour) * 60, min, max);
}

/**
 * The moment-to-moment decision: what should the thermostat be set to right now?
 *
 * Order of authority, highest first:
 *   1. A hold: the user set a temperature by hand (app, voice, or at the
 *      thermostat itself) or activated a fixed-temperature preset.
 *   2. The night plan, nudged by any live adjustment.
 *   3. Nothing: outside a plan the platform leaves the thermostat alone.
 *
 * The user always wins. A hold is limited only by the absolute safety bounds,
 * not by the comfort range that constrains the automation.
 */

import { roomSegmentAt, type RoomPlan } from './couples';
import { settle } from './plan';
import { HARD_LIMITS, type Phase } from './types';

export type HoldSource = 'app' | 'voice' | 'device' | 'preset';

export interface Hold {
  targetC: number;
  source: HoldSource;
  startMs: number;
  /** When the hold lapses; null means it lasts until the current plan ends. */
  untilMs: number | null;
  sleeperId?: string;
  presetName?: string;
}

export interface ControlInput {
  t: number;
  plan: RoomPlan | null;
  hold: Hold | null;
  liveOffsetC: number;
  stepC?: number;
}

export interface ControlDecision {
  /** Setpoint to send, or null when the platform is not controlling the room. */
  targetC: number | null;
  source: 'hold' | 'plan' | 'idle';
  phase?: Phase;
  /** What the plan alone asks for at this moment. */
  plannedC?: number;
  liveOffsetC: number;
}

export function holdActive(hold: Hold | null, t: number, plan: RoomPlan | null): hold is Hold {
  if (!hold || t < hold.startMs) return false;
  if (hold.untilMs !== null) return t < hold.untilMs;
  return plan === null || t < plan.endMs;
}

export function decideSetpoint(input: ControlInput): ControlDecision {
  const stepC = input.stepC ?? 0.5;
  const segment = input.plan ? roomSegmentAt(input.plan, input.t) : undefined;

  if (holdActive(input.hold, input.t, input.plan)) {
    return {
      targetC: settle(input.hold.targetC, HARD_LIMITS, stepC),
      source: 'hold',
      phase: segment?.phase,
      plannedC: segment?.targetC,
      liveOffsetC: 0,
    };
  }
  if (input.plan && segment) {
    return {
      targetC: settle(segment.targetC + input.liveOffsetC, input.plan.limits, stepC),
      source: 'plan',
      phase: segment.phase,
      plannedC: segment.targetC,
      liveOffsetC: input.liveOffsetC,
    };
  }
  return { targetC: null, source: 'idle', liveOffsetC: 0 };
}

/**
 * "Too warm" / "too cold" during the night. Saying how you feel is not manual
 * control: it always moves the room, whatever the household's settings.
 *
 * The first complaint moves the room 1.5 degrees; another in the same direction
 * adds half a degree, up to 2 in all. A complaint the other way after a
 * correction (one partner too warm, the other then too cold) steps back by one
 * degree, so the two meet in the middle instead of see-sawing.
 */
export const COMFORT = { firstC: 1.5, againC: 0.5, maxC: 2, backC: 1 } as const;

/** The room's comfort correction after one more complaint, in degrees (negative is cooler). */
export function comfortCorrection(currentC: number, feeling: 'tooHot' | 'tooCold'): number {
  const dir = feeling === 'tooHot' ? -1 : 1;
  const along = currentC * dir; // > 0: already corrected the way this person wants
  let next: number;
  if (along < 0) next = currentC + dir * COMFORT.backC;
  else if (along === 0) next = dir * COMFORT.firstC;
  else next = currentC + dir * COMFORT.againC;
  return Math.max(-COMFORT.maxC, Math.min(COMFORT.maxC, Math.round(next * 2) / 2));
}

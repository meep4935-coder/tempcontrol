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

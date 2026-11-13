/**
 * In-night adjustments.
 *
 * The plan is made before bed. This controller watches the sleepers during the
 * night and nudges the plan when their bodies say it is off: restless and warm
 * means cool a little, restless and cold means warm a little, and a hot flash
 * (for those who switch that mode on) triggers a short burst of cooling.
 *
 * It only acts on live readings. Wearables that upload once in the morning give
 * it nothing to work with, so for those the plan runs as made and the learning
 * happens overnight-to-overnight instead.
 *
 * The rules are deliberately conservative and rate-limited: small steps, a cap
 * on the total nudge, a pause between changes, and in a shared bed one person's
 * discomfort moves the room less while their partner is sleeping calmly.
 *
 * A nudge stays in place for the rest of the night. If it overshoots, the same
 * rules nudge back; easing off on a timer would only bring the discomfort back
 * whenever its cause was the plan itself.
 */

import type { LiveVitals, Phase } from './types';
import { clamp, mean, MIN } from './util';

export interface LiveSleeperInput {
  id: string;
  /** Null when the wearable has no live reading to offer. */
  vitals: LiveVitals | null;
  /** In bed and meant to be asleep at this moment. */
  inBed: boolean;
  menopauseMode: boolean;
}

export interface LiveInput {
  t: number;
  phase: Phase | undefined;
  roomTempC: number;
  /** The planned target at this moment, before any live nudge. */
  targetC: number;
  sleepers: LiveSleeperInput[];
}

/**
 * Why the controller acted:
 *  - restlessWarm / restlessCold: the room was nudged cooler / warmer;
 *  - hotFlash / hotFlashOver: a burst of cooling for a hot flash began / ended.
 */
export type LiveReason = 'restlessWarm' | 'restlessCold' | 'hotFlash' | 'hotFlashOver';

export interface LiveEvent {
  t: number;
  reason: LiveReason;
  /** Change applied to the nudge by this event. */
  deltaC: number;
  /** Total nudge after the event. */
  offsetC: number;
  sleeperId?: string;
}

interface Reading {
  t: number;
  movement?: number;
  skin?: number;
  hr?: number;
}

export interface LiveState {
  /** Standing nudge applied to the planned target. */
  offsetC: number;
  lastChangeMs: number | null;
  changes: number;
  /** A hot-flash response in progress: `deltaC` of extra room cooling until it ends. */
  boost: { untilMs: number; deltaC: number; sleeperId: string } | null;
  lastBoostMs: number | null;
  readings: Record<string, Reading[]>;
}

export const LIVE_LIMITS = {
  stepC: 0.5,
  minOffsetC: -1.5,
  maxOffsetC: 1.0,
  /** Cap on the nudge when only one of two partners is uncomfortable. */
  soloOffsetC: 0.5,
  minGapMs: 20 * MIN,
  maxChanges: 6,
  windowMs: 15 * MIN,
  restlessMovement: 0.25,
  boostC: -1.5,
  boostSharedC: -1.0,
  /** Longest a hot-flash response runs; it ends sooner once skin temperature comes back down. */
  boostMs: 20 * MIN,
  boostGapMs: 30 * MIN,
  /** Skin temperature at or below this (relative to baseline) means the flash has passed. */
  flashOverSkinC: 0.3,
} as const;

export function createLiveState(): LiveState {
  return { offsetC: 0, lastChangeMs: null, changes: 0, boost: null, lastBoostMs: null, readings: {} };
}

/** The nudge in force right now, including any cooling burst. */
export function liveOffset(state: LiveState, t: number): number {
  return state.offsetC + (state.boost && t < state.boost.untilMs ? state.boost.deltaC : 0);
}

type Want = -1 | 0 | 1;

interface Assessment {
  id: string;
  restless: boolean;
  want: Want;
  hotFlash: boolean;
}

function assess(input: LiveInput, sleeper: LiveSleeperInput, window: Reading[], effectiveTargetC: number): Assessment {
  const none: Assessment = { id: sleeper.id, restless: false, want: 0, hotFlash: false };
  if (window.length < 2) return none;

  const movement = window.map((r) => r.movement).filter((v): v is number => v !== undefined);
  const restless = movement.length >= 2 && mean(movement) >= LIVE_LIMITS.restlessMovement;

  const latest = window[window.length - 1]!;
  const baseline = sleeper.vitals?.heartRateBaseline;
  const heartRateUp = latest.hr !== undefined && baseline !== undefined && latest.hr - baseline >= 6;
  let warm: boolean;
  let cold: boolean;
  if (latest.skin !== undefined) {
    // Skin temperature is the most direct sign, so when a device reports it, it decides.
    cold = latest.skin <= -0.3;
    warm = !cold && (latest.skin >= 0.3 || heartRateUp);
  } else {
    // Otherwise fall back on how far the room is from where it was asked to be.
    const roomError = input.roomTempC - effectiveTargetC;
    cold = roomError <= -0.75;
    warm = !cold && (roomError >= 0.75 || heartRateUp);
  }

  // A hot flash shows up as skin temperature climbing fast, usually with a jump in heart rate.
  let hotFlash = false;
  if (sleeper.menopauseMode) {
    const recent = window.filter((r) => r.t >= input.t - 10 * MIN);
    const skins = recent.map((r) => r.skin).filter((v): v is number => v !== undefined);
    const hrs = recent.map((r) => r.hr).filter((v): v is number => v !== undefined);
    const skinRise = skins.length >= 2 ? skins[skins.length - 1]! - Math.min(...skins) : 0;
    const hrRise = hrs.length >= 2 ? hrs[hrs.length - 1]! - Math.min(...hrs) : 0;
    hotFlash = skinRise >= 0.5 || (hrRise >= 12 && restless && warm);
  }

  const want: Want = restless && warm && !cold ? -1 : restless && cold && !warm ? 1 : 0;
  return { id: sleeper.id, restless, want, hotFlash };
}

export interface LiveDecision {
  state: LiveState;
  /** Nudge to apply to the planned target right now. */
  offsetC: number;
  events: LiveEvent[];
}

/** Feed one round of readings; get back the nudge to apply and anything worth logging. */
export function liveStep(prev: LiveState, input: LiveInput): LiveDecision {
  const { t } = input;
  const events: LiveEvent[] = [];
  const state: LiveState = { ...prev, readings: { ...prev.readings } };

  for (const sleeper of input.sleepers) {
    const kept = (state.readings[sleeper.id] ?? []).filter((r) => r.t > t - LIVE_LIMITS.windowMs);
    if (sleeper.vitals && sleeper.inBed) {
      kept.push({ t, movement: sleeper.vitals.movement, skin: sleeper.vitals.skinTempDeltaC, hr: sleeper.vitals.heartRate });
    }
    state.readings[sleeper.id] = kept;
  }

  if (state.boost) {
    const skin = input.sleepers.find((s) => s.id === state.boost!.sleeperId)?.vitals?.skinTempDeltaC;
    const subsided = skin !== undefined && skin <= LIVE_LIMITS.flashOverSkinC;
    if (t >= state.boost.untilMs || subsided) {
      events.push({ t, reason: 'hotFlashOver', deltaC: -state.boost.deltaC, offsetC: state.offsetC, sleeperId: state.boost.sleeperId });
      state.boost = null;
    }
  }

  // Only steer while people are asleep: never fight the wind-down or the wake-up warming.
  const asleepPhase = input.phase === 'onset' || input.phase === 'deep' || input.phase === 'rem';
  const watched = input.sleepers.filter((s) => s.inBed && s.vitals !== null);
  if (!asleepPhase || watched.length === 0) {
    return { state, offsetC: liveOffset(state, t), events };
  }

  const effectiveTarget = input.targetC + liveOffset(state, t);
  const assessments = watched.map((s) => assess(input, s, state.readings[s.id] ?? [], effectiveTarget));
  const othersInBed = input.sleepers.filter((s) => s.inBed).length > 1;

  const flash = assessments.find((a) => a.hotFlash);
  const boostReady = !state.boost && (state.lastBoostMs === null || t - state.lastBoostMs >= LIVE_LIMITS.boostGapMs);
  if (flash && boostReady) {
    // Gentler when a partner shares the room.
    const deltaC = othersInBed ? LIVE_LIMITS.boostSharedC : LIVE_LIMITS.boostC;
    state.boost = { untilMs: t + LIVE_LIMITS.boostMs, deltaC, sleeperId: flash.id };
    state.lastBoostMs = t;
    events.push({ t, reason: 'hotFlash', deltaC, offsetC: state.offsetC, sleeperId: flash.id });
    return { state, offsetC: liveOffset(state, t), events };
  }

  const canChange =
    !state.boost &&
    state.changes < LIVE_LIMITS.maxChanges &&
    (state.lastChangeMs === null || t - state.lastChangeMs >= LIVE_LIMITS.minGapMs);
  if (!canChange) return { state, offsetC: liveOffset(state, t), events };

  const wantsCooler = assessments.filter((a) => a.want === -1);
  const wantsWarmer = assessments.filter((a) => a.want === 1);
  let direction: Want = 0;
  if (wantsCooler.length > 0 && wantsWarmer.length === 0) direction = -1;
  else if (wantsWarmer.length > 0 && wantsCooler.length === 0) direction = 1;

  if (direction !== 0) {
    const asking = direction === -1 ? wantsCooler : wantsWarmer;
    // With a calm partner in the bed, one person's discomfort moves the room less.
    const unanimous = !othersInBed || asking.length === input.sleepers.filter((s) => s.inBed).length;
    const lo = unanimous ? LIVE_LIMITS.minOffsetC : -LIVE_LIMITS.soloOffsetC;
    const hi = unanimous ? LIVE_LIMITS.maxOffsetC : LIVE_LIMITS.soloOffsetC;
    const next = clamp(state.offsetC + direction * LIVE_LIMITS.stepC, Math.min(lo, state.offsetC), Math.max(hi, state.offsetC));
    if (next !== state.offsetC) {
      events.push({
        t,
        reason: direction === -1 ? 'restlessWarm' : 'restlessCold',
        deltaC: next - state.offsetC,
        offsetC: next,
        sleeperId: asking[0]!.id,
      });
      state.offsetC = next;
      state.lastChangeMs = t;
      state.changes += 1;
    }
  }
  return { state, offsetC: liveOffset(state, t), events };
}

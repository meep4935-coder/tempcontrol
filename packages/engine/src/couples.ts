/**
 * One room, one thermostat, possibly two sleepers who want different things.
 *
 * Each sleeper gets their own plan from their own model. This module blends
 * those plans into the single schedule the room's thermostat follows:
 *
 *  - at every moment the target is a weighted average of what each person in
 *    the room wants then, so a partner who is already asleep is not woken by
 *    the other's wake-up warming, and vice versa;
 *  - the weight is each person's temperature sensitivity (someone whose sleep
 *    suffers more from being off-target gets more say), with a floor so that
 *    nobody is ignored;
 *  - someone still winding down, or already up, counts for half.
 *
 * A room with a single sleeper goes through the same function unchanged, so
 * the control loop only ever deals with a RoomPlan.
 */

import { effectiveLimits, settle, type NightPlan, segmentAt } from './plan';
import type { ComfortLimits, Phase } from './types';

export interface SleeperPlan {
  plan: NightPlan;
  limits: ComfortLimits;
  /** Relative say in the compromise; normally the sleeper's temperature sensitivity. */
  weight: number;
}

export interface Contribution {
  sleeperId: string;
  phase: Phase;
  /** What this sleeper's own plan asks for during the segment. */
  targetC: number;
  /** Share of the decision, 0..1. */
  share: number;
}

export interface RoomSegment {
  phase: Phase;
  startMs: number;
  endMs: number;
  targetC: number;
  contributions: Contribution[];
}

export interface RoomPlan {
  kind: 'night' | 'nap';
  startMs: number;
  endMs: number;
  segments: RoomSegment[];
  /** The individual plans this room plan was built from. */
  sleepers: NightPlan[];
  /** Difference between the warmest and coolest sleeper's ideal temperature. */
  gapC: number;
  /** Limits every sleeper in the room accepts. */
  limits: ComfortLimits;
}

/** No sleeper's share of a two-person decision drops below this. */
const MIN_SHARE = 0.3;

function baseShares(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + Math.max(b, 0), 0);
  if (weights.length === 1 || total <= 0) return weights.map(() => 1 / weights.length);
  const floor = Math.min(MIN_SHARE, 1 / weights.length);
  const raw = weights.map((w) => Math.max(w, 0) / total);
  // Lift anyone below the floor, taking the difference proportionally from the rest.
  const lifted = raw.map((r) => Math.max(r, floor));
  const excess = lifted.reduce((a, b) => a + b, 0) - 1;
  const room = lifted.reduce((a, r) => a + (r - floor), 0);
  return room <= 0 ? lifted.map(() => 1 / weights.length) : lifted.map((r) => r - (excess * (r - floor)) / room);
}

/** Limits acceptable to everyone; if they do not overlap, meet in the middle. */
export function sharedLimits(all: ComfortLimits[]): ComfortLimits {
  const each = all.map(effectiveLimits);
  const minC = Math.max(...each.map((l) => l.minC));
  const maxC = Math.min(...each.map((l) => l.maxC));
  if (minC <= maxC) return { minC, maxC };
  const mid = (minC + maxC) / 2;
  return { minC: mid, maxC: mid };
}

export function buildRoomPlan(sleepers: SleeperPlan[], stepC = 0.5): RoomPlan {
  if (sleepers.length === 0) throw new Error('buildRoomPlan: at least one sleeper is required');
  const limits = sharedLimits(sleepers.map((s) => s.limits));
  const shares = baseShares(sleepers.map((s) => s.weight));

  const cuts = new Set<number>();
  for (const { plan } of sleepers) {
    cuts.add(plan.bedtimeMs).add(plan.wakeMs);
    for (const seg of plan.segments) cuts.add(seg.startMs).add(seg.endMs);
  }
  const times = [...cuts].sort((a, b) => a - b);

  const segments: RoomSegment[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const startMs = times[i]!;
    const endMs = times[i + 1]!;
    const mid = (startMs + endMs) / 2;

    const present = sleepers
      .map((sleeper, index) => ({ sleeper, index, seg: segmentAt(sleeper.plan, mid) }))
      .filter((p) => p.seg !== undefined);
    if (present.length === 0) continue;

    const inBed = (p: (typeof present)[number]): boolean => mid >= p.sleeper.plan.bedtimeMs && mid < p.sleeper.plan.wakeMs;
    const someoneAsleep = present.some(inBed);
    const raw = present.map((p) => shares[p.index]! * (someoneAsleep && !inBed(p) ? 0.5 : 1));
    const total = raw.reduce((a, b) => a + b, 0);

    const contributions: Contribution[] = present.map((p, k) => ({
      sleeperId: p.sleeper.plan.sleeperId ?? String(p.index),
      phase: p.seg!.phase,
      targetC: p.seg!.targetC,
      share: raw[k]! / total,
    }));
    const blended = contributions.reduce((sum, c) => sum + c.share * c.targetC, 0);
    const lead = contributions.reduce((a, b) => (b.share > a.share ? b : a));

    const segment: RoomSegment = { phase: lead.phase, startMs, endMs, targetC: settle(blended, limits, stepC), contributions };
    const last = segments[segments.length - 1];
    if (last && last.endMs === startMs && sameDecision(last, segment)) last.endMs = endMs;
    else segments.push(segment);
  }

  const ideals = sleepers.map((s) => s.plan.idealC);
  return {
    kind: sleepers.every((s) => s.plan.kind === 'nap') ? 'nap' : 'night',
    startMs: segments[0]!.startMs,
    endMs: segments[segments.length - 1]!.endMs,
    segments,
    sleepers: sleepers.map((s) => s.plan),
    gapC: Math.max(...ideals) - Math.min(...ideals),
    limits,
  };
}

function sameDecision(a: RoomSegment, b: RoomSegment): boolean {
  if (a.phase !== b.phase || a.targetC !== b.targetC || a.contributions.length !== b.contributions.length) return false;
  return a.contributions.every((c, i) => {
    const d = b.contributions[i]!;
    return c.sleeperId === d.sleeperId && c.phase === d.phase && c.targetC === d.targetC && Math.abs(c.share - d.share) < 1e-9;
  });
}

export function roomSegmentAt(plan: RoomPlan, t: number): RoomSegment | undefined {
  return plan.segments.find((seg) => t >= seg.startMs && t < seg.endMs);
}

export interface PersonalCooling {
  sleeperId: string;
  startMs: number;
  endMs: number;
  /** Suggested fan speed, 1 (gentle) to 3. */
  level: 1 | 2 | 3;
}

/**
 * Times when the room's compromise is noticeably warmer than one sleeper wants.
 * A personal fan on that side of the bed can make up the difference without
 * cooling the room for their partner.
 */
export function personalCooling(plan: RoomPlan, thresholdC = 0.75): PersonalCooling[] {
  const out: PersonalCooling[] = [];
  const open = new Map<string, PersonalCooling>();
  for (const seg of plan.segments) {
    for (const c of seg.contributions) {
      const shortfall = seg.targetC - c.targetC;
      if (c.phase === 'windDown' || c.phase === 'wake' || shortfall < thresholdC) continue;
      const level = shortfall >= 2.5 ? 3 : shortfall >= 1.5 ? 2 : 1;
      const last = open.get(c.sleeperId);
      if (last && last.endMs === seg.startMs && last.level === level) {
        last.endMs = seg.endMs;
      } else {
        const entry: PersonalCooling = { sleeperId: c.sleeperId, startMs: seg.startMs, endMs: seg.endMs, level };
        open.set(c.sleeperId, entry);
        out.push(entry);
      }
    }
  }
  return out;
}

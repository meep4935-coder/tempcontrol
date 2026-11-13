import { describe, expect, it } from 'vitest';
import {
  buildNightPlan,
  buildRoomPlan,
  createModel,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  HOUR,
  MIN,
  observePreference,
  roomSegmentAt,
  sharedLimits,
  zonedTimeToMs,
  type NightPlan,
  type ThermalModelState,
} from '../src/index';

const TZ = 'America/Toronto';
const at = (date: string, time: string): number => zonedTimeToMs(date, time, TZ);

function modelPreferring(tempC: number): ThermalModelState {
  let model = createModel();
  for (let i = 0; i < 10; i++) model = observePreference(model, { kind: 'override', tempC, phase: 'deep', seasonIndex: 0 });
  return model;
}

function planFor(id: string, tempC: number, bed = '22:45', wake = '06:45', seasonIndex = 0): NightPlan {
  return buildNightPlan({
    sleeperId: id,
    model: modelPreferring(tempC),
    limits: DEFAULT_LIMITS,
    options: { ...DEFAULT_OPTIONS, explore: false },
    bedtimeMs: at('2026-11-13', bed),
    wakeMs: at('2026-11-14', wake),
    seasonIndex,
  });
}

const sleeper = (plan: NightPlan, weight = 1) => ({ plan, limits: DEFAULT_LIMITS, weight });

describe('shared room', () => {
  it('leaves a single sleeper\'s plan unchanged', () => {
    const plan = planFor('a', 19);
    const room = buildRoomPlan([sleeper(plan)]);
    expect(room.segments.map((s) => [s.phase, s.startMs, s.endMs, s.targetC])).toEqual(plan.segments.map((s) => [s.phase, s.startMs, s.endMs, s.targetC]));
    expect(room.gapC).toBe(0);
    expect(room.startMs).toBe(plan.startMs);
    expect(room.endMs).toBe(plan.endMs);
  });

  it('meets in the middle for partners with equal say', () => {
    const room = buildRoomPlan([sleeper(planFor('a', 17)), sleeper(planFor('b', 21))]);
    const deep = roomSegmentAt(room, at('2026-11-14', '02:00'))!;
    expect(deep.targetC).toBe(19);
    expect(deep.contributions.map((c) => c.share)).toEqual([0.5, 0.5]);
    expect(room.gapC).toBeCloseTo(4, 0);
  });

  it('gives the more temperature-sensitive partner more say, but never all of it', () => {
    const room = buildRoomPlan([sleeper(planFor('a', 17), 3), sleeper(planFor('b', 21), 1)]);
    const deep = roomSegmentAt(room, at('2026-11-14', '02:00'))!;
    expect(deep.targetC).toBe(18);
    expect(deep.contributions[0]!.share).toBeCloseTo(0.7, 6);

    const lopsided = buildRoomPlan([sleeper(planFor('a', 17), 100), sleeper(planFor('b', 21), 1)]);
    const share = roomSegmentAt(lopsided, at('2026-11-14', '02:00'))!.contributions[1]!.share;
    expect(share).toBeCloseTo(0.3, 6);
  });

  it('covers the whole span without gaps when bedtimes differ', () => {
    const early = planFor('a', 18, '21:30', '05:30');
    const late = planFor('b', 20, '23:30', '07:30');
    const room = buildRoomPlan([sleeper(early), sleeper(late)]);
    expect(room.startMs).toBe(early.startMs);
    expect(room.endMs).toBe(late.endMs);
    for (let i = 1; i < room.segments.length; i++) expect(room.segments[i]!.startMs).toBe(room.segments[i - 1]!.endMs);
  });

  it('follows whoever is alone in the room', () => {
    const early = planFor('a', 18, '21:30', '05:30');
    const late = planFor('b', 20, '23:30', '07:30');
    const room = buildRoomPlan([sleeper(early), sleeper(late)]);
    // 22:00: only the early sleeper is in the plan at all.
    const alone = roomSegmentAt(room, at('2026-11-13', '22:00'))!;
    expect(alone.contributions.map((c) => c.sleeperId)).toEqual(['a']);
    expect(alone.targetC).toBe(early.segments.find((s) => s.phase === 'onset')!.targetC);
    // 07:00: the early sleeper is long up; the late sleeper's wake-up applies in full.
    const morning = roomSegmentAt(room, at('2026-11-14', '07:00'))!;
    expect(morning.contributions.map((c) => c.sleeperId)).toEqual(['b']);
  });

  it('halves the say of a partner who is winding down or already up', () => {
    const early = planFor('a', 18, '21:30', '05:30');
    const late = planFor('b', 20, '23:30', '07:30');
    const room = buildRoomPlan([sleeper(early), sleeper(late)]);
    // 23:00: a asleep, b winding down.
    const evening = roomSegmentAt(room, at('2026-11-13', '23:00'))!;
    expect(evening.contributions.find((c) => c.sleeperId === 'a')!.share).toBeCloseTo(2 / 3, 6);
    expect(evening.contributions.find((c) => c.sleeperId === 'b')!.phase).toBe('windDown');
    // 05:35: a is up (holding wake warmth), b still asleep and gets the larger say.
    const dawn = roomSegmentAt(room, at('2026-11-14', '05:35'))!;
    expect(dawn.contributions.find((c) => c.sleeperId === 'b')!.share).toBeCloseTo(2 / 3, 6);
  });

  it('softens one partner\'s wake-up warming while the other sleeps', () => {
    // Midwinter, when the wake-up warming is at its largest.
    const early = planFor('a', 19, '21:30', '05:30', 1);
    const late = planFor('b', 19, '23:30', '07:30', 1);
    const room = buildRoomPlan([sleeper(early), sleeper(late)]);
    const ownWake = early.segments[early.segments.length - 1]!.targetC;
    const shared = roomSegmentAt(room, at('2026-11-14', '05:25'))!.targetC;
    const lateAsleep = late.segments.find((s) => s.phase === 'rem')!.targetC;
    expect(shared).toBeLessThan(ownWake);
    expect(shared).toBeGreaterThanOrEqual(lateAsleep);
  });

  it('respects limits both partners accept', () => {
    expect(sharedLimits([{ minC: 16, maxC: 22 }, { minC: 18, maxC: 25 }])).toEqual({ minC: 18, maxC: 22 });
    expect(sharedLimits([{ minC: 16, maxC: 18 }, { minC: 20, maxC: 24 }])).toEqual({ minC: 19, maxC: 19 });
    const cool = planFor('a', 16);
    const room = buildRoomPlan([
      { plan: cool, limits: DEFAULT_LIMITS, weight: 1 },
      { plan: planFor('b', 16.5), limits: { minC: 18, maxC: 24 }, weight: 1 },
    ]);
    for (const seg of room.segments) expect(seg.targetC).toBeGreaterThanOrEqual(18);
  });

  it('does not flick the thermostat half a degree for a short spell', () => {
    // Different bedtimes make the blend shift several times in the evening.
    const room = buildRoomPlan([sleeper(planFor('a', 17, '22:30', '06:30'), 1), sleeper(planFor('b', 19, '23:15', '07:00'), 1.1)]);
    for (let i = 1; i + 1 < room.segments.length; i++) {
      const [before, seg, after] = [room.segments[i - 1]!, room.segments[i]!, room.segments[i + 1]!];
      const blip = seg.endMs - seg.startMs < 60 * MIN && before.targetC === after.targetC && seg.targetC !== before.targetC && Math.abs(seg.targetC - before.targetC) <= 0.5;
      expect(blip).toBe(false);
    }
  });

  it('handles three sleepers and rejects none', () => {
    const room = buildRoomPlan([sleeper(planFor('a', 17)), sleeper(planFor('b', 19)), sleeper(planFor('c', 21))]);
    const deep = roomSegmentAt(room, at('2026-11-14', '02:00'))!;
    expect(deep.targetC).toBe(19);
    expect(deep.contributions.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 9);
    expect(() => buildRoomPlan([])).toThrow();
  });

  it('keeps total duration sensible', () => {
    const room = buildRoomPlan([sleeper(planFor('a', 18)), sleeper(planFor('b', 20))]);
    expect(room.endMs - room.startMs).toBe(8 * HOUR + 45 * MIN + 15 * MIN);
  });
});

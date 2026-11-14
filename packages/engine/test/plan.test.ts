import { describe, expect, it } from 'vitest';
import {
  buildNapPlan,
  buildNightPlan,
  buildRoomPlan,
  contextModifiers,
  createModel,
  cyclePhaseOn,
  decideSetpoint,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  deriveRecovery,
  effectiveLimits,
  HARD_LIMITS,
  holdActive,
  HOUR,
  isConfoundedNight,
  leadMinutes,
  MIN,
  modifierDelta,
  observePreference,
  observeNight,
  phaseAt,
  segmentAt,
  settle,
  withPhaseTargets,
  zonedTimeToMs,
  type Hold,
  type NightPlan,
  type PlanInput,
} from '../src/index';

const TZ = 'America/Toronto';
const bedtimeMs = zonedTimeToMs('2026-11-13', '22:45', TZ);
const wakeMs = zonedTimeToMs('2026-11-14', '06:45', TZ);

/** Exploration is off by default here so targets are exact; the tests that concern it turn it on. */
const STEADY = { ...DEFAULT_OPTIONS, explore: false };

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  sleeperId: 'a',
  model: createModel(),
  limits: DEFAULT_LIMITS,
  options: STEADY,
  bedtimeMs,
  wakeMs,
  seasonIndex: 0,
  ...over,
});

const targetOf = (plan: NightPlan, phase: string): number => plan.segments.find((s) => s.phase === phase)!.targetC;
const lastTarget = (plan: NightPlan): number => plan.segments[plan.segments.length - 1]!.targetC;

describe('night plan', () => {
  it('covers the night without gaps, in order', () => {
    const plan = buildNightPlan(input());
    expect(plan.segments[0]!.startMs).toBe(plan.startMs);
    expect(plan.segments[plan.segments.length - 1]!.endMs).toBe(plan.endMs);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i]!.startMs).toBe(plan.segments[i - 1]!.endMs);
      expect(plan.segments[i]!.endMs).toBeGreaterThan(plan.segments[i]!.startMs);
    }
    expect(plan.segments.map((s) => s.phase).filter((p, i, a) => a.indexOf(p) === i)).toEqual(['windDown', 'onset', 'deep', 'rem', 'wake']);
    expect(plan.startMs).toBe(bedtimeMs - 45 * MIN);
    expect(plan.endMs).toBe(wakeMs + 15 * MIN);
  });

  it('works from night one: a fresh model yields the typical-adult curve', () => {
    const plan = buildNightPlan(input({ options: { ...DEFAULT_OPTIONS, explore: false } }));
    expect(plan.confidence).toBe(0);
    expect(plan.explorationC).toBe(0);
    expect(targetOf(plan, 'windDown')).toBe(19);
    expect(targetOf(plan, 'onset')).toBe(19);
    expect(targetOf(plan, 'deep')).toBe(18.5);
    expect(targetOf(plan, 'rem')).toBe(19);
    expect(lastTarget(plan)).toBe(19.5);
  });

  it('is coolest in deep sleep and warmest at wake-up', () => {
    const plan = buildNightPlan(input());
    const deep = targetOf(plan, 'deep');
    for (const seg of plan.segments) expect(seg.targetC).toBeGreaterThanOrEqual(deep);
    expect(lastTarget(plan)).toBe(Math.max(...plan.segments.map((s) => s.targetC)));
  });

  it('warms winter mornings more than summer mornings', () => {
    const winter = buildNightPlan(input({ seasonIndex: 1 }));
    const summer = buildNightPlan(input({ seasonIndex: -1 }));
    expect(lastTarget(winter) - lastTarget(summer)).toBe(1.5);
    expect(targetOf(winter, 'deep')).toBe(targetOf(summer, 'deep'));
    // The winter warm-up is taken in two steps.
    expect(winter.segments.filter((s) => s.phase === 'wake').length).toBe(2);
  });

  it('stops the wake-up warming at a cap, but never below the late-sleep temperature', () => {
    const uncapped = buildNightPlan(input({ seasonIndex: 1 }));
    expect(lastTarget(uncapped)).toBe(21);
    expect(lastTarget(buildNightPlan(input({ seasonIndex: 1, wakeCapC: 20 })))).toBe(20);
    // A cap above what the plan wants changes nothing.
    expect(lastTarget(buildNightPlan(input({ seasonIndex: 1, wakeCapC: 24 })))).toBe(21);
    // A cap below the late-sleep temperature cannot cool the morning.
    const low = buildNightPlan(input({ seasonIndex: 1, wakeCapC: 16 }));
    expect(lastTarget(low)).toBe(targetOf(low, 'rem'));
    // Winter mornings stay warmer than summer ones under the same cap.
    expect(lastTarget(buildNightPlan(input({ seasonIndex: 1, wakeCapC: 20.5 })))).toBeGreaterThan(lastTarget(buildNightPlan(input({ seasonIndex: -1, wakeCapC: 20.5 }))));
  });

  it('keeps every target on the thermostat step and inside the comfort limits', () => {
    const limits = { minC: 18.2, maxC: 19.3 };
    const plan = buildNightPlan(input({ limits, seasonIndex: 1 }));
    for (const seg of plan.segments) {
      expect(seg.targetC).toBeGreaterThanOrEqual(18.5);
      expect(seg.targetC).toBeLessThanOrEqual(19);
      expect((seg.targetC * 2) % 1).toBe(0);
    }
  });

  it('never leaves the absolute safety bounds, whatever the user limits say', () => {
    expect(effectiveLimits({ minC: -5, maxC: 60 })).toEqual(HARD_LIMITS);
    expect(effectiveLimits({ minC: 24, maxC: 18 })).toEqual({ minC: 18, maxC: 24 });
    expect(settle(40, { minC: -5, maxC: 60 })).toBe(28);
    expect(settle(2, { minC: -5, maxC: 60 })).toBe(12);
  });

  it('follows what the model has learned', () => {
    let model = createModel();
    for (let i = 0; i < 8; i++) model = observePreference(model, { kind: 'override', tempC: 21, phase: 'deep', seasonIndex: 0 });
    const plan = buildNightPlan(input({ model }));
    expect(targetOf(plan, 'deep')).toBe(21);
    expect(plan.confidence).toBeGreaterThan(0.5);
  });

  it('tests half a degree either side while unsure, and not at all when told not to', () => {
    let model = createModel();
    const cores: number[] = [];
    for (let night = 0; night < 8; night++) {
      const plan = buildNightPlan(input({ model, options: DEFAULT_OPTIONS }));
      expect(Math.abs(plan.explorationC)).toBe(0.5);
      cores.push(targetOf(plan, 'deep'));
      model = observeNight(model, { experiencedCoreC: 18.5, seasonIndex: 0, quality: 75 });
    }
    expect(Math.min(...cores)).toBeGreaterThanOrEqual(17.5);
    expect(Math.max(...cores)).toBeLessThanOrEqual(19.5);
    expect(new Set(cores).size).toBe(2);

    const off = buildNightPlan(input({ options: { ...DEFAULT_OPTIONS, explore: false } }));
    expect(off.explorationC).toBe(0);
    const sick = buildNightPlan(input({ options: DEFAULT_OPTIONS, context: { recovery: { illness: true } } }));
    expect(sick.explorationC).toBe(0);
  });

  it('starts the wind-down and wake-up earlier when asked to', () => {
    const plan = buildNightPlan(input({ windDownMin: 90, wakeRampMin: 60 }));
    expect(plan.startMs).toBe(bedtimeMs - 90 * MIN);
    expect(plan.segments.find((s) => s.phase === 'wake')!.startMs).toBe(wakeMs - 60 * MIN);
  });

  it('handles short and long sleep windows', () => {
    for (const hours of [3, 5, 7.5, 10, 12]) {
      const plan = buildNightPlan(input({ wakeMs: bedtimeMs + hours * HOUR }));
      for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i]!.startMs).toBe(plan.segments[i - 1]!.endMs);
      expect(plan.segments.some((s) => s.phase === 'deep')).toBe(true);
    }
    expect(() => buildNightPlan(input({ wakeMs: bedtimeMs + 0.5 * HOUR }))).toThrow();
    expect(() => buildNightPlan(input({ wakeMs: bedtimeMs - HOUR }))).toThrow();
  });

  it('reports the phase at any moment', () => {
    const plan = buildNightPlan(input());
    expect(phaseAt(plan, plan.startMs - 1)).toBeUndefined();
    expect(phaseAt(plan, bedtimeMs - MIN)).toBe('windDown');
    expect(phaseAt(plan, bedtimeMs + 10 * MIN)).toBe('onset');
    expect(phaseAt(plan, bedtimeMs + 3 * HOUR)).toBe('deep');
    expect(phaseAt(plan, bedtimeMs + 6 * HOUR)).toBe('rem');
    expect(phaseAt(plan, wakeMs - 5 * MIN)).toBe('wake');
    expect(phaseAt(plan, plan.endMs)).toBeUndefined();
    expect(segmentAt(plan, bedtimeMs + 3 * HOUR)!.targetC).toBe(18.5);
  });

  it('builds a nap: settle, then warm to wake', () => {
    const start = zonedTimeToMs('2026-11-14', '14:00', TZ);
    const nap = buildNapPlan({ model: createModel(), limits: DEFAULT_LIMITS, startMs: start, minutes: 20, seasonIndex: 0 });
    expect(nap.kind).toBe('nap');
    expect(nap.segments.map((s) => s.phase)).toEqual(['onset', 'wake']);
    expect(nap.wakeMs).toBe(start + 20 * MIN);
    expect(nap.segments[1]!.targetC).toBeGreaterThan(nap.segments[0]!.targetC);
    expect(buildNapPlan({ model: createModel(), limits: DEFAULT_LIMITS, startMs: start, minutes: 900, seasonIndex: 0 }).wakeMs).toBe(start + 180 * MIN);
  });

  it('applies a user-defined curve preset while keeping the timing', () => {
    const plan = buildNightPlan(input());
    const custom = withPhaseTargets(plan, { onset: 20, deep: 17, rem: 18, wake: 23 }, DEFAULT_LIMITS);
    expect(targetOf(custom, 'windDown')).toBe(20);
    expect(targetOf(custom, 'deep')).toBe(17);
    expect(targetOf(custom, 'rem')).toBe(18);
    expect(lastTarget(custom)).toBe(23);
    expect(custom.startMs).toBe(plan.startMs);
    expect(custom.endMs).toBe(plan.endMs);
    // Out-of-range requests are held to the comfort limits.
    expect(targetOf(withPhaseTargets(plan, { deep: 5 }, DEFAULT_LIMITS), 'deep')).toBe(15.5);
  });

  it('sizes lead time from how fast the room responds', () => {
    expect(leadMinutes(2, undefined)).toBe(45);
    expect(leadMinutes(2, 2)).toBe(60);
    expect(leadMinutes(0.2, 4)).toBe(30);
    expect(leadMinutes(6, 1)).toBe(120);
  });
});

describe('tonight-specific adjustments', () => {
  const all = { explore: true, cycleTracking: true, menopauseMode: false, recoveryAware: true };

  it('does nothing by default', () => {
    expect(contextModifiers({}, DEFAULT_OPTIONS)).toEqual([]);
  });

  it('cools for the luteal phase only when cycle tracking is on', () => {
    expect(contextModifiers({ cyclePhase: 'luteal' }, DEFAULT_OPTIONS)).toEqual([]);
    const mods = contextModifiers({ cyclePhase: 'luteal' }, all);
    expect(mods.map((m) => m.id)).toEqual(['cycle']);
    expect(modifierDelta(mods, 'deep')).toBe(-0.5);
    expect(modifierDelta(mods, 'wake')).toBe(0);
    expect(contextModifiers({ cyclePhase: 'follicular' }, all)).toEqual([]);
  });

  it('cools the first half of the night after hard training', () => {
    const mods = contextModifiers({ recovery: { highStrain: true } }, all);
    expect(modifierDelta(mods, 'onset')).toBe(-0.5);
    expect(modifierDelta(mods, 'deep')).toBe(-0.5);
    expect(modifierDelta(mods, 'rem')).toBe(0);
  });

  it('puts comfort first when ill, and ignores recovery signals when opted out', () => {
    const ill = contextModifiers({ recovery: { illness: true, highStrain: true, alcohol: true } }, all);
    expect(ill.map((m) => m.id)).toEqual(['illness']);
    expect(modifierDelta(ill, 'deep')).toBe(0.5);
    expect(contextModifiers({ recovery: { highStrain: true } }, { ...all, recoveryAware: false })).toEqual([]);
  });

  it('caps the combined adjustment', () => {
    const mods = contextModifiers(
      { cyclePhase: 'luteal', recovery: { highStrain: true, alcohol: true } },
      { ...all, menopauseMode: true },
    );
    expect(modifierDelta(mods, 'deep')).toBe(-1.5);
  });

  it('shows up in the plan, phase by phase', () => {
    const base = buildNightPlan(input());
    const plan = buildNightPlan(input({ options: { ...STEADY, recoveryAware: true }, context: { recovery: { highStrain: true } } }));
    expect(targetOf(plan, 'deep')).toBe(targetOf(base, 'deep') - 0.5);
    expect(targetOf(plan, 'rem')).toBe(targetOf(base, 'rem'));
    expect(plan.modifiers.map((m) => m.id)).toEqual(['strain']);
  });

  it('flags nights that should not be learned from', () => {
    expect(isConfoundedNight({})).toBe(false);
    expect(isConfoundedNight({ recovery: { highStrain: true } })).toBe(false);
    expect(isConfoundedNight({ recovery: { alcohol: true } })).toBe(true);
    expect(isConfoundedNight({ recovery: { illness: true } })).toBe(true);
  });

  it('places a date in the menstrual cycle', () => {
    expect(cyclePhaseOn('2026-11-01', '2026-11-01')).toBe('menstrual');
    expect(cyclePhaseOn('2026-11-08', '2026-11-01')).toBe('follicular');
    expect(cyclePhaseOn('2026-11-15', '2026-11-01')).toBe('ovulatory');
    expect(cyclePhaseOn('2026-11-22', '2026-11-01')).toBe('luteal');
    expect(cyclePhaseOn('2026-11-29', '2026-11-01')).toBe('menstrual');
    // A longer cycle lengthens the follicular phase, not the luteal one.
    expect(cyclePhaseOn('2026-11-15', '2026-11-01', 35)).toBe('follicular');
    expect(cyclePhaseOn('2026-11-27', '2026-11-01', 35)).toBe('luteal');
    // Dates before the recorded period still resolve.
    expect(cyclePhaseOn('2026-10-25', '2026-11-01')).toBe('luteal');
  });

  it('derives recovery flags from daily wearable readings', () => {
    expect(deriveRecovery({})).toEqual({ highStrain: false, alcohol: false, illness: false });
    expect(deriveRecovery({ strain: 17 }).highStrain).toBe(true);
    expect(deriveRecovery({ strain: 9, workoutEndedMinBeforeBed: 90 }).highStrain).toBe(true);
    expect(deriveRecovery({ skinTempDeviationC: 1.1, restingHrDeltaBpm: 7 }).illness).toBe(true);
    expect(deriveRecovery({ skinTempDeviationC: 1.1 }).illness).toBe(false);
    expect(deriveRecovery({ alcohol: true }).alcohol).toBe(true);
  });

});

describe('setpoint decision', () => {
  const plan = buildNightPlan(input());
  const room = buildRoomPlan([{ plan, limits: DEFAULT_LIMITS, weight: 1 }]);
  const mid = bedtimeMs + 3 * HOUR;
  const hold = (over: Partial<Hold> = {}): Hold => ({ targetC: 22, source: 'app', startMs: mid - HOUR, untilMs: null, ...over });

  it('follows the plan when nothing else is in force', () => {
    expect(decideSetpoint({ t: mid, plan: room, hold: null, liveOffsetC: 0 })).toMatchObject({ targetC: 18.5, source: 'plan', phase: 'deep' });
  });

  it('applies live nudges to the plan, within the comfort limits', () => {
    expect(decideSetpoint({ t: mid, plan: room, hold: null, liveOffsetC: -1 }).targetC).toBe(17.5);
    expect(decideSetpoint({ t: mid, plan: room, hold: null, liveOffsetC: -10 }).targetC).toBe(15.5);
  });

  it('lets a manual hold override the plan and any live nudge', () => {
    const decision = decideSetpoint({ t: mid, plan: room, hold: hold(), liveOffsetC: -1 });
    expect(decision).toMatchObject({ targetC: 22, source: 'hold', plannedC: 18.5, liveOffsetC: 0 });
  });

  it('honours a hold beyond the comfort range but not beyond the safety bounds', () => {
    expect(decideSetpoint({ t: mid, plan: room, hold: hold({ targetC: 26.5 }), liveOffsetC: 0 }).targetC).toBe(26.5);
    expect(decideSetpoint({ t: mid, plan: room, hold: hold({ targetC: 35 }), liveOffsetC: 0 }).targetC).toBe(28);
  });

  it('returns to the plan when a timed hold lapses', () => {
    const timed = hold({ untilMs: mid + 30 * MIN });
    expect(decideSetpoint({ t: mid, plan: room, hold: timed, liveOffsetC: 0 }).source).toBe('hold');
    expect(decideSetpoint({ t: mid + 31 * MIN, plan: room, hold: timed, liveOffsetC: 0 }).source).toBe('plan');
    expect(holdActive(hold({ startMs: mid + HOUR }), mid, room)).toBe(false);
  });

  it('ends an until-morning hold with the plan, then leaves the thermostat alone', () => {
    expect(holdActive(hold(), room.endMs - 1, room)).toBe(true);
    expect(holdActive(hold(), room.endMs, room)).toBe(false);
    expect(decideSetpoint({ t: room.endMs + MIN, plan: room, hold: hold(), liveOffsetC: 0 })).toMatchObject({ targetC: null, source: 'idle' });
    expect(decideSetpoint({ t: room.startMs - MIN, plan: room, hold: null, liveOffsetC: 0 }).targetC).toBeNull();
  });

  it('honours a daytime hold when there is no plan', () => {
    expect(decideSetpoint({ t: mid, plan: null, hold: hold(), liveOffsetC: 0 })).toMatchObject({ targetC: 22, source: 'hold' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildInsights,
  buildNightPlan,
  createModel,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  estimateIdeal,
  experiencedCoreC,
  HOUR,
  learnFromNight,
  MIN,
  observePreference,
  updateRoomResponse,
  zonedTimeToMs,
  type NightMetrics,
  type NightRecord,
  type PlanInput,
  type TempSample,
} from '../src/index';

const TZ = 'America/Toronto';
const bedtimeMs = zonedTimeToMs('2026-11-13', '22:45', TZ);
const wakeMs = zonedTimeToMs('2026-11-14', '06:45', TZ);

const planFor = (over: Partial<PlanInput> = {}) =>
  buildNightPlan({
    sleeperId: 'a',
    model: createModel(),
    limits: DEFAULT_LIMITS,
    options: { ...DEFAULT_OPTIONS, explore: false },
    bedtimeMs,
    wakeMs,
    seasonIndex: 0,
    ...over,
  });

/** A room that tracks the plan exactly, sampled every five minutes. */
const tracking = (plan: ReturnType<typeof planFor>, shiftC = 0): TempSample[] => {
  const samples: TempSample[] = [];
  for (let t = plan.startMs; t < plan.endMs; t += 5 * MIN) {
    const seg = plan.segments.find((s) => t >= s.startMs && t < s.endMs)!;
    samples.push({ t, roomTempC: seg.targetC + shiftC });
  }
  return samples;
};

const metrics: NightMetrics = {
  timeInBedMin: 480,
  totalSleepMin: 440,
  sleepEfficiency: 0.92,
  deepMin: 90,
  remMin: 100,
  awakenings: 2,
  restlessness: 0.1,
  hrvMs: 55,
  restingHr: 56,
  hrvBaselineMs: 55,
  restingHrBaseline: 56,
};

describe('end-of-night learning', () => {
  it('reads the experienced temperature as a deep-sleep equivalent', () => {
    const model = createModel();
    const plan = planFor();
    // The room followed the plan: phase offsets cancel and the core comes back.
    expect(experiencedCoreC(model, plan, tracking(plan))).toBeCloseTo(18.5, 6);
    // A room one degree warmer than asked all night reads one degree warmer.
    expect(experiencedCoreC(model, plan, tracking(plan, 1))).toBeCloseTo(19.5, 6);
    expect(experiencedCoreC(model, plan, [])).toBeNull();
  });

  it('removes tonight\'s context adjustments before learning', () => {
    const model = createModel();
    const trained = planFor({ options: { ...DEFAULT_OPTIONS, explore: false, recoveryAware: true }, context: { recovery: { highStrain: true } } });
    expect(trained.segments.find((s) => s.phase === 'deep')!.targetC).toBe(18);
    // The room was half a degree cooler because of hard training; the neutral-context reading is unchanged.
    expect(experiencedCoreC(model, trained, tracking(trained))).toBeCloseTo(18.5, 6);
  });

  it('ignores the wind-down and the wake-up warming', () => {
    const model = createModel();
    const plan = planFor();
    const samples = tracking(plan).map((s) => (s.t < plan.bedtimeMs || s.t >= plan.wakeMs - 45 * MIN ? { ...s, roomTempC: 30 } : s));
    expect(experiencedCoreC(model, plan, samples)).toBeCloseTo(18.5, 6);
  });

  it('absorbs the night\'s outcome and any preferences', () => {
    const model = createModel();
    const plan = planFor();
    const learned = learnFromNight(model, {
      plan,
      samples: tracking(plan),
      metrics,
      context: {},
      preferences: [{ kind: 'override', t: bedtimeMs + 3 * HOUR, tempC: 20.5 }, { kind: 'tooCold' }],
    });
    expect(learned.outcomeUsed).toBe(true);
    expect(learned.preferencesUsed).toBe(2);
    expect(learned.model.nights).toBe(1);
    expect(learned.quality!.thermal).toBeGreaterThan(60);
    expect(estimateIdeal(learned.model, 0).coreC).toBeGreaterThan(19.2);
    // The input model is untouched.
    expect(model.nights).toBe(0);
  });

  it('interprets an override in the phase it was made', () => {
    const plan = planFor();
    const duringRem = learnFromNight(createModel(), {
      plan,
      samples: tracking(plan),
      metrics: null,
      context: {},
      preferences: [{ kind: 'override', t: bedtimeMs + 6 * HOUR, tempC: 20 }],
    });
    const duringDeep = learnFromNight(createModel(), {
      plan,
      samples: tracking(plan),
      metrics: null,
      context: {},
      preferences: [{ kind: 'override', t: bedtimeMs + 3 * HOUR, tempC: 20 }],
    });
    // 20 degrees asked for in late sleep (already half a degree warmer by default) implies a lower core than in deep sleep.
    expect(estimateIdeal(duringRem.model, 0).coreC).toBeLessThan(estimateIdeal(duringDeep.model, 0).coreC);
  });

  it('does not learn sleep outcomes from a night dominated by something else', () => {
    const plan = planFor();
    const base = { plan, samples: tracking(plan), metrics, preferences: [] };
    expect(learnFromNight(createModel(), { ...base, context: { recovery: { illness: true } } }).outcomeUsed).toBe(false);
    expect(learnFromNight(createModel(), { ...base, context: { recovery: { alcohol: true } } }).model.nights).toBe(0);
    expect(learnFromNight(createModel(), { ...base, context: { recovery: { highStrain: true } } }).outcomeUsed).toBe(true);
  });

  it('copes with a wearable that has not synced', () => {
    const plan = planFor();
    const learned = learnFromNight(createModel(), { plan, samples: tracking(plan), metrics: null, context: {}, preferences: [{ kind: 'tooHot' }] });
    expect(learned.quality).toBeNull();
    expect(learned.outcomeUsed).toBe(false);
    expect(learned.preferencesUsed).toBe(1);
    expect(estimateIdeal(learned.model, 0).coreC).toBeLessThan(18.5);
  });
});

describe('room response', () => {
  /** A trace warming at `rate` degrees per hour toward a higher setpoint, then holding. */
  const ramp = (fromC: number, toC: number, ratePerHour: number, startMin = 0) => {
    const samples = [];
    let temp = fromC;
    const step = ratePerHour / 12;
    for (let m = startMin; m < startMin + 180; m += 5) {
      samples.push({ t: m * MIN, roomTempC: temp, setpointC: toC });
      temp = toC > fromC ? Math.min(toC, temp + step) : Math.max(toC, temp - step);
    }
    return samples;
  };

  it('measures how fast the room warms and cools', () => {
    expect(updateRoomResponse({}, ramp(18, 21, 3)).heatRateCPerHour).toBeCloseTo(3, 0);
    expect(updateRoomResponse({}, ramp(22, 19, 1.5)).coolRateCPerHour).toBeCloseTo(1.5, 0);
    expect(updateRoomResponse({}, ramp(18, 21, 3)).coolRateCPerHour).toBeUndefined();
  });

  it('blends new measurements into what it knew', () => {
    const updated = updateRoomResponse({ heatRateCPerHour: 2 }, ramp(18, 21, 4));
    expect(updated.heatRateCPerHour).toBeGreaterThan(2);
    expect(updated.heatRateCPerHour).toBeLessThan(4);
  });

  it('learns nothing from a room that is already where it should be, or that is not being controlled', () => {
    const steady = Array.from({ length: 36 }, (_, i) => ({ t: i * 5 * MIN, roomTempC: 19, setpointC: 19 }));
    expect(updateRoomResponse({ heatRateCPerHour: 2 }, steady)).toEqual({ heatRateCPerHour: 2, coolRateCPerHour: undefined });
    const idle = ramp(18, 21, 3).map((s) => ({ ...s, setpointC: null }));
    expect(updateRoomResponse({}, idle)).toEqual({ heatRateCPerHour: undefined, coolRateCPerHour: undefined });
  });
});

describe('insights', () => {
  const night = (i: number, over: Partial<NightRecord> = {}): NightRecord => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    seasonIndex: 0,
    experiencedCoreC: 18.5,
    thermalQuality: 75,
    overallQuality: 75,
    modifiers: [],
    overrides: 0,
    liveAdjustments: 0,
    ...over,
  });
  const ids = (history: NightRecord[], model = createModel()): string[] => buildInsights(model, history, 0).map((i) => i.id);

  it('says it is still learning and gives its current answer', () => {
    const insights = buildInsights(createModel(), [], 0);
    expect(insights.map((i) => i.id)).toEqual(['learning', 'ideal']);
    expect(insights[1]).toMatchObject({ id: 'ideal', coreC: 18.5, lowC: 17, highC: 20 });
  });

  it('drops the learning notice once the model is confident', () => {
    let model = createModel();
    for (let i = 0; i < 12; i++) model = observePreference(model, { kind: 'override', tempC: 19.5, phase: 'deep', seasonIndex: 0 });
    expect(ids([], model)).toEqual(['ideal']);
  });

  it('finds the temperature band with the best nights', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? night(i, { experiencedCoreC: 19.2, thermalQuality: 82 }) : night(i, { experiencedCoreC: 17.3, thermalQuality: 70 }),
    );
    const band = buildInsights(createModel(), history, 0).find((i) => i.id === 'bestBand');
    expect(band).toMatchObject({ id: 'bestBand', gain: 12, nightsIn: 10, nightsOut: 10 });
    expect((band as { lowC: number }).lowC).toBeLessThanOrEqual(19.2);
    expect((band as { highC: number }).highC).toBeGreaterThan(19.2);
  });

  it('notices a run of corrections in one direction', () => {
    const history = Array.from({ length: 10 }, (_, i) => night(i, i < 4 ? { overrides: 1, overrideDeltaC: 1.5 } : {}));
    expect(buildInsights(createModel(), history, 0).find((i) => i.id === 'overrides')).toMatchObject({ count: 4, direction: 'warmer' });
    const mixed = Array.from({ length: 10 }, (_, i) => night(i, i < 4 ? { overrides: 1, overrideDeltaC: i % 2 === 0 ? 1 : -1 } : {}));
    expect(ids(mixed)).not.toContain('overrides');
  });

  it('notices a room that cannot reach what is asked of it', () => {
    const history = Array.from({ length: 10 }, (_, i) => night(i, { trackingErrorC: 1.2 }));
    expect(buildInsights(createModel(), history, 0).find((i) => i.id === 'cannotReach')).toMatchObject({ direction: 'cooler', nights: 10, shortfallC: 1.2 });
    const cold = Array.from({ length: 10 }, (_, i) => night(i, { trackingErrorC: -1 }));
    expect(buildInsights(createModel(), cold, 0).find((i) => i.id === 'cannotReach')).toMatchObject({ direction: 'warmer', shortfallC: 1 });
  });

  it('reports the recent trend and energy against the baseline', () => {
    const history = Array.from({ length: 14 }, (_, i) =>
      night(i, { overallQuality: i < 7 ? 70 : 78, energyKWh: 4, baselineKWh: 5, costCents: 40, baselineCostCents: 55 }),
    );
    const insights = buildInsights(createModel(), history, 0);
    expect(insights.find((i) => i.id === 'trend')).toMatchObject({ delta: 8, nights: 7 });
    expect(insights.find((i) => i.id === 'energy')).toMatchObject({ savedKWh: 14, savedCents: 210, nights: 14 });
  });

  it('stays quiet when there is nothing to say', () => {
    const history = Array.from({ length: 5 }, (_, i) => night(i));
    expect(ids(history)).toEqual(['learning', 'ideal']);
  });
});

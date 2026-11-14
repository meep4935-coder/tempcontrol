/**
 * Test harness: runs whole simulated nights through the engine the same way the
 * server's control loop does, so tests exercise planning, control, live
 * adjustment and learning together.
 */

import {
  addDays,
  buildNightPlan,
  buildRoomPlan,
  createLiveState,
  createModel,
  decideSetpoint,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  estimateIdeal,
  INFERRED_SIGNAL_NOISE_C,
  learnFromNight,
  liveOffset,
  liveStep,
  phaseAt,
  roomSegmentAt,
  seasonIndex,
  seededRng,
  zonedTimeToMs,
  type ComfortLimits,
  type Hold,
  type NightContext,
  type NightMetrics,
  type PreferenceEvent,
  type SleeperOptions,
  type ThermalModelState,
} from '../src/index';
import {
  CLIMATES,
  overnightOutdoorC,
  ROOM_PRESETS,
  RoomNightSim,
  seasonalMode,
  type Climate,
  type RoomParams,
  type SleeperTruth,
} from '../src/sim';

export interface HarnessSleeper {
  id: string;
  truth: SleeperTruth;
  bedtime: string;
  wakeTime: string;
  realtime?: boolean;
  options?: Partial<SleeperOptions>;
  limits?: ComfortLimits;
  model?: ThermalModelState;
  /** Extra context for this sleeper on a given date (cycle phase, recovery flags). */
  contextFor?: (date: string) => NightContext;
}

export interface HarnessOptions {
  sleepers: HarnessSleeper[];
  nights: number;
  startDate: string;
  climate?: Climate;
  room?: RoomParams;
  seed?: number;
  /** Disable the live controller, to compare against it. */
  live?: boolean;
}

export interface HarnessNight {
  date: string;
  seasonIndex: number;
  outdoorC: number;
  /** Per sleeper. */
  sleepers: Record<
    string,
    {
      estimateC: number;
      sdC: number;
      confidence: number;
      experiencedCoreC: number | null;
      thermalQuality: number | null;
      meanDiscomfortC: number;
      metrics: NightMetrics;
      wakeTargetC: number;
      coreTargetC: number;
    }
  >;
  liveEvents: number;
  overrides: number;
  kWh: number;
  startMs: number;
  endMs: number;
  initialTempC: number;
}

export interface HarnessResult {
  nights: HarnessNight[];
  models: Record<string, ThermalModelState>;
}

export function runNights(opts: HarnessOptions): HarnessResult {
  const climate = opts.climate ?? CLIMATES.montreal!;
  const room = opts.room ?? ROOM_PRESETS.miniSplit!;
  const seed = opts.seed ?? 1;
  const rng = seededRng(seed);
  const models = new Map(opts.sleepers.map((s) => [s.id, s.model ?? createModel()]));
  let roomTempC = 21;
  const nights: HarnessNight[] = [];

  for (let n = 0; n < opts.nights; n++) {
    const date = addDays(opts.startDate, n);
    const outdoorC = overnightOutdoorC(date, climate, seed);
    const s = seasonIndex(date, climate.latitude, outdoorC);

    const prepared = opts.sleepers.map((sleeper) => {
      const bedtimeMs = zonedTimeToMs(date, sleeper.bedtime, climate.timeZone);
      let wakeMs = zonedTimeToMs(addDays(date, 1), sleeper.wakeTime, climate.timeZone);
      if (sleeper.bedtime < sleeper.wakeTime) wakeMs = zonedTimeToMs(date, sleeper.wakeTime, climate.timeZone);
      const options = { ...DEFAULT_OPTIONS, ...sleeper.options };
      const limits = sleeper.limits ?? DEFAULT_LIMITS;
      const context: NightContext = { ...sleeper.contextFor?.(date) };
      const model = models.get(sleeper.id)!;
      const plan = buildNightPlan({ sleeperId: sleeper.id, model, limits, options, bedtimeMs, wakeMs, seasonIndex: s, context });
      return { sleeper, plan, limits, options, context, model, weight: estimateIdeal(model, s).sensitivity };
    });

    const roomPlan = buildRoomPlan(prepared.map((p) => ({ plan: p.plan, limits: p.limits, weight: p.weight })));
    const world = new RoomNightSim({
      startMs: roomPlan.startMs,
      endMs: roomPlan.endMs,
      tickMin: 5,
      room,
      mode: seasonalMode(outdoorC, room),
      initialTempC: roomTempC,
      idleSetpointC: 21,
      outdoorMeanC: outdoorC,
      sleepers: prepared.map((p) => ({
        id: p.sleeper.id,
        truth: p.sleeper.truth,
        bedtimeMs: p.plan.bedtimeMs,
        wakeMs: p.plan.wakeMs,
        realtime: p.sleeper.realtime ?? false,
        ctx: { ...p.context, seasonIndex: s },
        phaseAt: (t) => phaseAt(p.plan, t),
      })),
      rng,
    });

    let live = createLiveState();
    const nudged = new Set<string>();
    let hold: Hold | null = null;
    let liveEvents = 0;
    let overrides = 0;
    let kWh = 0;
    const samples: { t: number; roomTempC: number; setpointC: number | null }[] = [];
    const prefs = new Map<string, PreferenceEvent[]>(opts.sleepers.map((x) => [x.id, []]));

    while (!world.done) {
      const decision = decideSetpoint({ t: world.t, plan: roomPlan, hold, liveOffsetC: liveOffset(live, world.t) });
      const reading = world.advance({ setpointC: decision.targetC });
      kWh += reading.kWh;
      samples.push({ t: reading.t, roomTempC: reading.roomTempC, setpointC: decision.targetC });

      for (const o of reading.overrides) {
        hold = { targetC: o.targetC, source: 'device', startMs: reading.t, untilMs: null, sleeperId: o.sleeperId };
        prefs.get(o.sleeperId)!.push({ kind: 'override', t: reading.t, tempC: o.targetC });
        overrides++;
      }

      if (opts.live !== false) {
        const segment = roomSegmentAt(roomPlan, reading.t);
        const step = liveStep(live, {
          t: reading.t,
          phase: segment?.phase,
          roomTempC: reading.roomTempC,
          targetC: segment?.targetC ?? reading.roomTempC,
          sleepers: prepared.map((p) => ({
            id: p.sleeper.id,
            vitals: reading.vitals[p.sleeper.id] ?? null,
            inBed: reading.inBed[p.sleeper.id] ?? false,
            menopauseMode: p.options.menopauseMode,
          })),
        });
        live = step.state;
        liveEvents += step.events.length;
        // The first time a sleeper's body asks for a change is read as a weak comfort signal.
        for (const e of step.events) {
          if ((e.reason !== 'restlessWarm' && e.reason !== 'restlessCold') || !e.sleeperId || nudged.has(e.sleeperId)) continue;
          nudged.add(e.sleeperId);
          prefs.get(e.sleeperId)!.push({
            kind: e.reason === 'restlessCold' ? 'tooCold' : 'tooHot',
            t: e.t,
            tempC: reading.roomTempC,
            noiseC: INFERRED_SIGNAL_NOISE_C,
          });
        }
      }
    }
    roomTempC = samples[samples.length - 1]!.roomTempC;

    const results = world.finish();
    const night: HarnessNight = {
      date,
      seasonIndex: s,
      outdoorC,
      sleepers: {},
      liveEvents,
      overrides,
      kWh,
      startMs: roomPlan.startMs,
      endMs: roomPlan.endMs,
      initialTempC: world.setup.initialTempC,
    };
    for (const p of prepared) {
      const result = results[p.sleeper.id]!;
      const events = [...prefs.get(p.sleeper.id)!];
      if (result.feedback) events.push({ kind: result.feedback });
      const learned = learnFromNight(p.model, { plan: p.plan, samples, metrics: result.metrics, context: p.context, preferences: events });
      models.set(p.sleeper.id, learned.model);
      const estimate = estimateIdeal(learned.model, s);
      night.sleepers[p.sleeper.id] = {
        estimateC: estimate.coreC,
        sdC: estimate.sdC,
        confidence: estimate.confidence,
        experiencedCoreC: learned.experiencedCoreC,
        thermalQuality: learned.quality?.thermal ?? null,
        meanDiscomfortC: result.meanDiscomfortC,
        metrics: result.metrics,
        wakeTargetC: p.plan.segments[p.plan.segments.length - 1]!.targetC,
        coreTargetC: p.plan.segments.find((seg) => seg.phase === 'deep')!.targetC,
      };
    }
    nights.push(night);
  }

  return { nights, models: Object.fromEntries(models) };
}

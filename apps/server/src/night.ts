/**
 * Planning and running one night for one room.
 *
 * `planNight` gathers everything known this evening (each sleeper's model,
 * the weather, prices, tonight's flags) and produces the schedule.
 * `NightRunner` then drives that schedule through the control loop, one
 * interval at a time, and in the morning turns what happened into learning.
 *
 * The same runner serves the instant simulation, the played-back live night
 * and, behind a different `NightEnvironment`, real devices.
 */

import type { EventDto, HoldDto, NightDetailDto, NightSummaryDto, PlanDto, SleeperNightDto, TickDto } from '@tempcontrol/contracts';
import {
  addDays,
  buildNapPlan,
  buildNightPlan,
  buildRoomPlan,
  createLiveState,
  cyclePhaseOn,
  decideSetpoint,
  deriveRecovery,
  energyCostCents,
  estimateIdeal,
  flatTariff,
  getTariff,
  hashString,
  holdActive,
  comfortCorrection,
  HARD_LIMITS,
  hvacDirection,
  INFERRED_SIGNAL_NOISE_C,
  jetLagSchedule,
  leadMinutes,
  learnFromNight,
  liveOffset,
  liveStep,
  MIN,
  parseClock,
  phaseAt,
  phaseOffset,
  pricePeriods,
  roomSegmentAt,
  seasonIndex,
  seasonName,
  seededRng,
  shapePlanForEnergy,
  updateRoomResponse,
  withPhaseTargets,
  zonedTimeToMs,
  type CyclePhase,
  type EnergyChange,
  type Hold,
  type LiveState,
  type NightContext,
  type NightPlan,
  type PeakEvent,
  type PreferenceEvent,
  type PricePeriod,
  type RecoverySignals,
  type RoomPlan,
  type Tariff,
} from '@tempcontrol/engine';
import {
  CLIMATES,
  overnightOutdoorC,
  ROOM_PRESETS,
  seasonalMode,
  simulateConstantSetpoint,
  type Climate,
  type WorldSetup,
} from '@tempcontrol/engine/sim';
import { wearableBrand } from './catalog';
import { simulatedDay } from './demo';
import { SimEnvironment, type NightEnvironment, type Observation } from './environment';
import { newId, type DeviceRecord, type HouseholdRecord, type RoomRecord, type SleeperRecord, type Store } from './store';

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TICK_MIN = 5;
const ASLEEP = new Set(['onset', 'deep', 'rem']);

/* ------------------------------------------------------------ tonight's inputs */

export interface SleeperTonight {
  cyclePhase: CyclePhase | null;
  recovery: RecoverySignals;
  bedtime: string;
  wakeTime: string;
  bedtimeMs: number;
  wakeMs: number;
}

/** When this sleeper goes to bed and gets up for the night starting on `date`, including any travel shift. */
export function sleepWindow(sleeper: SleeperRecord, date: string, timeZone: string): Pick<SleeperTonight, 'bedtime' | 'wakeTime' | 'bedtimeMs' | 'wakeMs'> {
  let { bedtime, wakeTime } = sleeper;
  if (sleeper.travel) {
    const shifted = jetLagSchedule({ bedtime, wakeTime, ...sleeper.travel }).find((n) => n.date === date);
    if (shifted) ({ bedtime, wakeTime } = shifted);
  }
  // A bedtime in the small hours belongs to the following calendar day.
  const bedDate = parseClock(bedtime) < 12 * 60 ? addDays(date, 1) : date;
  const wakeDate = parseClock(wakeTime) > parseClock(bedtime) ? bedDate : addDays(bedDate, 1);
  const bedtimeMs = zonedTimeToMs(bedDate, bedtime, timeZone);
  let wakeMs = zonedTimeToMs(wakeDate, wakeTime, timeZone);
  const hours = (wakeMs - bedtimeMs) / (60 * MIN);
  if (hours < 3 || hours > 14) wakeMs = bedtimeMs + 8 * 60 * MIN;
  return { bedtime, wakeTime, bedtimeMs, wakeMs };
}

export function sleeperTonight(sleeper: SleeperRecord, household: HouseholdRecord, timeZone: string): SleeperTonight {
  const day = deriveRecovery({ ...simulatedDay(sleeper.name, household.date, household.seed), alcohol: sleeper.tonight.alcohol });
  return {
    cyclePhase: sleeper.cycle.lastPeriodStart ? cyclePhaseOn(household.date, sleeper.cycle.lastPeriodStart, sleeper.cycle.lengthDays) : null,
    recovery: {
      highStrain: Boolean(day.highStrain || sleeper.tonight.highStrain),
      alcohol: Boolean(day.alcohol),
      illness: Boolean(day.illness || sleeper.tonight.illness),
    },
    ...sleepWindow(sleeper, household.date, timeZone),
  };
}

export interface Outlook {
  climate: Climate;
  outdoorC: number;
  seasonIndex: number;
}

export function outlookFor(household: HouseholdRecord): Outlook {
  const climate = CLIMATES[household.climateId] ?? CLIMATES.montreal!;
  const outdoorC = overnightOutdoorC(household.date, climate, household.seed);
  return {
    climate,
    outdoorC,
    seasonIndex: seasonIndex(household.date, climate.latitude, outdoorC),
  };
}

const tariffFor = (household: HouseholdRecord): Tariff => getTariff(household.tariffId) ?? flatTariff(10);

/** The declared peak event, as an interval, if the tariff has event pricing. */
function peakEventFor(household: HouseholdRecord, tariff: Tariff, timeZone: string): PeakEvent[] {
  if (!household.peakEvent || !tariff.peakEventRate) return [];
  const windows = tariff.peakEventWindows ?? [];
  const morning = household.peakEvent === 'morning';
  const window = windows.find((w) => (morning ? w.fromHour < 12 : w.fromHour >= 12)) ?? (morning ? { fromHour: 6, toHour: 10 } : { fromHour: 16, toHour: 20 });
  const date = morning ? addDays(household.date, 1) : household.date;
  const clock = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
  return [{ startMs: zonedTimeToMs(date, clock(window.fromHour), timeZone), endMs: zonedTimeToMs(date, clock(window.toHour), timeZone) }];
}

/* ------------------------------------------------------------------- planning */

export interface PlannedSleeper {
  record: SleeperRecord;
  tonight: SleeperTonight;
  context: NightContext;
  plan: NightPlan;
  realtime: boolean;
}

export interface NightSetup {
  kind: 'night' | 'nap';
  household: HouseholdRecord;
  room: RoomRecord;
  devices: DeviceRecord[];
  thermostat: DeviceRecord;
  outlook: Outlook;
  sleepers: PlannedSleeper[];
  roomPlan: RoomPlan;
  periods: PricePeriod[];
  changes: EnergyChange[];
  dto: PlanDto;
}

export interface PlanOptions {
  /** Plan a nap for one sleeper instead of the night. */
  nap?: { sleeperId: string; minutes: number; startMs: number };
  /** Ignore the room's preset and plan the automatic (recommended) schedule. */
  automatic?: boolean;
}

export function planNight(store: Store, roomId: string, opts: PlanOptions = {}): NightSetup {
  const room = store.room(roomId);
  const household = store.household();
  if (!room || !household) throw new RequestError(404, 'not_found', 'Room not found.');
  const devices = store.devices(roomId);
  const thermostat = devices[0];
  if (!thermostat) throw new RequestError(409, 'no_thermostat', 'This room has no thermostat to control.');

  const outlook = outlookFor(household);
  const { climate } = outlook;
  const s = outlook.seasonIndex;
  const preset = room.activePresetId && !opts.automatic ? store.preset(room.activePresetId) : undefined;

  const inRoom = store.sleepers(household.id).filter((x) => x.roomId === roomId);
  const chosen = opts.nap ? inRoom.filter((x) => x.id === opts.nap!.sleeperId) : inRoom;
  if (chosen.length === 0) throw new RequestError(409, 'no_sleepers', 'Nobody is assigned to this room.');

  const sleepers: PlannedSleeper[] = chosen.map((record) => {
    const tonight = sleeperTonight(record, household, climate.timeZone);
    const context: NightContext = opts.nap ? {} : { cyclePhase: tonight.cyclePhase ?? undefined, recovery: tonight.recovery };

    let plan: NightPlan;
    if (opts.nap) {
      plan = buildNapPlan({ sleeperId: record.id, model: record.model, limits: record.limits, startMs: opts.nap.startMs, minutes: opts.nap.minutes, seasonIndex: s });
    } else {
      // Start early enough for the room to actually arrive on time, using how fast it has been seen to respond.
      const onsetTarget = estimateIdeal(record.model, s).coreC + phaseOffset(record.model, 'onset', s);
      const toOnset = household.daySetpointC - onsetTarget;
      const wakeLift = phaseOffset(record.model, 'wake', s) - phaseOffset(record.model, 'rem', s);
      plan = buildNightPlan({
        sleeperId: record.id,
        model: record.model,
        limits: record.limits,
        options: record.options,
        bedtimeMs: tonight.bedtimeMs,
        wakeMs: tonight.wakeMs,
        seasonIndex: s,
        context,
        windDownMin: leadMinutes(toOnset, toOnset > 0 ? room.response.coolRateCPerHour : room.response.heatRateCPerHour, 30, 120),
        wakeRampMin: leadMinutes(wakeLift, room.response.heatRateCPerHour, 30, 75),
        // Mornings are warmed up to the household's daytime setting, or a degree past it when energy is not a concern.
        wakeCapC: household.daySetpointC + (household.energy.enabled ? 0 : 1),
      });
      // A preset replaces the automatic temperatures: a curve phase by phase, a fixed temperature all night.
      if (preset?.kind === 'curve' && preset.temps) plan = withPhaseTargets(plan, preset.temps, record.limits);
      else if (preset?.kind === 'hold' && preset.targetC !== undefined) {
        const t = preset.targetC;
        plan = withPhaseTargets(plan, { onset: t, deep: t, rem: t, wake: t }, record.limits);
      }
    }

    return {
      record,
      tonight,
      context,
      plan,
      realtime: wearableBrand(record.wearableBrand).delivery === 'live',
    };
  });

  // Everyone in bed has an equal say. (The engine also accepts uneven weights, for a future "priority" setting.)
  let roomPlan = buildRoomPlan(sleepers.map((p) => ({ plan: p.plan, limits: p.record.limits, weight: 1 })));

  const tariff = tariffFor(household);
  const periods = pricePeriods(tariff, roomPlan.startMs, roomPlan.endMs, climate.timeZone, { events: peakEventFor(household, tariff, climate.timeZone) });
  const coreTarget = Math.min(...roomPlan.segments.map((seg) => seg.targetC));
  const direction = hvacDirection(outlook.outdoorC, coreTarget);
  let changes: EnergyChange[] = [];
  if (household.energy.enabled && !opts.nap) {
    const shaped = shapePlanForEnergy(roomPlan, periods, { toleranceC: household.energy.toleranceC, direction });
    roomPlan = shaped.plan;
    changes = shaped.changes;
  }

  const equipment = ROOM_PRESETS[thermostat.equipment ?? 'central']!;

  const dto: PlanDto = {
    roomId,
    date: household.date,
    kind: opts.nap ? 'nap' : 'night',
    startMs: roomPlan.startMs,
    endMs: roomPlan.endMs,
    segments: roomPlan.segments,
    sleepers: sleepers.map((p) => ({
      sleeperId: p.record.id,
      bedtimeMs: p.plan.bedtimeMs,
      wakeMs: p.plan.wakeMs,
      idealC: p.plan.idealC,
      idealSdC: p.plan.idealSdC,
      confidence: p.plan.confidence,
      explorationC: p.plan.explorationC,
      modifiers: p.plan.modifiers,
      segments: p.plan.segments,
    })),
    gapC: roomPlan.gapC,
    limits: roomPlan.limits,
    context: {
      outdoorC: outlook.outdoorC,
      seasonIndex: s,
      season: seasonName(household.date, climate.latitude),
      mode: seasonalMode(outlook.outdoorC, equipment),
    },
    energy: { enabled: household.energy.enabled, direction, toleranceC: household.energy.toleranceC, periods, changes },
    hold: opts.nap ? null : room.pendingHold,
    presetName: preset?.name ?? null,
  };

  return { kind: opts.nap ? 'nap' : 'night', household, room, devices, thermostat, outlook, sleepers, roomPlan, periods, changes, dto };
}

/* --------------------------------------------------------------------- running */

function simulatedWorld(setup: NightSetup): WorldSetup {
  const { household, outlook, room, thermostat } = setup;
  const equipment = ROOM_PRESETS[thermostat.equipment ?? 'central']!;
  const rng = seededRng(hashString(`${household.seed}:${room.name}:${household.date}:${setup.kind}:${setup.roomPlan.startMs}`));
  return {
    startMs: setup.roomPlan.startMs,
    endMs: setup.roomPlan.endMs,
    tickMin: TICK_MIN,
    room: equipment,
    mode: seasonalMode(outlook.outdoorC, equipment),
    initialTempC: household.daySetpointC + 0.4 * (rng() - 0.5),
    idleSetpointC: household.daySetpointC,
    outdoorMeanC: outlook.outdoorC,
    sleepers: setup.sleepers.map((p) => ({
      id: p.record.id,
      truth: p.record.truth,
      bedtimeMs: p.plan.bedtimeMs,
      wakeMs: p.plan.wakeMs,
      realtime: p.realtime,
      // The simulated person lives their real cycle and day whether or not they opted in to tracking them.
      ctx: { seasonIndex: outlook.seasonIndex, cyclePhase: p.tonight.cyclePhase ?? undefined, recovery: setup.kind === 'nap' ? undefined : p.tonight.recovery },
      phaseAt: (t: number) => phaseAt(p.plan, t),
    })),
    rng,
  };
}

export interface HoldInput {
  targetC: number;
  minutes: number | null;
  source: HoldDto['source'];
  sleeperId?: string;
  presetName?: string;
}

export class NightRunner {
  private live: LiveState = createLiveState();
  private hold: Hold | null = null;
  private holdMinutes: number | null = null;
  private readonly trace: TickDto[] = [];
  private readonly events: EventDto[] = [];
  private readonly preferences = new Map<string, PreferenceEvent[]>();
  private readonly nudged = new Set<string>();
  /** Correction from people saying they are too warm or too cold, in degrees. */
  private comfortC = 0;
  private readonly pendingEnergy: EnergyChange[];
  private lastObservation: Observation | null = null;
  private endedEarlyAt: number | null = null;

  private constructor(
    private readonly store: Store,
    readonly setup: NightSetup,
    private readonly env: NightEnvironment,
    private readonly world: WorldSetup,
  ) {
    for (const p of setup.sleepers) this.preferences.set(p.record.id, []);
    this.pendingEnergy = [...setup.changes];
    const pending = setup.kind === 'night' ? setup.room.pendingHold : null;
    if (pending) this.applyHold({ ...pending }, setup.roomPlan.startMs);
  }

  static create(store: Store, roomId: string, opts: PlanOptions = {}): NightRunner {
    const setup = planNight(store, roomId, opts);
    const world = simulatedWorld(setup);
    return new NightRunner(store, setup, new SimEnvironment(world), world);
  }

  get clockMs(): number {
    return this.env.now();
  }

  get done(): boolean {
    return this.endedEarlyAt !== null || this.env.now() >= this.setup.roomPlan.endMs;
  }

  get ticks(): readonly TickDto[] {
    return this.trace;
  }

  get eventLog(): readonly EventDto[] {
    return this.events;
  }

  /** The manual temperature in force right now, if any. */
  get currentHold(): HoldDto | null {
    if (!holdActive(this.hold, this.env.now(), this.setup.roomPlan)) return null;
    return { targetC: this.hold.targetC, source: this.hold.source, minutes: this.holdMinutes, sleeperId: this.hold.sleeperId, presetName: this.hold.presetName };
  }

  /** What the thermostat is being asked for at this moment. */
  currentTargetC(): number | null {
    const t = this.env.now();
    return decideSetpoint({ t, plan: this.setup.roomPlan, hold: this.hold, liveOffsetC: this.offsetAt(t) }).targetC;
  }

  lastReading(): { roomTempC: number } | null {
    return this.lastObservation ? { roomTempC: this.lastObservation.roomTempC } : null;
  }

  private applyHold(input: HoldInput, startMs: number): void {
    this.hold = {
      targetC: input.targetC,
      source: input.source,
      startMs,
      untilMs: input.minutes ? startMs + input.minutes * MIN : null,
      sleeperId: input.sleeperId,
      presetName: input.presetName,
    };
    this.holdMinutes = input.minutes;
    this.events.push({ t: startMs, kind: 'manual', source: input.source, targetC: input.targetC, sleeperId: input.sleeperId, presetName: input.presetName });

    // A temperature chosen by hand is the clearest statement of preference there
    // is. When nobody in particular is known to have chosen it, everyone in the
    // room is credited, with less weight.
    const owners = this.setup.sleepers.filter((p) => !input.sleeperId || p.record.id === input.sleeperId);
    for (const p of owners) {
      // Chosen before bed for the whole night: it speaks for the night as a whole, so read it against deep sleep.
      const wholeNight = input.minutes === null && startMs <= p.plan.bedtimeMs;
      const deep = p.plan.segments.find((seg) => seg.phase === 'deep');
      this.preferences.get(p.record.id)?.push({
        kind: 'override',
        t: wholeNight && deep ? deep.startMs + MIN : startMs,
        tempC: input.targetC,
        noiseC: input.sleeperId ? undefined : INFERRED_SIGNAL_NOISE_C,
      });
    }
  }

  /** Set a temperature by hand during the night. */
  setHold(input: HoldInput): HoldDto {
    this.applyHold(input, this.env.now());
    return this.currentHold!;
  }

  /** Drop any manual temperature and return to the plan. */
  clearHold(): void {
    if (!this.hold) return;
    this.hold = null;
    this.holdMinutes = null;
    this.events.push({ t: this.env.now(), kind: 'resume' });
  }

  /** Live nudges plus what people asked for, kept within reach of the plan. */
  private offsetAt(t: number): number {
    return Math.max(-3, Math.min(3, liveOffset(this.live, t) + this.comfortC));
  }

  /**
   * Someone said they are too warm or too cold. The room moves straight away
   * (see `comfortCorrection`), and the model learns from it as well.
   * Returns the change to the setpoint and the new setpoint.
   */
  feel(sleeperId: string, feeling: 'tooHot' | 'tooCold'): { deltaC: number; targetC: number | null } {
    const t = this.env.now();
    const roomTempC = this.lastObservation?.roomTempC ?? this.setup.household.daySetpointC;
    this.preferences.get(sleeperId)?.push({ kind: feeling, t, tempC: roomTempC });
    const before = this.currentTargetC();
    if (holdActive(this.hold, t, this.setup.roomPlan)) {
      // A temperature set by hand moves the same way.
      const step = comfortCorrection(0, feeling);
      this.hold = { ...this.hold, targetC: Math.max(HARD_LIMITS.minC, Math.min(HARD_LIMITS.maxC, this.hold.targetC + step)) };
    } else {
      this.comfortC = comfortCorrection(this.comfortC, feeling);
    }
    const after = this.currentTargetC();
    const deltaC = before !== null && after !== null ? after - before : 0;
    this.events.push({ t, kind: 'feeling', feeling, sleeperId, deltaC });
    return { deltaC, targetC: after };
  }

  /** End the night now ("good morning"). */
  wake(): void {
    if (this.done) return;
    this.endedEarlyAt = this.env.now();
    this.events.push({ t: this.endedEarlyAt, kind: 'wake' });
  }

  /** Run one control interval. */
  async step(): Promise<TickDto> {
    const { roomPlan, sleepers } = this.setup;
    this.lastObservation ??= await this.env.observe();
    const t = this.env.now();

    if (this.hold && !holdActive(this.hold, t, roomPlan)) {
      this.hold = null;
      this.holdMinutes = null;
      if (t < roomPlan.endMs) this.events.push({ t, kind: 'resume' });
    }

    const decision = decideSetpoint({ t, plan: roomPlan, hold: this.hold, liveOffsetC: this.offsetAt(t) });
    while (this.pendingEnergy.length > 0 && this.pendingEnergy[0]!.startMs <= t) {
      const change = this.pendingEnergy.shift()!;
      this.events.push({ t: change.startMs, kind: 'energy', change: change.kind, deltaC: change.deltaC, peakEvent: change.peakEvent });
    }

    const obs = await this.env.step({ setpointC: decision.targetC });
    this.lastObservation = obs;

    const vitals: TickDto['vitals'] = {};
    for (const [id, v] of Object.entries(obs.vitals)) {
      if (v) vitals[id] = { heartRate: v.heartRate === undefined ? undefined : Math.round(v.heartRate), movement: v.movement, skinTempDeltaC: v.skinTempDeltaC };
    }
    const tick: TickDto = {
      t: obs.t,
      roomTempC: Math.round(obs.roomTempC * 100) / 100,
      setpointC: decision.targetC,
      plannedC: decision.plannedC ?? null,
      source: decision.source,
      phase: decision.phase ?? null,
      liveOffsetC: decision.liveOffsetC,
      outdoorC: Math.round(obs.outdoorC * 10) / 10,
      running: obs.running,
      kWh: obs.kWh,
      vitals,
    };
    this.trace.push(tick);

    // Someone changed the thermostat by hand: respect it for the rest of the night and learn from it.
    for (const change of obs.manualChanges) {
      this.applyHold({ targetC: change.targetC, minutes: null, source: 'device', sleeperId: change.sleeperId }, obs.t);
    }

    const segment = roomSegmentAt(roomPlan, obs.t);
    const step = liveStep(this.live, {
      t: obs.t,
      phase: segment?.phase,
      roomTempC: obs.roomTempC,
      targetC: segment?.targetC ?? obs.roomTempC,
      sleepers: sleepers.map((p) => ({
        id: p.record.id,
        vitals: obs.vitals[p.record.id] ?? null,
        inBed: obs.inBed[p.record.id] ?? false,
        menopauseMode: p.record.options.menopauseMode,
      })),
    });
    this.live = step.state;
    for (const e of step.events) {
      this.events.push({ t: e.t, kind: 'live', reason: e.reason, deltaC: e.deltaC, offsetC: e.offsetC, sleeperId: e.sleeperId });
      // The first time a sleeper's body asks for a change is read as a weak comfort signal.
      const restless = e.reason === 'restlessWarm' || e.reason === 'restlessCold';
      if (restless && e.sleeperId && !this.nudged.has(e.sleeperId)) {
        this.nudged.add(e.sleeperId);
        this.preferences.get(e.sleeperId)?.push({
          kind: e.reason === 'restlessCold' ? 'tooCold' : 'tooHot',
          t: e.t,
          tempC: obs.roomTempC,
          noiseC: INFERRED_SIGNAL_NOISE_C,
        });
      }
    }
    return tick;
  }

  /** Run every remaining interval. */
  async runToEnd(): Promise<void> {
    while (!this.done) await this.step();
  }

  /**
   * The morning after: learn, account for energy, and save the night.
   * `advanceClock` moves the demo calendar on to the next evening; pass false
   * when several rooms are being run for the same night.
   */
  async finish(opts: { advanceClock?: boolean } = {}): Promise<NightDetailDto> {
    const { roomPlan, sleepers, outlook, kind } = this.setup;
    // Settings may have changed while the night was running: work from what is stored now.
    const household = this.store.household() ?? this.setup.household;
    const room = this.store.room(this.setup.room.id) ?? this.setup.room;
    const reports = await this.env.finish(this.endedEarlyAt ?? undefined);
    const samples = this.trace.map((tick) => ({ t: tick.t, roomTempC: tick.roomTempC, setpointC: tick.setpointC }));
    const s = outlook.seasonIndex;

    const sleeperNights: SleeperNightDto[] = sleepers.map((p) => {
      const current = this.store.sleeper(p.record.id) ?? p.record;
      const report = reports[p.record.id] ?? { metrics: null };
      const preferences = [...(this.preferences.get(p.record.id) ?? [])];
      if (report.feedback) preferences.push({ kind: report.feedback });

      // A nap leaves the model alone: too short to judge, and not a night.
      const learned =
        kind === 'night'
          ? learnFromNight(current.model, {
              plan: p.plan,
              samples,
              metrics: report.metrics,
              context: p.context,
              preferences,
            })
          : { model: current.model, experiencedCoreC: null, quality: null, outcomeUsed: false, preferencesUsed: 0 };
      const estimate = estimateIdeal(learned.model, s);

      if (kind === 'night') {
        this.store.saveSleeper({ ...current, model: learned.model, tonight: { alcohol: false, highStrain: false, illness: false } });
      }
      return {
        sleeperId: p.record.id,
        quality: learned.quality ? Math.round(learned.quality.overall * 10) / 10 : null,
        thermalQuality: learned.quality ? Math.round(learned.quality.thermal * 10) / 10 : null,
        experiencedCoreC: learned.experiencedCoreC === null ? null : Math.round(learned.experiencedCoreC * 100) / 100,
        estimateC: Math.round(estimate.coreC * 100) / 100,
        sdC: Math.round(estimate.sdC * 100) / 100,
        confidence: Math.round(estimate.confidence * 1000) / 1000,
        feedback: report.feedback ?? null,
        metrics: report.metrics,
        modifiers: p.plan.modifiers.map((m) => m.id),
        outcomeUsed: learned.outcomeUsed,
      };
    });

    const asleep = this.trace.filter((tick) => tick.phase !== null && ASLEEP.has(tick.phase));
    const controlled = asleep.filter((tick) => tick.setpointC !== null);
    const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

    const usage = this.trace.map((tick) => ({ t: tick.t, kWh: tick.kWh }));
    const baseline = simulateConstantSetpoint({ ...this.world, endMs: this.endedEarlyAt ?? this.world.endMs }, household.daySetpointC);
    const round2 = (v: number): number => Math.round(v * 100) / 100;

    const summary: NightSummaryDto = {
      id: newId(kind),
      roomId: room.id,
      date: household.date,
      kind,
      startMs: roomPlan.startMs,
      endMs: this.endedEarlyAt ?? roomPlan.endMs,
      outdoorC: Math.round(outlook.outdoorC * 10) / 10,
      seasonIndex: round2(s),
      coreTargetC: Math.min(...roomPlan.segments.map((seg) => seg.targetC)),
      avgRoomTempC: round2(mean(asleep.map((tick) => tick.roomTempC))),
      trackingErrorC: round2(mean(controlled.map((tick) => tick.roomTempC - tick.setpointC!))),
      kWh: round2(usage.reduce((sum, u) => sum + u.kWh, 0)),
      baselineKWh: round2(baseline.reduce((sum, u) => sum + u.kWh, 0)),
      costCents: round2(energyCostCents(usage, this.setup.periods)),
      baselineCostCents: round2(energyCostCents(baseline, this.setup.periods)),
      liveAdjustments: this.events.filter((e) => e.kind === 'live' && e.reason !== 'hotFlashOver').length,
      manualChanges: this.events.filter((e) => e.kind === 'manual').length,
      sleepers: sleeperNights,
    };
    const events = [...this.events].sort((a, b) => a.t - b.t);
    const detail = { plan: this.setup.dto, trace: this.trace, events };

    this.store.saveNight(summary, detail);
    const last = this.trace[this.trace.length - 1];
    if (kind === 'night') {
      this.store.saveRoom({
        ...room,
        response: updateRoomResponse(room.response, samples),
        climate: last ? { tempC: last.roomTempC } : room.climate,
        pendingHold: null,
      });
      if (opts.advanceClock !== false) advanceClock(this.store);
    }
    return { ...summary, ...detail };
  }
}

/** The night is over: move the demo calendar to the next evening. Any declared peak event has passed. */
export function advanceClock(store: Store): void {
  const household = store.household();
  if (household) store.saveHousehold({ ...household, date: addDays(household.date, 1), peakEvent: null });
}

/** Simulate `count` whole nights for every room that can be run. Returns their summaries. */
export async function simulateNights(store: Store, count: number): Promise<NightSummaryDto[]> {
  const out: NightSummaryDto[] = [];
  for (let n = 0; n < count; n++) {
    const household = store.household();
    if (!household) throw new RequestError(404, 'not_found', 'No household.');
    const rooms = store.rooms(household.id);
    let ran = 0;
    for (const room of rooms) {
      const hasSleepers = store.sleepers(household.id).some((x) => x.roomId === room.id);
      const hasThermostat = store.devices(room.id).length > 0;
      if (!hasSleepers || !hasThermostat) continue;
      const runner = NightRunner.create(store, room.id);
      await runner.runToEnd();
      const night = await runner.finish({ advanceClock: false });
      const { plan: _plan, trace: _trace, events: _events, ...summary } = night;
      out.push(summary);
      ran++;
    }
    if (ran === 0) throw new RequestError(409, 'nothing_to_run', 'No room has both a sleeper and a thermostat.');
    advanceClock(store);
  }
  return out;
}

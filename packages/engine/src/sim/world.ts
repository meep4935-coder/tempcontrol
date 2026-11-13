/**
 * The simulated world for one room and one night: the room's physics and the
 * people sleeping in it. It stands in for the real thermostat and wearables.
 *
 * It contains no control logic. Whoever drives it (the server's control loop,
 * or a test) decides the setpoint each step, exactly as with real devices.
 */

import type { HvacMode, LiveVitals, Phase, Rng } from '../types';
import { MIN } from '../util';
import { sensedTempC, stepHumidity, stepRoom, type RoomParams, type RoomState, type Running } from './room';
import {
  finishSleeperNight,
  sleeperTick,
  startSleeperNight,
  type SleeperNightResult,
  type SleeperNightState,
  type SleeperTruth,
  type TruthContext,
} from './sleeper';
import { outdoorAtC } from './weather';

export interface SimSleeperSetup {
  id: string;
  truth: SleeperTruth;
  bedtimeMs: number;
  wakeMs: number;
  /** Whether this person's wearable reports during the night. */
  realtime: boolean;
  ctx: TruthContext;
  /** The phase this sleeper is in at a given time (from their plan). */
  phaseAt: (t: number) => Phase | undefined;
}

export interface WorldSetup {
  startMs: number;
  endMs: number;
  tickMin: number;
  room: RoomParams;
  mode: HvacMode;
  initialTempC: number;
  /** Setpoint the thermostat sits at when the platform is not controlling it. */
  idleSetpointC: number;
  outdoorMeanC: number;
  initialHumidityPct: number;
  ambientHumidityPct: number;
  sleepers: SimSleeperSetup[];
  rng: Rng;
}

export interface AdvanceInput {
  /** Setpoint commanded for this step; null leaves the thermostat at its idle setpoint. */
  setpointC: number | null;
  humidityDevice?: { kind: 'humidifier' | 'dehumidifier'; targetPct: number } | null;
  /** Personal fan speed per sleeper (0-3). */
  fans?: Record<string, number>;
}

export interface WorldReading {
  t: number;
  /** What the thermostat's sensor reports. */
  roomTempC: number;
  humidityPct: number;
  outdoorC: number;
  running: Running;
  /** Setpoint that was in force during the step that ended at `t`. */
  setpointC: number;
  /** Electricity used during that step. */
  kWh: number;
  /** Live readings, only for sleepers whose wearable offers them. */
  vitals: Record<string, LiveVitals | null>;
  inBed: Record<string, boolean>;
  /** Sleepers who got up and changed the thermostat themselves during the step. */
  overrides: { sleeperId: string; targetC: number }[];
}

/** Each fan speed step feels roughly this much cooler to the person it points at. */
const FAN_COOLING_C = 0.6;

export class RoomNightSim {
  readonly setup: WorldSetup;
  private room: RoomState;
  private humidity: number;
  private nights = new Map<string, SleeperNightState>();
  private now: number;

  constructor(setup: WorldSetup) {
    this.setup = setup;
    this.room = { tempC: setup.initialTempC, running: 'idle' };
    this.humidity = setup.initialHumidityPct;
    this.now = setup.startMs;
    for (const s of setup.sleepers) this.nights.set(s.id, startSleeperNight(s.truth, s.bedtimeMs, s.wakeMs, setup.rng));
  }

  get t(): number {
    return this.now;
  }

  get done(): boolean {
    return this.now >= this.setup.endMs;
  }

  private outdoorC(t: number): number {
    return outdoorAtC(this.setup.outdoorMeanC, (t - this.setup.startMs) / (this.setup.endMs - this.setup.startMs));
  }

  /** The state of the world right now, before any step. */
  read(): WorldReading {
    return {
      t: this.now,
      roomTempC: sensedTempC(this.room, this.setup.rng),
      humidityPct: this.humidity,
      outdoorC: this.outdoorC(this.now),
      running: this.room.running,
      setpointC: this.setup.idleSetpointC,
      kWh: 0,
      vitals: Object.fromEntries(this.setup.sleepers.map((s) => [s.id, null])),
      inBed: Object.fromEntries(this.setup.sleepers.map((s) => [s.id, this.now >= s.bedtimeMs && this.now < s.wakeMs])),
      overrides: [],
    };
  }

  /** Run the world forward one tick under the given setpoint. */
  advance(input: AdvanceInput): WorldReading {
    const { setup } = this;
    const setpointC = input.setpointC ?? setup.idleSetpointC;
    const outdoorC = this.outdoorC(this.now + (setup.tickMin * MIN) / 2);
    const step = stepRoom(this.room, setup.room, { setpointC, mode: setup.mode, outdoorC, minutes: setup.tickMin });
    this.room = step.state;
    this.humidity = stepHumidity(this.humidity, setup.ambientHumidityPct, setup.tickMin, input.humidityDevice ?? undefined);
    this.now += setup.tickMin * MIN;

    const vitals: Record<string, LiveVitals | null> = {};
    const inBed: Record<string, boolean> = {};
    const overrides: WorldReading['overrides'] = [];
    for (const s of setup.sleepers) {
      const present = this.now > s.bedtimeMs && this.now <= s.wakeMs;
      inBed[s.id] = present;
      vitals[s.id] = null;
      if (!present) continue;
      const phase = s.phaseAt(this.now - 1) ?? 'deep';
      const fan = input.fans?.[s.id] ?? 0;
      const tick = sleeperTick(
        s.truth,
        this.nights.get(s.id)!,
        {
          t: this.now,
          roomTempC: this.room.tempC - FAN_COOLING_C * fan,
          phase,
          ctx: { ...s.ctx, humidityPct: this.humidity },
        },
        setup.rng,
      );
      this.nights.set(s.id, tick.state);
      if (s.realtime) vitals[s.id] = tick.vitals;
      if (tick.override) overrides.push({ sleeperId: s.id, targetC: tick.override.targetC });
    }

    return {
      t: this.now,
      roomTempC: sensedTempC(this.room, setup.rng),
      humidityPct: this.humidity,
      outdoorC,
      running: this.room.running,
      setpointC,
      kWh: step.kWh,
      vitals,
      inBed,
      overrides,
    };
  }

  /** The morning after: what each wearable reports and any feedback left in the app. */
  finish(): Record<string, SleeperNightResult> {
    const out: Record<string, SleeperNightResult> = {};
    for (const s of this.setup.sleepers) {
      out[s.id] = finishSleeperNight(
        s.truth,
        this.nights.get(s.id)!,
        { timeInBedMin: (s.wakeMs - s.bedtimeMs) / MIN, ctx: { ...s.ctx, humidityPct: this.humidity } },
        this.setup.rng,
      );
    }
    return out;
  }
}

/**
 * Energy the same room would have used over the same night had the thermostat
 * simply stayed at one setpoint. This is the "what you would have done anyway"
 * baseline that savings are measured against.
 */
export function simulateConstantSetpoint(
  setup: Pick<WorldSetup, 'startMs' | 'endMs' | 'tickMin' | 'room' | 'mode' | 'initialTempC' | 'outdoorMeanC'>,
  setpointC: number,
): { t: number; kWh: number }[] {
  let room: RoomState = { tempC: setup.initialTempC, running: 'idle' };
  const usage: { t: number; kWh: number }[] = [];
  for (let t = setup.startMs; t < setup.endMs; t += setup.tickMin * MIN) {
    const fraction = (t + (setup.tickMin * MIN) / 2 - setup.startMs) / (setup.endMs - setup.startMs);
    const step = stepRoom(room, setup.room, {
      setpointC,
      mode: setup.mode,
      outdoorC: outdoorAtC(setup.outdoorMeanC, fraction),
      minutes: setup.tickMin,
    });
    room = step.state;
    usage.push({ t: t + setup.tickMin * MIN, kWh: step.kWh });
  }
  return usage;
}

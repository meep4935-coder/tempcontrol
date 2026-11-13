/**
 * The boundary between the control loop and the physical world.
 *
 * The night runner never talks to a thermostat or a wearable directly. It
 * drives a `NightEnvironment`: "here is the setpoint, tell me what happened
 * over the next few minutes". In this build the environment is a simulation.
 * A production environment implements the same interface on top of real
 * device connections (the `ClimateAdapter` and `WearableAdapter` contracts
 * below) and a real clock, and the runner does not change.
 */

import type { FeedbackKind, HvacMode, LiveVitals, NightMetrics } from '@tempcontrol/engine';
import { RoomNightSim, type WorldSetup } from '@tempcontrol/engine/sim';

export interface Commands {
  /** Setpoint to hold until the next step; null hands the thermostat back to its own schedule. */
  setpointC: number | null;
  /** Personal fan speed (0-3) per sleeper. */
  fans: Record<string, number>;
  humidityDevice: { kind: 'humidifier' | 'dehumidifier'; targetPct: number } | null;
}

export interface Observation {
  t: number;
  roomTempC: number;
  humidityPct: number;
  outdoorC: number;
  running: 'heat' | 'cool' | 'idle';
  /** Electricity used since the previous observation, when the equipment reports or implies it. */
  kWh: number;
  /** Live readings per sleeper; null where the wearable offers none. */
  vitals: Record<string, LiveVitals | null>;
  inBed: Record<string, boolean>;
  /** Setpoint changes made at the thermostat itself since the previous observation. */
  manualChanges: { sleeperId?: string; targetC: number }[];
}

export interface MorningReport {
  metrics: NightMetrics | null;
  /** Comfort feedback left in the app, if any. */
  feedback?: FeedbackKind;
}

export interface NightEnvironment {
  readonly mode: HvacMode;
  now(): number;
  /** Conditions right now, before anything is commanded. */
  observe(): Promise<Observation>;
  /** Apply the commands and wait one control interval. */
  step(commands: Commands): Promise<Observation>;
  /** After the night: what each sleeper's wearable reports. `untilMs` marks an early end. */
  finish(untilMs?: number): Promise<Record<string, MorningReport>>;
}

/** Simulated room and sleepers. Time advances only when the runner steps. */
export class SimEnvironment implements NightEnvironment {
  private readonly world: RoomNightSim;
  readonly mode: HvacMode;

  constructor(setup: WorldSetup) {
    this.world = new RoomNightSim(setup);
    this.mode = setup.mode;
  }

  now(): number {
    return this.world.t;
  }

  async observe(): Promise<Observation> {
    const r = this.world.read();
    return { ...r, manualChanges: [] };
  }

  async step(commands: Commands): Promise<Observation> {
    const r = this.world.advance({ setpointC: commands.setpointC, fans: commands.fans, humidityDevice: commands.humidityDevice });
    return { ...r, manualChanges: r.overrides };
  }

  async finish(untilMs?: number): Promise<Record<string, MorningReport>> {
    const results = this.world.finish(untilMs);
    return Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { metrics: r.metrics, feedback: r.feedback }]));
  }
}

/* ---------------------------------------------------------------------------
 * Contracts for real device connections. Nothing implements these yet: they
 * record what a production environment needs from each kind of integration.
 * ------------------------------------------------------------------------- */

/** A thermostat, mini-split controller or similar, however it is reached (maker's API, an aggregator, Matter). */
export interface ClimateAdapter {
  read(): Promise<{ roomTempC: number; humidityPct?: number; setpointC: number | null; mode: HvacMode; running: 'heat' | 'cool' | 'idle' }>;
  setSetpoint(targetC: number): Promise<void>;
  /** Give control back to the thermostat's own schedule. */
  release(): Promise<void>;
}

/** A wearable, however its data arrives (on-device health store or the maker's cloud). */
export interface WearableAdapter {
  /** Whether `live` can return readings during the night. */
  readonly realtime: boolean;
  live(): Promise<LiveVitals | null>;
  /** The finished night, or null if the device has not synced yet. */
  nightSummary(date: string): Promise<NightMetrics | null>;
}

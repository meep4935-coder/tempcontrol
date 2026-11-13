/**
 * Everything the server remembers, behind one class.
 */

import { randomUUID } from 'node:crypto';
import type { Equipment, HoldDto, NightDetailDto, NightSummaryDto, PresetDto } from '@tempcontrol/contracts';
import type { ComfortLimits, Locale, RoomResponse, SleeperOptions, ThermalModelState, Units } from '@tempcontrol/engine';
import type { SleeperTruth } from '@tempcontrol/engine/sim';
import type { Db } from './db';

export interface HouseholdRecord {
  id: string;
  name: string;
  climateId: string;
  /** Demo clock: the evening on which the next night starts. */
  date: string;
  tariffId: string;
  energy: { enabled: boolean; toleranceC: number };
  daySetpointC: number;
  peakEvent: 'morning' | 'evening' | null;
  /** Seed for the simulated weather and sleepers. */
  seed: number;
}

export interface SleeperRecord {
  id: string;
  householdId: string;
  roomId: string;
  name: string;
  locale: Locale;
  units: Units;
  birthYear: number | null;
  bedtime: string;
  wakeTime: string;
  limits: ComfortLimits;
  options: SleeperOptions;
  cycle: { lastPeriodStart: string | null; lengthDays: number };
  wearableBrand: string;
  model: ThermalModelState;
  tonight: { alcohol: boolean; highStrain: boolean; illness: boolean };
  travel: { shiftHours: number; arrivalDate: string; prepareNights: number } | null;
  /** Demo only: the simulated person behind this profile. */
  truth: SleeperTruth;
}

export interface RoomRecord {
  id: string;
  householdId: string;
  name: string;
  response: RoomResponse;
  /** Last known conditions. Humidity is null unless the thermostat reports it. */
  climate: { tempC: number; humidityPct: number | null };
  /** The user's answer to the morning recommendation for a given date. */
  recommendation: { date: string; status: 'applied' | 'kept' } | null;
  /** A manual temperature set outside a running night; takes effect when the next one starts. */
  pendingHold: HoldDto | null;
  activePresetId: string | null;
}

export interface DeviceRecord {
  id: string;
  roomId: string;
  brand: string;
  name: string;
  equipment: Equipment;
  reportsHumidity: boolean;
}

export type PresetRecord = PresetDto & { householdId: string };

export type NightDetail = Pick<NightDetailDto, 'plan' | 'trace' | 'events'>;

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

interface Row {
  data: string;
}

export class Store {
  constructor(private readonly db: Db) {}

  /** Run several writes as one unit. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Remove everything (used when the demo is reset). */
  clear(): void {
    this.db.exec('DELETE FROM nights; DELETE FROM presets; DELETE FROM devices; DELETE FROM rooms; DELETE FROM sleepers; DELETE FROM households;');
  }

  /* households */

  household(): HouseholdRecord | undefined {
    const row = this.db.prepare('SELECT data FROM households LIMIT 1').get() as Row | undefined;
    return row ? (JSON.parse(row.data) as HouseholdRecord) : undefined;
  }

  saveHousehold(h: HouseholdRecord): void {
    this.db.prepare('INSERT INTO households (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data').run(h.id, JSON.stringify(h));
  }

  /* sleepers */

  sleepers(householdId: string): SleeperRecord[] {
    const rows = this.db.prepare('SELECT data FROM sleepers WHERE household_id = ? ORDER BY position').all(householdId) as unknown as Row[];
    return rows.map((r) => JSON.parse(r.data) as SleeperRecord);
  }

  sleeper(id: string): SleeperRecord | undefined {
    const row = this.db.prepare('SELECT data FROM sleepers WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as SleeperRecord) : undefined;
  }

  saveSleeper(s: SleeperRecord): void {
    this.db
      .prepare(
        `INSERT INTO sleepers (id, household_id, position, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM sleepers), ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      .run(s.id, s.householdId, JSON.stringify(s));
  }

  /* rooms */

  rooms(householdId: string): RoomRecord[] {
    const rows = this.db.prepare('SELECT data FROM rooms WHERE household_id = ? ORDER BY position').all(householdId) as unknown as Row[];
    return rows.map((r) => JSON.parse(r.data) as RoomRecord);
  }

  room(id: string): RoomRecord | undefined {
    const row = this.db.prepare('SELECT data FROM rooms WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as RoomRecord) : undefined;
  }

  saveRoom(r: RoomRecord): void {
    this.db
      .prepare(
        `INSERT INTO rooms (id, household_id, position, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM rooms), ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      .run(r.id, r.householdId, JSON.stringify(r));
  }

  /* devices */

  devices(roomId: string): DeviceRecord[] {
    const rows = this.db.prepare('SELECT data FROM devices WHERE room_id = ? ORDER BY position').all(roomId) as unknown as Row[];
    return rows.map((r) => JSON.parse(r.data) as DeviceRecord);
  }

  device(id: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT data FROM devices WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as DeviceRecord) : undefined;
  }

  saveDevice(d: DeviceRecord): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, room_id, position, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM devices), ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      .run(d.id, d.roomId, JSON.stringify(d));
  }

  deleteDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  /* presets */

  presets(householdId: string): PresetRecord[] {
    const rows = this.db.prepare('SELECT data FROM presets WHERE household_id = ? ORDER BY position').all(householdId) as unknown as Row[];
    return rows.map((r) => JSON.parse(r.data) as PresetRecord);
  }

  preset(id: string): PresetRecord | undefined {
    const row = this.db.prepare('SELECT data FROM presets WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as PresetRecord) : undefined;
  }

  savePreset(p: PresetRecord): void {
    this.db
      .prepare(
        `INSERT INTO presets (id, household_id, position, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM presets), ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      .run(p.id, p.householdId, JSON.stringify(p));
  }

  deletePreset(id: string): void {
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }

  /* nights */

  saveNight(summary: NightSummaryDto, detail: NightDetail): void {
    this.db
      .prepare(
        `INSERT INTO nights (id, room_id, date, kind, seq, summary, detail)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM nights), ?, ?)
         ON CONFLICT (id) DO UPDATE SET summary = excluded.summary, detail = excluded.detail`,
      )
      .run(summary.id, summary.roomId, summary.date, summary.kind, JSON.stringify(summary), JSON.stringify(detail));
  }

  /** Most recent nights for a room, oldest first. */
  nightSummaries(roomId: string, limit: number, kind: 'night' | 'nap' = 'night'): NightSummaryDto[] {
    const rows = this.db
      .prepare('SELECT summary FROM nights WHERE room_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?')
      .all(roomId, kind, limit) as unknown as { summary: string }[];
    return rows.map((r) => JSON.parse(r.summary) as NightSummaryDto).reverse();
  }

  night(id: string): NightDetailDto | undefined {
    const row = this.db.prepare('SELECT summary, detail FROM nights WHERE id = ?').get(id) as { summary: string; detail: string } | undefined;
    if (!row) return undefined;
    return { ...(JSON.parse(row.summary) as NightSummaryDto), ...(JSON.parse(row.detail) as NightDetail) };
  }

  updateNightSummary(summary: NightSummaryDto): void {
    this.db.prepare('UPDATE nights SET summary = ? WHERE id = ?').run(JSON.stringify(summary), summary.id);
  }

  nightCount(roomId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM nights WHERE room_id = ? AND kind = 'night'").get(roomId) as { n: number };
    return Number(row.n);
  }
}

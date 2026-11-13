/**
 * Storage. SQLite through Node's built-in driver keeps the demo to a single
 * file with nothing to install. Records are stored as JSON documents; the
 * `Store` class in `store.ts` is the only code that talks to this module, so
 * moving to Postgres with a proper schema later touches one file.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sleepers (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS nights (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    seq INTEGER NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS nights_by_room ON nights (room_id, kind, seq);
`;

/** Open (and create if needed) the database. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

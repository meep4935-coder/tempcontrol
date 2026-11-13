import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb } from './db';
import { createDemo } from './setup';
import { Store } from './store';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.TEMPCONTROL_DB ?? resolve(repoRoot, 'data/tempcontrol.db');
/** Nights of history to simulate when the demo is first created, so the dashboard has something to show. */
const historyNights = Number(process.env.TEMPCONTROL_HISTORY_NIGHTS ?? 10);

const store = new Store(openDb(dbPath));
if (!store.household()) await createDemo(store, process.env.TEMPCONTROL_SCENARIO, historyNights);

const app = buildApp({ store, webRoot: resolve(repoRoot, 'apps/web/dist'), logger: process.env.LOG === '1' });
await app.listen({ port, host });
console.log(`TempControl is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

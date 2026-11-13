import { addDays } from '@tempcontrol/engine';
import { CLIMATES } from '@tempcontrol/engine/sim';
import { scenario, seedDemo, todayIn } from './demo';
import { simulateNights } from './night';
import type { Store } from './store';

/**
 * Create a demo household and, optionally, simulate some nights of history so
 * there is something to look at. The history is back-dated: after it has run,
 * the demo's calendar stands at `today`.
 */
export async function createDemo(store: Store, scenarioId: string | undefined, historyNights: number, opts: { today?: string; seed?: number } = {}): Promise<void> {
  const nights = Math.min(120, Math.max(0, Math.round(historyNights)));
  const climate = CLIMATES[scenario(scenarioId).climateId]!;
  const today = opts.today ?? todayIn(climate.timeZone);
  seedDemo(store, scenarioId, { date: addDays(today, -nights), seed: opts.seed });
  if (nights > 0) await simulateNights(store, nights);
}

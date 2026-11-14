/**
 * The built-in assistant, server side: gathers what is known about a sleeper
 * and hands it to the engine's assistant, which answers from that data alone.
 * No outside AI service is involved and nothing leaves the platform.
 */

import type { AssistantReplyDto, AssistantRequest } from '@tempcontrol/contracts';
import { answerQuestion, buildInsights, estimateIdeal, seasonName, type AssistantContext } from '@tempcontrol/engine';
import { wearableBrand } from './catalog';
import { outlookFor, planNight, RequestError } from './night';
import type { SleeperRecord, Store } from './store';
import { nightRecords, totalSavings } from './views';

export function assistantContext(store: Store, sleeper: SleeperRecord): AssistantContext {
  const household = store.household()!;
  const outlook = outlookFor(household);
  const history = nightRecords(store, sleeper);
  const wearable = wearableBrand(sleeper.wearableBrand);
  const last = store.nightSummaries(sleeper.roomId, 1)[0];
  const mine = last?.sleepers.find((x) => x.sleeperId === sleeper.id);

  let tonight: AssistantContext['tonight'] = null;
  try {
    const setup = planNight(store, sleeper.roomId);
    const own = setup.dto.sleepers.find((s) => s.sleeperId === sleeper.id);
    tonight = {
      timeZone: outlook.climate.timeZone,
      steps: setup.roomPlan.segments.map((seg) => ({ phase: seg.phase, startMs: seg.startMs, endMs: seg.endMs, targetC: seg.targetC })),
      modifiers: own?.modifiers ?? [],
      explorationC: own?.explorationC ?? 0,
      presetName: setup.dto.presetName,
      holdC: setup.dto.hold?.targetC ?? null,
      energyChanges: setup.changes,
      partners: setup.sleepers.length - 1,
      gapC: setup.roomPlan.gapC,
    };
  } catch (err) {
    // No plan can be made (the room has no thermostat): the assistant says so.
    if (!(err instanceof RequestError)) throw err;
  }

  const savings = totalSavings(store);
  return {
    estimate: estimateIdeal(sleeper.model, outlook.seasonIndex),
    insights: buildInsights(sleeper.model, history, outlook.seasonIndex),
    season: seasonName(household.date, outlook.climate.latitude),
    options: sleeper.options,
    manualControl: household.manualControl,
    wearable: { name: wearable.name, delivery: wearable.delivery },
    tonight,
    lastNight: last && mine ? { experiencedCoreC: mine.experiencedCoreC, quality: mine.quality, liveAdjustments: last.liveAdjustments, manualChanges: last.manualChanges } : null,
    savings: savings.nights > 0 ? savings : null,
  };
}

/** Answer one question in the sleeper's own language and units. */
export function answer(store: Store, req: AssistantRequest): AssistantReplyDto {
  const sleeper = store.sleeper(req.sleeperId);
  if (!sleeper) throw new RequestError(404, 'not_found', 'Sleeper not found.');
  return answerQuestion(req.message, assistantContext(store, sleeper), { locale: sleeper.locale, units: sleeper.units });
}

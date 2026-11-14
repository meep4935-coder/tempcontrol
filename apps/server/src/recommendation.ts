/**
 * The morning recommendation: "your data suggest X, so we recommend Y".
 *
 * The recommended setting is always the automatic schedule built from each
 * sleeper's model. A room running on a preset is offered the choice every
 * morning: apply the recommended setting, or keep the preset.
 */

import type { RecommendationDto, ScheduleStepDto } from '@tempcontrol/contracts';
import { buildInsights, estimateIdeal, type RoomPlan } from '@tempcontrol/engine';
import { outlookFor, planNight, RequestError } from './night';
import type { Store } from './store';
import { nightRecords } from './views';

const steps = (plan: RoomPlan): ScheduleStepDto[] =>
  plan.segments.map((seg) => ({ phase: seg.phase, startMs: seg.startMs, endMs: seg.endMs, targetC: seg.targetC }));

const deepTarget = (schedule: ScheduleStepDto[]): number =>
  schedule.find((s) => s.phase === 'deep')?.targetC ?? Math.min(...schedule.map((s) => s.targetC));

export function buildRecommendation(store: Store, roomId: string): RecommendationDto {
  const room = store.room(roomId);
  const household = store.household();
  if (!room || !household) throw new RequestError(404, 'not_found', 'Room not found.');
  const season = outlookFor(household).seasonIndex;
  const preset = room.activePresetId ? store.preset(room.activePresetId) : undefined;

  const recommended = steps(planNight(store, roomId, { automatic: true }).roomPlan);
  const current = preset ? steps(planNight(store, roomId).roomPlan) : null;
  const lastNight = store.nightSummaries(roomId, 1)[0];

  const findings = store
    .sleepers(household.id)
    .filter((s) => s.roomId === roomId)
    .map((sleeper) => {
      const estimate = estimateIdeal(sleeper.model, season);
      const mine = lastNight?.sleepers.find((x) => x.sleeperId === sleeper.id);
      // The ideal temperature is stated on its own and savings have their own place; the rest are the observations behind it.
      const insights = buildInsights(sleeper.model, nightRecords(store, sleeper), season).filter((i) => i.id !== 'ideal' && i.id !== 'energy');
      return {
        sleeperId: sleeper.id,
        idealC: Math.round(estimate.coreC * 10) / 10,
        sdC: Math.round(estimate.sdC * 10) / 10,
        confidence: Math.round(estimate.confidence * 1000) / 1000,
        nights: estimate.nights,
        lastNight: mine ? { experiencedCoreC: mine.experiencedCoreC, quality: mine.quality, thermalQuality: mine.thermalQuality } : null,
        insights: insights.slice(0, 3),
      };
    });

  const answered = room.recommendation?.date === household.date ? room.recommendation.status : null;
  return {
    roomId,
    date: household.date,
    basedOnNightId: lastNight?.id ?? null,
    mode: preset ? 'preset' : 'auto',
    presetName: preset?.name ?? null,
    findings,
    recommended,
    current,
    deepDifferenceC: current ? deepTarget(recommended) - deepTarget(current) : 0,
    // A room already on the automatic schedule has nothing left to decide.
    status: preset ? (answered ?? 'pending') : 'applied',
  };
}

/** Record the user's choice. Applying switches the room to the automatic schedule. */
export function answerRecommendation(store: Store, roomId: string, action: 'apply' | 'keep'): void {
  const room = store.room(roomId);
  const household = store.household();
  if (!room || !household) throw new RequestError(404, 'not_found', 'Room not found.');
  store.saveRoom(
    action === 'apply'
      ? { ...room, activePresetId: null, pendingHold: null, recommendation: { date: household.date, status: 'applied' } }
      : { ...room, recommendation: { date: household.date, status: 'kept' } },
  );
}

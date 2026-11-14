/** Carrying out a spoken or typed command. */

import type { VoiceRequest, VoiceResponse } from '@tempcontrol/contracts';
import { formatVoiceReply, HARD_LIMITS, parseVoiceCommand, settle, zonedTimeToMs, type VoiceOutcome } from '@tempcontrol/engine';
import type { LiveManager } from './live';
import { NightRunner, outlookFor, planNight, RequestError } from './night';
import type { SleeperRecord, Store } from './store';

/** Below this the request is too ambiguous to act on. */
const MIN_CONFIDENCE = 0.5;

/** Run a nap for one sleeper straight away (the demo plays it instantly). */
export async function runNap(store: Store, live: LiveManager, sleeper: SleeperRecord, minutes: number) {
  if (live.running) throw new RequestError(409, 'live_running', 'A night is playing; end it before starting a nap.');
  const household = store.household()!;
  const startMs = zonedTimeToMs(household.date, '14:00', outlookFor(household).climate.timeZone);
  const runner = NightRunner.create(store, sleeper.roomId, { nap: { sleeperId: sleeper.id, minutes, startMs } });
  await runner.runToEnd();
  return runner.finish();
}

export async function handleVoice(store: Store, live: LiveManager, req: VoiceRequest): Promise<VoiceResponse> {
  const sleeper = store.sleeper(req.sleeperId);
  const household = store.household();
  if (!sleeper || !household) throw new RequestError(404, 'not_found', 'Sleeper not found.');
  const room = store.room(sleeper.roomId);
  if (!room) throw new RequestError(404, 'not_found', 'Room not found.');

  const presets = store.presets(household.id);
  const parsed = parseVoiceCommand(req.text, { locale: sleeper.locale, units: sleeper.units, presetNames: presets.map((p) => p.name) });
  const intent = parsed.confidence >= MIN_CONFIDENCE ? parsed.intent : ({ type: 'unknown' } as const);
  const runner = live.runnerFor(room.id);

  /** Hold a temperature: straight away if a night is running, otherwise from the start of the next one. */
  const hold = (targetC: number, source: 'voice' | 'preset', presetName?: string): number => {
    const settled = settle(targetC, HARD_LIMITS);
    const input = { targetC: settled, minutes: null, source, sleeperId: sleeper.id, presetName };
    if (runner) runner.setHold(input);
    else store.saveRoom({ ...room, pendingHold: input });
    return settled;
  };

  let outcome: VoiceOutcome;
  // Setting the temperature yourself is an option the household turns on. Saying how you feel always counts.
  const manualIntents = ['setTemperature', 'adjust', 'activatePreset'];
  if (!household.manualControl && manualIntents.includes(intent.type)) {
    if (intent.type === 'adjust' && intent.feeling) {
      runner?.feel(sleeper.id, intent.feeling);
      outcome = { type: 'feedbackNoted' };
    } else {
      outcome = { type: 'manualControlOff' };
    }
    return { intent: parsed.intent, confidence: parsed.confidence, outcome, reply: formatVoiceReply(outcome, { locale: sleeper.locale, units: sleeper.units }) };
  }
  switch (intent.type) {
    case 'setTemperature': {
      if (intent.valueC < HARD_LIMITS.minC || intent.valueC > HARD_LIMITS.maxC) {
        outcome = { type: 'outOfRange', minC: HARD_LIMITS.minC, maxC: HARD_LIMITS.maxC };
      } else {
        outcome = { type: 'held', targetC: hold(intent.valueC, 'voice'), untilMorning: true };
      }
      break;
    }
    case 'adjust': {
      const base = runner?.currentTargetC() ?? room.pendingHold?.targetC ?? household.daySetpointC;
      if (intent.feeling && runner) runner.feel(sleeper.id, intent.feeling);
      const targetC = hold(base + intent.deltaC, 'voice');
      outcome = { type: 'adjusted', targetC, deltaC: targetC - base };
      break;
    }
    case 'activatePreset': {
      const preset = presets.find((p) => p.name === intent.name);
      if (!preset) {
        outcome = { type: 'presetNotFound' };
      } else {
        // The preset becomes the room's standing setting from the next plan on.
        store.saveRoom({ ...room, activePresetId: preset.id });
        // If a night is already running, a fixed-temperature preset also takes effect at once.
        if (runner && preset.kind === 'hold' && preset.targetC !== undefined) hold(preset.targetC, 'preset', preset.name);
        outcome = { type: 'presetActivated', name: preset.name };
      }
      break;
    }
    case 'startNap': {
      const nap = await runNap(store, live, sleeper, intent.minutes);
      outcome = { type: 'napStarted', minutes: intent.minutes, targetC: nap.plan.segments[0]?.targetC ?? household.daySetpointC };
      break;
    }
    case 'resumeAuto': {
      if (runner) runner.clearHold();
      store.saveRoom({ ...(store.room(room.id) ?? room), pendingHold: null, activePresetId: null });
      outcome = { type: 'resumed' };
      break;
    }
    case 'status': {
      const reading = runner?.lastReading();
      const held = runner ? runner.currentHold : room.pendingHold;
      outcome = {
        type: 'status',
        roomTempC: reading?.roomTempC ?? room.climate.tempC,
        targetC: runner ? runner.currentTargetC() : (room.pendingHold?.targetC ?? null),
        mode: held ? (held.source === 'preset' ? 'preset' : 'hold') : runner ? 'auto' : 'idle',
      };
      break;
    }
    case 'goodNight': {
      if (!runner) live.start(room.id);
      const started = live.runnerFor(room.id);
      outcome = { type: 'nightStarted', targetC: started?.currentTargetC() ?? planNight(store, room.id).roomPlan.segments[0]!.targetC };
      break;
    }
    case 'goodMorning': {
      if (runner) await live.wake();
      outcome = { type: 'nightEnded' };
      break;
    }
    default:
      outcome = { type: 'notUnderstood' };
  }

  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    outcome,
    reply: formatVoiceReply(outcome, { locale: sleeper.locale, units: sleeper.units }),
  };
}

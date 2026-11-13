/**
 * The in-app assistant: answers questions about a sleeper's own data.
 *
 * With an AI model configured and the sleeper's consent, the question goes to
 * Claude together with a compact, pseudonymous summary of that sleeper's data
 * (no name, no account details). Otherwise, or if the model cannot be reached,
 * the reply is assembled from the same computed insights without any AI.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AssistantEvent, AssistantRequest } from '@tempcontrol/contracts';
import { buildInsights, describeInsight, estimateIdeal, localParts, type Insight, type Locale } from '@tempcontrol/engine';
import { wearableBrand } from './catalog';
import { outlookFor, planNight, RequestError } from './night';
import type { SleeperRecord, Store } from './store';
import { nightRecords } from './views';

const MODEL = 'claude-opus-5-5';

/** True when the server has credentials for the AI model. */
export const aiConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client: Anthropic | null = null;
const anthropic = (): Anthropic => (client ??= new Anthropic());

const INSTRUCTIONS = `You are the sleep-temperature assistant inside TempControl, an app that reads a person's wearable and adjusts their bedroom thermostat through the night. You are talking with one user about their own data.

How to answer
- Ground every statement about the user in the data block that follows. If the data does not show something, say it is too early to tell rather than guessing. Any number you quote must come from the data.
- Be brief and concrete: a few sentences of plain language, leading with the answer. No headings, and no lists unless the user asks for detail.
- You can explain what the app is doing and why (tonight's plan, tonight's adjustments, what it has learned), suggest settings to try in the app, and suggest ordinary comfort measures such as bedding, a fan or humidity.
- You are not a medical service. Do not diagnose, and do not advise on medication or treatment. If the user describes something that sounds medical (persistent insomnia, pauses in breathing, fever, severe night sweats), say plainly that it is worth raising with a doctor, then help with the temperature side.
- The app changes settings, not you. Never say you changed something.

How the app works, so you can explain it
- Each night follows a curve: the room is brought to a falling-asleep temperature before bed, is coolest in deep sleep (the "core" temperature), slightly warmer in late sleep, and warmed before waking, more so in winter.
- The core temperature is learned per person from two things: how well they slept at the temperatures they experienced, and anything they said or did (manual changes, "too hot / too cold / just right").
- While the estimate is uncertain, nights alternate half a degree above and below it to learn; this stops by itself. Users can switch it off.
- Tonight's plan can be adjusted for humidity, menstrual cycle phase, hard training, alcohol or illness (each only if the user opted in), and shifted around electricity prices in energy mode.
- With a watch that reports during the night, the room is nudged when the sleeper is restless and warm or cold. Rings and bands sync in the morning, so for them learning happens night to night.
- Partners sharing a room each have their own model; the room follows a weighted compromise, and a personal fan can make up the difference for whoever wants it cooler.
- A manual temperature always overrides the plan.`;

interface Snapshot {
  language: string;
  units: string;
  data: Record<string, unknown>;
  insights: Insight[];
}

/** Everything the assistant is told about one sleeper. Deliberately contains no name or identifier. */
function snapshot(store: Store, sleeper: SleeperRecord): Snapshot {
  const household = store.household()!;
  const outlook = outlookFor(household);
  const tz = outlook.climate.timeZone;
  const clock = (ms: number): string => {
    const p = localParts(ms, tz);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  };

  const history = nightRecords(store, sleeper, 60);
  const insights = buildInsights(sleeper.model, history, outlook.seasonIndex);
  const estimate = estimateIdeal(sleeper.model, outlook.seasonIndex);

  let tonight: Record<string, unknown> | null = null;
  try {
    const plan = planNight(store, sleeper.roomId).dto;
    const mine = plan.sleepers.find((s) => s.sleeperId === sleeper.id);
    tonight = {
      roomSchedule: plan.segments.map((seg) => ({ from: clock(seg.startMs), to: clock(seg.endMs), phase: seg.phase, targetC: seg.targetC })),
      myOwnPlanBeforeBlending: mine?.segments.map((seg) => ({ from: clock(seg.startMs), to: clock(seg.endMs), phase: seg.phase, targetC: seg.targetC })),
      adjustments: mine?.modifiers.map((m) => ({ reason: m.id, deltaC: m.deltaC, ...m.detail })),
      testVariationC: mine?.explorationC,
      sharedRoom: plan.sleepers.length > 1 ? { partners: plan.sleepers.length, gapBetweenIdealsC: Math.round(plan.gapC * 10) / 10 } : null,
      energy: plan.energy.enabled ? { toleranceC: plan.energy.toleranceC, changes: plan.energy.changes.map((c) => ({ kind: c.kind, from: clock(c.startMs), to: clock(c.endMs), deltaC: c.deltaC, peakEvent: c.peakEvent })) } : 'off',
      manualTemperatureSet: plan.hold ? plan.hold.targetC : null,
      presetCurve: plan.presetName,
      outdoorC: Math.round(plan.context.outdoorC),
      humidityPct: Math.round(plan.context.humidityPct),
      humidityAdvice: plan.humidity.advice,
    };
  } catch {
    // No plan can be made (for instance the room has no thermostat): the assistant simply has less to go on.
  }

  const round = (v: number | null | undefined, digits = 1): number | null => (v === null || v === undefined ? null : Math.round(v * 10 ** digits) / 10 ** digits);
  return {
    language: sleeper.locale === 'fr' ? 'Canadian French' : 'English',
    units: sleeper.units === 'F' ? 'degrees Fahrenheit (the data is in Celsius: convert it)' : 'degrees Celsius',
    insights,
    data: {
      date: household.date,
      city: outlook.climate.name,
      seasonIndex: round(outlook.seasonIndex, 2),
      profile: {
        bedtime: sleeper.bedtime,
        wakeTime: sleeper.wakeTime,
        comfortLimitsC: sleeper.limits,
        wearableReports: wearableBrand(sleeper.wearableBrand).delivery === 'live' ? 'live during the night' : 'in the morning after syncing',
        optedIn: sleeper.options,
      },
      model: {
        idealCoreC: round(estimate.coreC),
        plusOrMinusC: round(estimate.sdC),
        personalisedFraction: round(estimate.confidence, 2),
        nightsLearnedFrom: estimate.nights,
        statedPreferences: estimate.preferences,
        winterShiftC: round(estimate.seasonShiftC),
      },
      tonight,
      recentNights: history.slice(-14).map((n) => ({
        date: n.date,
        experiencedCoreC: round(n.experiencedCoreC),
        sleepScore: round(n.overallQuality, 0),
        thermalScore: round(n.thermalQuality, 0),
        humidityPct: n.humidityPct,
        adjustments: n.modifiers,
        manualChanges: n.overrides,
        feedback: n.feedback ?? null,
        liveAdjustments: n.liveAdjustments,
        roomMinusSetpointC: round(n.trackingErrorC),
        kWh: n.energyKWh,
        baselineKWh: n.baselineKWh,
      })),
      computedInsights: insights,
    },
  };
}

/** A reply built from computed insights alone: no AI involved. */
function rulesReply(sleeper: SleeperRecord, snap: Snapshot): string {
  const opts = { locale: sleeper.locale, units: sleeper.units };
  const lines = snap.insights.slice(0, 5).map((i) => describeInsight(i, opts));
  const intro: Record<Locale, string> = {
    en: 'Here is what your data shows so far.',
    fr: 'Voici ce que vos données montrent pour le moment.',
  };
  return [intro[sleeper.locale], ...lines].join('\n\n');
}

const note = (locale: Locale, key: 'optedOut' | 'unavailable' | 'declined'): string => {
  const text = {
    optedOut: {
      en: 'The AI assistant is switched off for this profile, so this answer comes from your computed insights only.',
      fr: "L'assistant IA est désactivé pour ce profil; cette réponse provient uniquement de vos indicateurs calculés.",
    },
    unavailable: {
      en: 'The AI assistant could not be reached, so this answer comes from your computed insights only.',
      fr: "L'assistant IA est injoignable pour le moment; cette réponse provient uniquement de vos indicateurs calculés.",
    },
    declined: {
      en: 'The assistant could not answer that. Here is what your data shows instead.',
      fr: "L'assistant n'a pas pu répondre à cette question. Voici plutôt ce que vos données montrent.",
    },
  };
  return text[key][locale];
};

/** Answer one question, as a stream of events. */
export async function* answer(store: Store, req: AssistantRequest): AsyncGenerator<AssistantEvent> {
  const sleeper = store.sleeper(req.sleeperId);
  if (!sleeper) throw new RequestError(404, 'not_found', 'Sleeper not found.');
  const snap = snapshot(store, sleeper);

  const fallback = function* (reason: 'optedOut' | 'unavailable' | 'declined' | null): Generator<AssistantEvent> {
    const prefix = reason ? `${note(sleeper.locale, reason)}\n\n` : '';
    yield { type: 'delta', text: prefix + rulesReply(sleeper, snap) };
    yield { type: 'done', source: 'rules' };
  };

  if (!aiConfigured()) return yield* fallback(null);
  if (!sleeper.aiAssistant) return yield* fallback('optedOut');

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(req.history ?? []).slice(-20).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: req.message },
  ];

  let sent = false;
  try {
    const stream = anthropic().beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      // A short, grounded chat answer: quick to first word matters more than depth.
      output_config: { effort: 'low' },
      // If the model declines for policy reasons, let the API retry on its fallback model within the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: INSTRUCTIONS },
        {
          type: 'text',
          text: `Reply in ${snap.language}. Give temperatures in ${snap.units}.\n\nThe user's data, as JSON (all temperatures in degrees Celsius):\n${JSON.stringify(snap.data)}`,
        },
      ],
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        sent = true;
        yield { type: 'delta', text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      if (sent) yield { type: 'delta', text: '\n\n' };
      return yield* fallback('declined');
    }
    yield { type: 'done', source: 'ai' };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.error('assistant: the AI credentials were rejected');
    else if (err instanceof Anthropic.RateLimitError) console.error('assistant: rate limited');
    else if (err instanceof Anthropic.APIError) console.error(`assistant: API error ${err.status}: ${err.message}`);
    else console.error('assistant: request failed', err);
    if (sent) yield { type: 'delta', text: '\n\n' };
    yield* fallback('unavailable');
  }
}

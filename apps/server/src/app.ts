/** The HTTP API. Shapes are defined in @tempcontrol/contracts. */

import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type {
  AdvanceResponse,
  ApiError,
  AssistantReplyDto,
  HoldDto,
  LiveUpdateDto,
  NightDetailDto,
  NightSummaryDto,
  PlanDto,
  RecommendationDto,
  StateDto,
  VoiceResponse,
} from '@tempcontrol/contracts';
import {
  buildInsights,
  getTariff,
  HARD_LIMITS,
  jetLagSchedule,
  observePreference,
  resetModel,
  settle,
  type Insight,
  type JetLagNight,
} from '@tempcontrol/engine';
import { CLIMATES } from '@tempcontrol/engine/sim';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { answer } from './assistant';
import { CLIMATE_BRANDS, WEARABLES } from './catalog';
import { SCENARIOS } from './demo';
import { LiveManager } from './live';
import { outlookFor, planNight, RequestError, simulateNights } from './night';
import { answerRecommendation, buildRecommendation } from './recommendation';
import { createDemo } from './setup';
import { newId, type Store } from './store';
import { nightRecords, stateDto } from './views';
import { handleVoice, runNap } from './voice';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time as HH:MM');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');
const temperature = z.number().min(HARD_LIMITS.minC).max(HARD_LIMITS.maxC);

const sleeperPatch = z
  .object({
    name: z.string().trim().min(1).max(40),
    locale: z.enum(['en', 'fr']),
    units: z.enum(['C', 'F']),
    birthYear: z.number().int().min(1900).max(2100).nullable(),
    bedtime: clock,
    wakeTime: clock,
    limits: z.object({ minC: temperature, maxC: temperature }).refine((l) => l.minC <= l.maxC, 'The lower limit must not exceed the upper limit'),
    options: z
      .object({ explore: z.boolean(), cycleTracking: z.boolean(), menopauseMode: z.boolean(), recoveryAware: z.boolean() })
      .partial(),
    cycle: z.object({ lastPeriodStart: day.nullable(), lengthDays: z.number().int().min(21).max(40).optional() }),
    tonight: z.object({ alcohol: z.boolean(), highStrain: z.boolean(), illness: z.boolean() }).partial(),
    wearableBrand: z.string().refine((id) => WEARABLES.some((w) => w.id === id), 'Unknown wearable'),
  })
  .partial()
  .strict();

const householdPatch = z
  .object({
    climateId: z.string().refine((id) => id in CLIMATES, 'Unknown location'),
    tariffId: z.string().refine((id) => id === 'flat' || getTariff(id) !== undefined, 'Unknown tariff'),
    energy: z.object({ enabled: z.boolean(), toleranceC: z.number().min(0).max(1.5) }).partial(),
    daySetpointC: temperature,
    manualControl: z.boolean(),
    peakEvent: z.enum(['morning', 'evening']).nullable(),
  })
  .partial()
  .strict();

const presetBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    kind: z.enum(['hold', 'curve']),
    targetC: temperature.optional(),
    temps: z.object({ onset: temperature, deep: temperature, rem: temperature, wake: temperature }).optional(),
  })
  .strict()
  .refine((p) => (p.kind === 'hold' ? p.targetC !== undefined : p.temps !== undefined), 'A hold preset needs targetC; a curve preset needs temps');

const deviceBody = z
  .object({
    brand: z.string().refine((id) => CLIMATE_BRANDS.some((b) => b.id === id), 'Unknown brand'),
    name: z.string().trim().min(1).max(60).optional(),
    equipment: z.enum(['central', 'baseboard', 'miniSplit', 'windowAc']).optional(),
  })
  .strict();

const holdBody = z.object({ targetC: temperature, minutes: z.number().int().min(5).max(720).nullable().optional(), sleeperId: z.string().optional() }).strict();
const advanceBody = z.object({ nights: z.number().int().min(1).max(120) }).strict();
const resetBody = z.object({ scenario: z.string().optional(), nights: z.number().int().min(0).max(120).optional() }).strict();
const liveStartBody = z.object({ roomId: z.string(), secondsPerNight: z.number().min(10).max(600).optional() }).strict();
const feedbackBody = z.object({ nightId: z.string(), sleeperId: z.string(), kind: z.enum(['tooHot', 'tooCold', 'justRight']) }).strict();
const voiceBody = z.object({ text: z.string().trim().min(1).max(300), sleeperId: z.string() }).strict();
const napBody = z.object({ sleeperId: z.string(), minutes: z.number().int().min(10).max(180) }).strict();
const jetLagBody = z.object({ shiftHours: z.number().min(-12).max(12), arrivalDate: day, prepareNights: z.number().int().min(0).max(5).optional() }).strict();
const assistantBody = z.object({ sleeperId: z.string(), message: z.string().trim().min(1).max(2000) }).strict();
const recommendationBody = z.object({ action: z.enum(['apply', 'keep']) }).strict();

export interface AppOptions {
  store: Store;
  /** Folder holding the built dashboard, served at "/" when it exists. */
  webRoot?: string;
  logger?: boolean;
}

export function buildApp({ store, webRoot, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const live = new LiveManager(store);

  const household = () => {
    const h = store.household();
    if (!h) throw new RequestError(404, 'not_found', 'No household has been set up.');
    return h;
  };
  const sleeperOr404 = (id: string) => {
    const s = store.sleeper(id);
    if (!s) throw new RequestError(404, 'not_found', 'Sleeper not found.');
    return s;
  };
  const roomOr404 = (id: string) => {
    const r = store.room(id);
    if (!r) throw new RequestError(404, 'not_found', 'Room not found.');
    return r;
  };
  const state = (): StateDto => stateDto(store, live.dto());
  /** Setting the temperature yourself is an option the household turns on; the platform runs automatically otherwise. */
  const requireManualControl = (): void => {
    if (!household().manualControl) throw new RequestError(409, 'manual_control_off', 'Manual control is switched off. Turn it on in the settings to set the temperature yourself.');
  };
  /** Settings that feed tonight's plan cannot change under a night that is already running. */
  const requireIdle = (): void => {
    if (live.running) throw new RequestError(409, 'live_running', 'A night is playing. End it first.');
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.status(err.status).send({ error: err.code, message: err.message } satisfies ApiError);
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return reply.status(400).send({ error: 'invalid_request', message: `${where}${issue?.message ?? 'Invalid request'}` } satisfies ApiError);
    }
    const fastifyError = err as { statusCode?: number; message?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({ error: 'invalid_request', message: fastifyError.message ?? 'Invalid request' } satisfies ApiError);
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong on the server.' } satisfies ApiError);
  });

  /* ---------------------------------------------------------------- reading */

  app.get('/api/state', async (): Promise<StateDto> => state());

  app.get<{ Params: { roomId: string } }>('/api/rooms/:roomId/plan', async (req): Promise<PlanDto> => {
    // While a night is playing, "tonight's plan" is the one being followed.
    const playing = live.runnerFor(req.params.roomId);
    return playing ? playing.setup.dto : planNight(store, roomOr404(req.params.roomId).id).dto;
  });

  app.get<{ Params: { roomId: string }; Querystring: { limit?: string; kind?: string } }>(
    '/api/rooms/:roomId/nights',
    async (req): Promise<NightSummaryDto[]> => {
      const limit = Math.min(400, Math.max(1, Number(req.query.limit ?? 90) || 90));
      return store.nightSummaries(roomOr404(req.params.roomId).id, limit, req.query.kind === 'nap' ? 'nap' : 'night');
    },
  );

  app.get<{ Params: { id: string } }>('/api/nights/:id', async (req): Promise<NightDetailDto> => {
    const night = store.night(req.params.id);
    if (!night) throw new RequestError(404, 'not_found', 'Night not found.');
    return night;
  });

  app.get<{ Params: { id: string } }>('/api/sleepers/:id/insights', async (req): Promise<Insight[]> => {
    const sleeper = sleeperOr404(req.params.id);
    return buildInsights(sleeper.model, nightRecords(store, sleeper), outlookFor(household()).seasonIndex);
  });

  /* ------------------------------------------------------------- simulation */

  app.post('/api/sim/advance', async (req): Promise<AdvanceResponse> => {
    requireIdle();
    const { nights } = advanceBody.parse(req.body);
    return { nights: await simulateNights(store, nights), state: state() };
  });

  app.post('/api/sim/reset', async (req): Promise<StateDto> => {
    const body = resetBody.parse(req.body ?? {});
    if (body.scenario && !SCENARIOS.some((s) => s.id === body.scenario)) throw new RequestError(400, 'invalid_request', 'Unknown scenario.');
    await live.discard();
    await createDemo(store, body.scenario, body.nights ?? 0);
    return state();
  });

  /* ------------------------------------------------------------------- live */

  app.post('/api/live/start', async (req): Promise<LiveUpdateDto> => {
    const body = liveStartBody.parse(req.body);
    live.start(roomOr404(body.roomId).id, body.secondsPerNight);
    return live.update(0);
  });

  app.get<{ Querystring: { since?: string } }>('/api/live', async (req): Promise<LiveUpdateDto> => live.update(Number(req.query.since ?? 0) || 0));

  /** Skip to morning and save the night. */
  app.post('/api/live/finish', async (): Promise<LiveUpdateDto> => {
    await live.finishNow();
    return live.update(0);
  });

  /** End the night at this moment ("good morning") and save it. */
  app.post('/api/live/wake', async (): Promise<LiveUpdateDto> => {
    await live.wake();
    return live.update(0);
  });

  /* ------------------------------------------------------- manual control */

  app.post<{ Params: { roomId: string } }>('/api/rooms/:roomId/hold', async (req): Promise<HoldDto> => {
    requireManualControl();
    const room = roomOr404(req.params.roomId);
    const body = holdBody.parse(req.body);
    if (body.sleeperId) sleeperOr404(body.sleeperId);
    const input = { targetC: settle(body.targetC, HARD_LIMITS), minutes: body.minutes ?? null, source: 'app' as const, sleeperId: body.sleeperId };
    const playing = live.runnerFor(room.id);
    if (playing) return playing.setHold(input);
    store.saveRoom({ ...room, pendingHold: input });
    return input;
  });

  app.delete<{ Params: { roomId: string } }>('/api/rooms/:roomId/hold', async (req, reply) => {
    const room = roomOr404(req.params.roomId);
    live.runnerFor(room.id)?.clearHold();
    store.saveRoom({ ...room, pendingHold: null });
    return reply.status(204).send();
  });

  app.post('/api/presets', async (req) => {
    const body = presetBody.parse(req.body);
    const preset = { id: newId('pre'), householdId: household().id, ...body };
    store.savePreset(preset);
    return state().presets.find((p) => p.id === preset.id);
  });

  app.put<{ Params: { id: string } }>('/api/presets/:id', async (req) => {
    const existing = store.preset(req.params.id);
    if (!existing) throw new RequestError(404, 'not_found', 'Preset not found.');
    const body = presetBody.parse(req.body);
    store.savePreset({ id: existing.id, householdId: existing.householdId, ...body });
    return state().presets.find((p) => p.id === existing.id);
  });

  app.delete<{ Params: { id: string } }>('/api/presets/:id', async (req, reply) => {
    const existing = store.preset(req.params.id);
    if (!existing) throw new RequestError(404, 'not_found', 'Preset not found.');
    store.deletePreset(existing.id);
    for (const room of store.rooms(existing.householdId)) {
      if (room.activePresetId === existing.id) store.saveRoom({ ...room, activePresetId: null });
    }
    return reply.status(204).send();
  });

  /** Make a preset the room's standing setting: it replaces the automatic schedule every night until cleared. */
  app.post<{ Params: { id: string }; Body: unknown }>('/api/presets/:id/activate', async (req): Promise<StateDto> => {
    requireIdle();
    requireManualControl();
    const preset = store.preset(req.params.id);
    if (!preset) throw new RequestError(404, 'not_found', 'Preset not found.');
    const { roomId } = z.object({ roomId: z.string() }).strict().parse(req.body);
    store.saveRoom({ ...roomOr404(roomId), activePresetId: preset.id });
    return state();
  });

  /** Back to the automatic (recommended) schedule. */
  app.delete<{ Params: { roomId: string } }>('/api/rooms/:roomId/preset', async (req): Promise<StateDto> => {
    requireIdle();
    store.saveRoom({ ...roomOr404(req.params.roomId), activePresetId: null });
    return state();
  });

  /* --------------------------------------------------------- recommendation */

  app.get<{ Params: { roomId: string } }>('/api/rooms/:roomId/recommendation', async (req): Promise<RecommendationDto> =>
    buildRecommendation(store, roomOr404(req.params.roomId).id),
  );

  /** Apply the recommended (automatic) setting, or keep the current preset. */
  app.post<{ Params: { roomId: string } }>('/api/rooms/:roomId/recommendation', async (req): Promise<StateDto> => {
    requireIdle();
    const { action } = recommendationBody.parse(req.body);
    answerRecommendation(store, roomOr404(req.params.roomId).id, action);
    return state();
  });

  /* --------------------------------------------------------------- feedback */

  /** Comfort feedback the morning after. It updates the model straight away. */
  app.post('/api/feedback', async (req): Promise<StateDto> => {
    const body = feedbackBody.parse(req.body);
    const night = store.night(body.nightId);
    const sleeper = sleeperOr404(body.sleeperId);
    const mine = night?.sleepers.find((s) => s.sleeperId === sleeper.id);
    if (!night || !mine) throw new RequestError(404, 'not_found', 'That sleeper has no record for that night.');
    if (mine.feedback) throw new RequestError(409, 'already_given', 'Feedback was already given for this night.');
    if (mine.experiencedCoreC !== null) {
      const model = observePreference(sleeper.model, { kind: body.kind, tempC: mine.experiencedCoreC, phase: 'deep', seasonIndex: night.seasonIndex });
      store.saveSleeper({ ...sleeper, model });
    }
    mine.feedback = body.kind;
    const { plan: _plan, trace: _trace, events: _events, ...summary } = night;
    store.updateNightSummary(summary);
    return state();
  });

  /* --------------------------------------------------------------- settings */

  app.patch<{ Params: { id: string } }>('/api/sleepers/:id', async (req): Promise<StateDto> => {
    requireIdle();
    const sleeper = sleeperOr404(req.params.id);
    const patch = sleeperPatch.parse(req.body);
    store.saveSleeper({
      ...sleeper,
      ...patch,
      options: { ...sleeper.options, ...patch.options },
      cycle: patch.cycle ? { lastPeriodStart: patch.cycle.lastPeriodStart, lengthDays: patch.cycle.lengthDays ?? sleeper.cycle.lengthDays } : sleeper.cycle,
      tonight: { ...sleeper.tonight, ...patch.tonight },
    });
    return state();
  });

  /** Forget everything learned about a sleeper and start again from the typical-adult curve. */
  app.post<{ Params: { id: string } }>('/api/sleepers/:id/reset-model', async (req): Promise<StateDto> => {
    requireIdle();
    const sleeper = sleeperOr404(req.params.id);
    store.saveSleeper({ ...sleeper, model: resetModel(sleeper.model) });
    return state();
  });

  app.patch('/api/household', async (req): Promise<StateDto> => {
    requireIdle();
    const h = household();
    const patch = householdPatch.parse(req.body);
    store.saveHousehold({ ...h, ...patch, energy: { ...h.energy, ...patch.energy } });
    // Turning manual control off hands every room back to the automatic schedule.
    if (patch.manualControl === false) {
      for (const room of store.rooms(h.id)) store.saveRoom({ ...room, pendingHold: null, activePresetId: null });
    }
    return state();
  });

  /** Connect the room's thermostat. A room has exactly one. */
  app.post<{ Params: { roomId: string } }>('/api/rooms/:roomId/devices', async (req): Promise<StateDto> => {
    requireIdle();
    const room = roomOr404(req.params.roomId);
    const body = deviceBody.parse(req.body);
    const brand = CLIMATE_BRANDS.find((b) => b.id === body.brand)!;
    if (store.devices(room.id).length > 0) throw new RequestError(409, 'has_thermostat', 'This room already has a thermostat. Remove it first.');
    if (body.equipment && !brand.equipment.includes(body.equipment)) throw new RequestError(400, 'invalid_request', `${brand.name} does not control that equipment.`);
    store.saveDevice({
      id: newId('dev'),
      roomId: room.id,
      brand: brand.id,
      name: body.name ?? brand.name,
      equipment: body.equipment ?? brand.equipment[0] ?? 'central',
    });
    return state();
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req): Promise<StateDto> => {
    requireIdle();
    if (!store.device(req.params.id)) throw new RequestError(404, 'not_found', 'Device not found.');
    store.deleteDevice(req.params.id);
    return state();
  });

  /* ------------------------------------------------------- voice, nap, travel */

  app.post('/api/voice', async (req): Promise<VoiceResponse> => handleVoice(store, live, voiceBody.parse(req.body)));

  app.post('/api/nap', async (req): Promise<NightDetailDto> => {
    const body = napBody.parse(req.body);
    return runNap(store, live, sleeperOr404(body.sleeperId), body.minutes);
  });

  /** Preview a jet-lag schedule without applying it. */
  app.post<{ Params: { id: string } }>('/api/sleepers/:id/jetlag', async (req): Promise<JetLagNight[]> => {
    const sleeper = sleeperOr404(req.params.id);
    return jetLagSchedule({ bedtime: sleeper.bedtime, wakeTime: sleeper.wakeTime, ...jetLagBody.parse(req.body) });
  });

  /** Apply a jet-lag schedule: night plans follow the shifted bedtimes on the dates it covers. */
  app.put<{ Params: { id: string } }>('/api/sleepers/:id/travel', async (req): Promise<StateDto> => {
    requireIdle();
    const sleeper = sleeperOr404(req.params.id);
    const body = jetLagBody.parse(req.body);
    store.saveSleeper({ ...sleeper, travel: { shiftHours: body.shiftHours, arrivalDate: body.arrivalDate, prepareNights: body.prepareNights ?? 3 } });
    return state();
  });

  app.delete<{ Params: { id: string } }>('/api/sleepers/:id/travel', async (req): Promise<StateDto> => {
    requireIdle();
    store.saveSleeper({ ...sleeperOr404(req.params.id), travel: null });
    return state();
  });

  /* -------------------------------------------------------------- assistant */

  app.post('/api/assistant', async (req): Promise<AssistantReplyDto> => answer(store, assistantBody.parse(req.body)));

  /* ------------------------------------------------------------- dashboard */

  if (webRoot && existsSync(webRoot)) {
    void app.register(fastifyStatic, { root: webRoot });
    // The dashboard is a single page: any non-API path gets it.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: 'Not found.' } satisfies ApiError);
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found.' } satisfies ApiError));
  }

  app.addHook('onClose', async () => {
    await live.discard();
  });
  return app;
}

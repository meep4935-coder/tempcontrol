import type {
  AdvanceResponse,
  AssistantEvent,
  HoldDto,
  LiveUpdateDto,
  NightDetailDto,
  NightSummaryDto,
  PlanDto,
  StateDto,
  VoiceResponse,
} from '@tempcontrol/contracts';
import type { Insight, JetLagNight } from '@tempcontrol/engine';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';
import { createDemo } from '../src/setup';
import { Store } from '../src/store';

/** Friday 13 November 2026: a fixed starting evening so every run sees the same weather and weekdays. */
const TODAY = '2026-11-13';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(scenario = 'couple', historyNights = 0, today = TODAY): Promise<{ app: FastifyInstance; store: Store }> {
  const store = new Store(openDb(':memory:'));
  await createDemo(store, scenario, historyNights, { today, seed: 7 });
  app = buildApp({ store });
  return { app, store };
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await app!.inject({ method, url, payload: body as object | undefined });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T };
}

const getState = async (): Promise<StateDto> => (await call<StateDto>('GET', '/api/state')).body;

describe('demo state', () => {
  it('describes the household, sleepers, room and catalog', async () => {
    await start();
    const state = await getState();
    expect(state.household).toMatchObject({ city: 'Montréal', region: 'QC', date: TODAY, season: 'autumn', timeZone: 'America/Toronto' });
    expect(state.sleepers.map((s) => s.name)).toEqual(['Camille', 'Alex']);
    expect(state.sleepers[0]!.wearable).toMatchObject({ id: 'apple-watch', delivery: 'live' });
    expect(state.sleepers[1]!.wearable).toMatchObject({ id: 'oura', delivery: 'morning' });
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]!.sleeperIds).toEqual(state.sleepers.map((s) => s.id));
    expect(state.rooms[0]!.devices.map((d) => d.kind).sort()).toEqual(['fan', 'humidifier', 'thermostat']);
    expect(state.presets).toHaveLength(3);
    expect(state.catalog.wearables.length).toBeGreaterThan(5);
    expect(state.catalog.climate.some((b) => b.id === 'nest')).toBe(true);
    expect(state.tariffs.some((t) => t.id === 'on-tou')).toBe(true);
    expect(state.live).toBeNull();
    // Before any night the model is the typical-adult starting point.
    expect(state.sleepers[0]!.estimate).toMatchObject({ coreC: 18.5, confidence: 0, nights: 0 });
  });

  it('never exposes the stored model or the simulated truth beyond the demo field', async () => {
    await start();
    const sleeper = (await getState()).sleepers[0]! as unknown as Record<string, unknown>;
    expect(sleeper.model).toBeUndefined();
    expect(sleeper.truth).toBeUndefined();
    expect(sleeper.demo).toMatchObject({ trueIdealC: expect.any(Number) });
  });
});

describe('tonight\'s plan', () => {
  it('is a gap-free schedule blended from both sleepers', async () => {
    await start();
    const state = await getState();
    const { status, body: plan } = await call<PlanDto>('GET', `/api/rooms/${state.rooms[0]!.id}/plan`);
    expect(status).toBe(200);
    expect(plan.kind).toBe('night');
    expect(plan.sleepers).toHaveLength(2);
    expect(plan.segments[0]!.startMs).toBe(plan.startMs);
    expect(plan.segments[plan.segments.length - 1]!.endMs).toBe(plan.endMs);
    for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i]!.startMs).toBe(plan.segments[i - 1]!.endMs);
    for (const seg of plan.segments) {
      expect(seg.targetC).toBeGreaterThanOrEqual(plan.limits.minC);
      expect(seg.targetC).toBeLessThanOrEqual(plan.limits.maxC);
      expect(seg.contributions.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 6);
    }
    expect(plan.segments.some((seg) => seg.contributions.length === 2)).toBe(true);
    expect(plan.context.mode).toBe('heat');
    expect(plan.hold).toBeNull();
  });

  it('answers 404 for an unknown room', async () => {
    await start();
    expect((await call('GET', '/api/rooms/nope/plan')).status).toBe(404);
  });
});

describe('simulating nights', () => {
  it('runs nights, saves them, learns, and moves the calendar on', async () => {
    await start();
    const { status, body } = await call<AdvanceResponse>('POST', '/api/sim/advance', { nights: 14 });
    expect(status).toBe(200);
    expect(body.nights).toHaveLength(14);
    expect(body.nights[0]!.date).toBe(TODAY);
    expect(body.nights[13]!.date).toBe('2026-11-26');
    expect(body.state.household.date).toBe('2026-11-27');

    for (const s of body.state.sleepers) {
      expect(s.estimate.nights).toBe(14);
      expect(s.estimate.confidence).toBeGreaterThan(0.3);
    }
    // The two partners want different things, and the models have started to tell them apart.
    const [camille, alex] = body.state.sleepers;
    expect(alex!.estimate.coreC).toBeGreaterThan(camille!.estimate.coreC);

    const night = body.nights[13]!;
    expect(night.sleepers).toHaveLength(2);
    expect(night.sleepers[0]!.quality).toBeGreaterThan(40);
    expect(night.kWh).toBeGreaterThan(0);
    expect(night.baselineKWh).toBeGreaterThan(0);
  });

  it('lists saved nights oldest first and returns the full record of one', async () => {
    await start('couple', 5);
    const state = await getState();
    const roomId = state.rooms[0]!.id;
    const { body: nights } = await call<NightSummaryDto[]>('GET', `/api/rooms/${roomId}/nights?limit=3`);
    expect(nights.map((n) => n.date)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);

    const { body: detail } = await call<NightDetailDto>('GET', `/api/nights/${nights[2]!.id}`);
    expect(detail.trace.length).toBeGreaterThan(90);
    expect(detail.trace[0]!.setpointC).toBe(detail.plan.segments[0]!.targetC);
    expect(detail.trace.every((tick, i) => i === 0 || tick.t - detail.trace[i - 1]!.t === 5 * 60_000)).toBe(true);
    expect(detail.plan.segments.length).toBeGreaterThan(3);
    expect((await call('GET', '/api/nights/nope')).status).toBe(404);
  });

  it('is repeatable: the same demo gives the same nights', async () => {
    await start('couple', 4);
    const a = (await getState()).sleepers.map((s) => s.estimate.coreC);
    await app!.close();
    await start('couple', 4);
    const b = (await getState()).sleepers.map((s) => s.estimate.coreC);
    expect(b).toEqual(a);
  });

  it('validates the request', async () => {
    await start();
    expect((await call('POST', '/api/sim/advance', { nights: 0 })).status).toBe(400);
    expect((await call('POST', '/api/sim/advance', { nights: 500 })).status).toBe(400);
    expect((await call('POST', '/api/sim/advance', {})).status).toBe(400);
  });
});

describe('manual temperature', () => {
  it('overrides the whole of the next night, then lapses', async () => {
    await start();
    const state = await getState();
    const room = state.rooms[0]!;
    const sleeper = state.sleepers[1]!;

    const { status, body: hold } = await call<HoldDto>('POST', `/api/rooms/${room.id}/hold`, { targetC: 21.5, sleeperId: sleeper.id });
    expect(status).toBe(200);
    expect(hold).toMatchObject({ targetC: 21.5, source: 'app', minutes: null });
    expect((await getState()).rooms[0]!.hold).toMatchObject({ targetC: 21.5 });
    expect((await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body.hold).toMatchObject({ targetC: 21.5 });

    const { body } = await call<AdvanceResponse>('POST', '/api/sim/advance', { nights: 1 });
    const { body: night } = await call<NightDetailDto>('GET', `/api/nights/${body.nights[0]!.id}`);
    expect(night.trace.every((tick) => tick.source === 'hold' && tick.setpointC === 21.5)).toBe(true);
    expect(night.manualChanges).toBeGreaterThanOrEqual(1);
    expect(night.events.some((e) => e.kind === 'manual' && e.source === 'app' && e.targetC === 21.5)).toBe(true);

    // The choice counts as a statement of preference for the sleeper who made it.
    const after = body.state.sleepers.find((s) => s.id === sleeper.id)!;
    expect(after.estimate.preferences).toBeGreaterThanOrEqual(1);
    expect(after.estimate.coreC).toBeGreaterThan(19.5);
    // And it does not carry over to the following night.
    expect(body.state.rooms[0]!.hold).toBeNull();
  });

  it('can be timed, and cancelled', async () => {
    await start();
    const room = (await getState()).rooms[0]!;
    await call('POST', `/api/rooms/${room.id}/hold`, { targetC: 22, minutes: 60 });
    const { body } = await call<AdvanceResponse>('POST', '/api/sim/advance', { nights: 1 });
    const { body: night } = await call<NightDetailDto>('GET', `/api/nights/${body.nights[0]!.id}`);
    const held = night.trace.filter((tick) => tick.source === 'hold');
    expect(held).toHaveLength(12);
    expect(night.trace.slice(12).every((tick) => tick.source === 'plan')).toBe(true);
    expect(night.events.some((e) => e.kind === 'resume')).toBe(true);

    await call('POST', `/api/rooms/${room.id}/hold`, { targetC: 22 });
    expect((await call('DELETE', `/api/rooms/${room.id}/hold`)).status).toBe(204);
    expect((await getState()).rooms[0]!.hold).toBeNull();
  });

  it('rejects temperatures outside the safety bounds', async () => {
    await start();
    const room = (await getState()).rooms[0]!;
    expect((await call('POST', `/api/rooms/${room.id}/hold`, { targetC: 40 })).status).toBe(400);
    expect((await call('POST', `/api/rooms/${room.id}/hold`, { targetC: 5 })).status).toBe(400);
    expect((await call('POST', `/api/rooms/${room.id}/hold`, { targetC: 20, sleeperId: 'nope' })).status).toBe(404);
  });
});

describe('presets', () => {
  it('creates, edits and deletes', async () => {
    await start();
    const created = await call<{ id: string; name: string }>('POST', '/api/presets', { name: 'Movie night', kind: 'hold', targetC: 20.5 });
    expect(created.status).toBe(200);
    expect(created.body.name).toBe('Movie night');
    expect((await getState()).presets).toHaveLength(4);

    const edited = await call<{ targetC: number }>('PUT', `/api/presets/${created.body.id}`, { name: 'Movie night', kind: 'hold', targetC: 19.5 });
    expect(edited.body.targetC).toBe(19.5);

    expect((await call('DELETE', `/api/presets/${created.body.id}`)).status).toBe(204);
    expect((await getState()).presets).toHaveLength(3);
    expect((await call('POST', '/api/presets', { name: 'Broken', kind: 'curve' })).status).toBe(400);
    expect((await call('POST', '/api/presets', { name: '', kind: 'hold', targetC: 20 })).status).toBe(400);
  });

  it('turns a fixed-temperature preset into a hold', async () => {
    await start();
    const state = await getState();
    const preset = state.presets.find((p) => p.kind === 'hold')!;
    const { body } = await call<StateDto>('POST', `/api/presets/${preset.id}/activate`, { roomId: state.rooms[0]!.id });
    expect(body.rooms[0]!.hold).toMatchObject({ targetC: preset.targetC, source: 'preset', presetName: preset.name });
  });

  it('lets a curve preset replace the algorithm\'s temperatures until it is cleared', async () => {
    await start('solo');
    const state = await getState();
    const room = state.rooms[0]!;
    const curve = state.presets.find((p) => p.kind === 'curve')!;
    await call('POST', `/api/presets/${curve.id}/activate`, { roomId: room.id });

    const { body: plan } = await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`);
    expect(plan.presetName).toBe(curve.name);
    const own = plan.sleepers[0]!.segments;
    expect(own.find((s) => s.phase === 'deep')!.targetC).toBe(curve.temps!.deep);
    expect(own.find((s) => s.phase === 'rem')!.targetC).toBe(curve.temps!.rem);
    expect(own[own.length - 1]!.targetC).toBe(curve.temps!.wake);

    await call('DELETE', `/api/rooms/${room.id}/preset`);
    expect((await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body.presetName).toBeNull();
  });
});

describe('settings', () => {
  it('updates a sleeper and replans', async () => {
    await start('solo');
    const state = await getState();
    const sleeper = state.sleepers[0]!;
    const room = state.rooms[0]!;
    const before = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body;

    const { status, body } = await call<StateDto>('PATCH', `/api/sleepers/${sleeper.id}`, {
      bedtime: '22:00',
      wakeTime: '06:00',
      units: 'F',
      locale: 'fr',
      limits: { minC: 17, maxC: 22 },
      options: { explore: false },
    });
    expect(status).toBe(200);
    expect(body.sleepers[0]).toMatchObject({ bedtime: '22:00', wakeTime: '06:00', units: 'F', locale: 'fr', limits: { minC: 17, maxC: 22 } });
    expect(body.sleepers[0]!.options).toMatchObject({ explore: false, recoveryAware: true });

    const after = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body;
    expect(after.sleepers[0]!.bedtimeMs).toBe(before.sleepers[0]!.bedtimeMs - 60 * 60_000);
    expect(after.sleepers[0]!.explorationC).toBe(0);
  });

  it('rejects malformed settings', async () => {
    await start('solo');
    const id = (await getState()).sleepers[0]!.id;
    expect((await call('PATCH', `/api/sleepers/${id}`, { bedtime: '25:00' })).status).toBe(400);
    expect((await call('PATCH', `/api/sleepers/${id}`, { limits: { minC: 24, maxC: 18 } })).status).toBe(400);
    expect((await call('PATCH', `/api/sleepers/${id}`, { units: 'K' })).status).toBe(400);
    expect((await call('PATCH', `/api/sleepers/${id}`, { wearableBrand: 'nope' })).status).toBe(400);
    expect((await call('PATCH', `/api/sleepers/${id}`, { model: {} })).status).toBe(400);
    expect((await call('PATCH', '/api/sleepers/nope', { units: 'F' })).status).toBe(404);
  });

  it('applies tonight\'s flags to tonight only', async () => {
    await start('solo');
    const state = await getState();
    const sleeper = state.sleepers[0]!;
    const room = state.rooms[0]!;
    await call('PATCH', `/api/sleepers/${sleeper.id}`, { tonight: { alcohol: true } });
    const plan = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body;
    expect(plan.sleepers[0]!.modifiers.map((m) => m.id)).toContain('alcohol');

    const { body } = await call<AdvanceResponse>('POST', '/api/sim/advance', { nights: 1 });
    expect(body.state.sleepers[0]!.tonight.alcohol).toBe(false);
    // A night shaped by alcohol is not used to judge temperature.
    expect(body.nights[0]!.sleepers[0]!.outcomeUsed).toBe(false);
  });

  it('switches a wearable between live and morning delivery', async () => {
    await start('solo');
    const id = (await getState()).sleepers[0]!.id;
    const { body } = await call<StateDto>('PATCH', `/api/sleepers/${id}`, { wearableBrand: 'apple-watch' });
    expect(body.sleepers[0]!.wearable).toMatchObject({ id: 'apple-watch', delivery: 'live' });
  });

  it('forgets what it learned when asked', async () => {
    await start('solo', 6);
    const before = (await getState()).sleepers[0]!;
    // Most nights count; one shaped by illness or alcohol would not.
    expect(before.estimate.nights).toBeGreaterThanOrEqual(4);
    const { body } = await call<StateDto>('POST', `/api/sleepers/${before.id}/reset-model`);
    expect(body.sleepers[0]!.estimate).toMatchObject({ nights: 0, preferences: 0, confidence: 0 });
  });

  it('updates household settings', async () => {
    await start('solo');
    const { body } = await call<StateDto>('PATCH', '/api/household', { tariffId: 'on-ulo', energy: { toleranceC: 1 }, daySetpointC: 20 });
    expect(body.household).toMatchObject({ tariffId: 'on-ulo', energy: { enabled: true, toleranceC: 1 }, daySetpointC: 20 });
    expect((await call('PATCH', '/api/household', { tariffId: 'nope' })).status).toBe(400);
    expect((await call('PATCH', '/api/household', { energy: { toleranceC: 9 } })).status).toBe(400);
  });
});

describe('devices', () => {
  it('needs a thermostat to plan, and accepts a replacement', async () => {
    await start('solo');
    const state = await getState();
    const room = state.rooms[0]!;
    const thermostat = room.devices.find((d) => d.kind === 'thermostat')!;

    await call('DELETE', `/api/devices/${thermostat.id}`);
    const blocked = await call<{ error: string }>('GET', `/api/rooms/${room.id}/plan`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('no_thermostat');
    expect((await call('POST', '/api/sim/advance', { nights: 1 })).status).toBe(409);

    const { body } = await call<StateDto>('POST', `/api/rooms/${room.id}/devices`, { kind: 'thermostat', brand: 'sinope', equipment: 'baseboard' });
    expect(body.rooms[0]!.devices.find((d) => d.kind === 'thermostat')).toMatchObject({ brand: 'sinope', equipment: 'baseboard' });
    expect((await call('GET', `/api/rooms/${room.id}/plan`)).status).toBe(200);
  });

  it('checks that the brand makes the device and that fans belong to someone', async () => {
    await start('solo');
    const state = await getState();
    const room = state.rooms[0]!;
    const sleeper = state.sleepers[0]!;
    expect((await call('POST', `/api/rooms/${room.id}/devices`, { kind: 'thermostat', brand: 'nest' })).status).toBe(409);
    expect((await call('POST', `/api/rooms/${room.id}/devices`, { kind: 'fan', brand: 'nest', sleeperId: sleeper.id })).status).toBe(400);
    expect((await call('POST', `/api/rooms/${room.id}/devices`, { kind: 'fan', brand: 'smart-plug' })).status).toBe(400);
    const { body } = await call<StateDto>('POST', `/api/rooms/${room.id}/devices`, { kind: 'fan', brand: 'smart-plug', sleeperId: sleeper.id });
    expect(body.rooms[0]!.devices.find((d) => d.kind === 'fan')).toMatchObject({ sleeperId: sleeper.id });
    expect((await call('POST', `/api/rooms/${room.id}/devices`, { kind: 'fan', brand: 'dyson', sleeperId: sleeper.id })).status).toBe(409);
  });
});

describe('energy mode', () => {
  // Sam wakes at 07:30; Ontario's winter on-peak price starts at 07:00 on weekdays.
  it('warms the room before the on-peak price on a weekday, and leaves weekends alone', async () => {
    // Sunday evening into Monday morning.
    await start('solo', 0, '2026-11-15');
    const state = await getState();
    const room = state.rooms[0]!;
    await call('PATCH', `/api/sleepers/${state.sleepers[0]!.id}`, { options: { explore: false } });
    const weekday = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body;
    expect(weekday.energy).toMatchObject({ enabled: true, direction: 'heat', toleranceC: 0.5 });
    expect(weekday.energy.periods.map((p) => p.rate)).toEqual(['offPeak', 'onPeak']);
    expect(weekday.energy.changes.map((c) => c.kind)).toEqual(['preheat', 'coast']);

    await app!.close();
    // Friday evening into Saturday morning: off-peak all night.
    await start('solo', 0, '2026-11-13');
    const weekendRoom = (await getState()).rooms[0]!;
    const weekend = (await call<PlanDto>('GET', `/api/rooms/${weekendRoom.id}/plan`)).body;
    expect(weekend.energy.periods.map((p) => p.rate)).toEqual(['offPeak']);
    expect(weekend.energy.changes).toEqual([]);
  });

  it('does not reshape the plan when switched off', async () => {
    await start('solo', 0, '2026-11-15');
    const room = (await getState()).rooms[0]!;
    await call('PATCH', '/api/household', { energy: { enabled: false } });
    const plan = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body;
    expect(plan.energy.enabled).toBe(false);
    expect(plan.energy.changes).toEqual([]);
  });

  it('prepares for a declared Hydro-Quebec peak event, once', async () => {
    await start('couple', 0, '2026-12-15');
    const room = (await getState()).rooms[0]!;
    await call('PATCH', '/api/household', { peakEvent: 'morning' });
    const plan = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body;
    expect(plan.energy.periods.some((p) => p.peakEvent)).toBe(true);
    expect(plan.energy.changes.some((c) => c.peakEvent && c.kind === 'coast')).toBe(true);

    const { body } = await call<AdvanceResponse>('POST', '/api/sim/advance', { nights: 1 });
    expect(body.state.household.peakEvent).toBeNull();
  });
});

describe('live night', () => {
  const pollUntilFinished = async (): Promise<LiveUpdateDto> => {
    for (let i = 0; i < 400; i++) {
      const { body } = await call<LiveUpdateDto>('GET', '/api/live?since=0');
      if (body.session?.status === 'finished') return body;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the live night did not finish in time');
  };

  it('plays a whole night and saves it', async () => {
    await start();
    const room = (await getState()).rooms[0]!;
    const started = await call<LiveUpdateDto>('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 10 });
    expect(started.status).toBe(200);
    expect(started.body.session).toMatchObject({ status: 'running', roomId: room.id, nightId: null });
    expect(started.body.plan!.segments.length).toBeGreaterThan(3);
    expect((await getState()).live).toMatchObject({ status: 'running' });

    const done = await pollUntilFinished();
    expect(done.session!.nightId).not.toBeNull();
    expect(done.ticks.length).toBe(done.session!.ticks);
    const state = await getState();
    expect(state.household.date).toBe('2026-11-14');
    expect(state.sleepers[0]!.estimate.nights).toBe(1);
    expect((await call('GET', `/api/nights/${done.session!.nightId}`)).status).toBe(200);
  }, 20_000);

  it('returns only new ticks after the cursor', async () => {
    await start();
    const room = (await getState()).rooms[0]!;
    await call('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 60 });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const all = (await call<LiveUpdateDto>('GET', '/api/live?since=0')).body;
    expect(all.ticks.length).toBeGreaterThan(0);
    const none = (await call<LiveUpdateDto>('GET', `/api/live?since=${all.ticks.length + 50}`)).body;
    expect(none.ticks).toEqual([]);
    expect(none.session!.status).toBe('running');
  }, 20_000);

  it('obeys a manual temperature set mid-night, and goes back to the plan when it is cancelled', async () => {
    await start();
    const state = await getState();
    const room = state.rooms[0]!;
    await call('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 60 });
    await new Promise((resolve) => setTimeout(resolve, 2600));

    const hold = await call<HoldDto>('POST', `/api/rooms/${room.id}/hold`, { targetC: 23, sleeperId: state.sleepers[0]!.id });
    expect(hold.body).toMatchObject({ targetC: 23, source: 'app' });
    const during = (await call<LiveUpdateDto>('GET', '/api/live?since=0')).body;
    expect(during.hold).toMatchObject({ targetC: 23 });
    const before = during.ticks.length;

    await call('DELETE', `/api/rooms/${room.id}/hold`);
    const finished = (await call<LiveUpdateDto>('POST', '/api/live/finish')).body;
    expect(finished.session!.status).toBe('finished');
    expect(finished.hold).toBeNull();
    const kinds = finished.events.map((e) => e.kind);
    expect(kinds).toContain('manual');
    expect(kinds).toContain('resume');
    // After the cancel the thermostat is back on the plan.
    expect(finished.ticks.slice(before + 2).every((tick) => tick.source === 'plan')).toBe(true);
    expect(finished.ticks.length).toBe(finished.session!.ticks);
  }, 20_000);

  it('holds the manual temperature for every interval it is in force', async () => {
    await start();
    const room = (await getState()).rooms[0]!;
    await call('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 60 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await call('POST', `/api/rooms/${room.id}/hold`, { targetC: 23 });
    const at = (await call<LiveUpdateDto>('GET', '/api/live?since=0')).body.ticks.length;
    const finished = (await call<LiveUpdateDto>('POST', '/api/live/finish')).body;
    const after = finished.ticks.slice(at + 1);
    expect(after.length).toBeGreaterThan(50);
    expect(after.every((tick) => tick.source === 'hold' && tick.setpointC === 23)).toBe(true);
  }, 20_000);

  it('refuses a second night, simulation and setting changes while one is playing', async () => {
    await start();
    const state = await getState();
    const room = state.rooms[0]!;
    await call('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 600 });
    expect((await call('POST', '/api/live/start', { roomId: room.id })).status).toBe(409);
    expect((await call('POST', '/api/sim/advance', { nights: 1 })).status).toBe(409);
    expect((await call('PATCH', `/api/sleepers/${state.sleepers[0]!.id}`, { bedtime: '21:00' })).status).toBe(409);
    expect((await call('PATCH', '/api/household', { daySetpointC: 20 })).status).toBe(409);
    await call('POST', '/api/live/finish');
    expect((await call('POST', '/api/sim/advance', { nights: 1 })).status).toBe(200);
  }, 20_000);

  it('can be ended early with "good morning"', async () => {
    await start();
    const room = (await getState()).rooms[0]!;
    await call('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 60 });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const woken = (await call<LiveUpdateDto>('POST', '/api/live/wake')).body;
    expect(woken.session!.status).toBe('finished');
    expect(woken.events.some((e) => e.kind === 'wake')).toBe(true);
    const night = (await call<NightDetailDto>('GET', `/api/nights/${woken.session!.nightId}`)).body;
    expect(night.endMs).toBeLessThan(night.plan.endMs);
    expect((await getState()).household.date).toBe('2026-11-14');
  }, 20_000);

  it('reports no session when none has been started', async () => {
    await start();
    expect((await call<LiveUpdateDto>('GET', '/api/live')).body).toEqual({ session: null, plan: null, ticks: [], events: [], hold: null });
    expect((await call<LiveUpdateDto>('POST', '/api/live/finish')).body.session).toBeNull();
  });
});

describe('voice', () => {
  const say = async (text: string, sleeperId: string): Promise<VoiceResponse> => (await call<VoiceResponse>('POST', '/api/voice', { text, sleeperId })).body;

  it('sets a temperature, in either language, replying in the speaker\'s own', async () => {
    await start();
    const [camille, alex] = (await getState()).sleepers;
    const fr = await say('mets la chambre à 19 degrés', camille!.id);
    expect(fr.outcome).toEqual({ type: 'held', targetC: 19, untilMorning: true });
    expect(fr.reply).toMatch(/19/);
    expect(fr.reply).toMatch(/°C/);
    expect((await getState()).rooms[0]!.hold).toMatchObject({ targetC: 19, source: 'voice', sleeperId: camille!.id });

    const en = await say('set the bedroom to 68', alex!.id);
    expect(en.outcome).toEqual({ type: 'held', targetC: 20, untilMorning: true });
    expect(en.reply).toMatch(/20/);
  });

  it('nudges relative to the current setting and goes back to automatic', async () => {
    await start();
    const [, alex] = (await getState()).sleepers;
    const warmer = await say('a bit warmer', alex!.id);
    expect(warmer.outcome).toEqual({ type: 'adjusted', targetC: 21.5, deltaC: 0.5 });
    const cooler = await say('2 degrees cooler', alex!.id);
    expect(cooler.outcome).toEqual({ type: 'adjusted', targetC: 19.5, deltaC: -2 });
    const resumed = await say('back to automatic', alex!.id);
    expect(resumed.outcome).toEqual({ type: 'resumed' });
    expect((await getState()).rooms[0]!.hold).toBeNull();
  });

  it('reports status, activates presets, and declines what it cannot understand', async () => {
    await start();
    const state = await getState();
    const alex = state.sleepers[1]!;
    const status = await say("what's the temperature?", alex.id);
    expect(status.outcome).toMatchObject({ type: 'status', mode: 'idle', targetC: null });

    const preset = state.presets.find((p) => p.kind === 'hold')!;
    const activated = await say(`activate preset ${preset.name}`, alex.id);
    expect(activated.outcome).toEqual({ type: 'presetActivated', name: preset.name });
    expect((await getState()).rooms[0]!.hold).toMatchObject({ source: 'preset', targetC: preset.targetC });

    const lost = await say('play some jazz', alex.id);
    expect(lost.outcome).toEqual({ type: 'notUnderstood' });
    const far = await say('set it to 45 celsius', alex.id);
    expect(far.outcome.type).toBe('outOfRange');
    expect((await call('POST', '/api/voice', { text: 'warmer', sleeperId: 'nope' })).status).toBe(404);
    expect((await call('POST', '/api/voice', { text: '', sleeperId: alex.id })).status).toBe(400);
  });

  it('starts the night on "good night", takes "I\'m hot" as feedback, and ends it on "good morning"', async () => {
    await start();
    const state = await getState();
    const camille = state.sleepers[0]!;
    const night = await say('bonne nuit', camille.id);
    expect(night.outcome.type).toBe('nightStarted');
    expect((await getState()).live).toMatchObject({ status: 'running' });

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const hot = await say("j'ai chaud", camille.id);
    expect(hot.outcome).toMatchObject({ type: 'adjusted', deltaC: -1 });
    const live = (await call<LiveUpdateDto>('GET', '/api/live?since=0')).body;
    expect(live.events.some((e) => e.kind === 'feeling' && e.feeling === 'tooHot' && e.sleeperId === camille.id)).toBe(true);
    expect(live.hold).toMatchObject({ source: 'voice' });

    const morning = await say('bonjour, je suis réveillée', camille.id);
    expect(morning.outcome).toEqual({ type: 'nightEnded' });
    expect((await getState()).live).toMatchObject({ status: 'finished' });
  }, 20_000);
});

describe('naps and travel', () => {
  it('runs a nap without touching the model or the calendar', async () => {
    await start('solo', 3);
    const before = await getState();
    const sleeper = before.sleepers[0]!;
    const { status, body: nap } = await call<NightDetailDto>('POST', '/api/nap', { sleeperId: sleeper.id, minutes: 30 });
    expect(status).toBe(200);
    expect(nap.kind).toBe('nap');
    expect(nap.endMs - nap.startMs).toBe(35 * 60_000);
    expect(nap.plan.segments.map((s) => s.phase)).toEqual(['onset', 'wake']);

    const after = await getState();
    expect(after.household.date).toBe(before.household.date);
    expect(after.sleepers[0]!.estimate).toEqual(before.sleepers[0]!.estimate);
    const naps = (await call<NightSummaryDto[]>('GET', `/api/rooms/${before.rooms[0]!.id}/nights?kind=nap`)).body;
    expect(naps).toHaveLength(1);
    expect((await call<NightSummaryDto[]>('GET', `/api/rooms/${before.rooms[0]!.id}/nights`)).body).toHaveLength(3);
    expect((await call('POST', '/api/nap', { sleeperId: sleeper.id, minutes: 2 })).status).toBe(400);
  });

  it('previews a jet-lag schedule and applies it to the coming nights', async () => {
    await start('solo');
    const state = await getState();
    const sleeper = state.sleepers[0]!;
    const room = state.rooms[0]!;
    const usual = (await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body.sleepers[0]!.bedtimeMs;

    const trip = { shiftHours: 6, arrivalDate: '2026-11-16', prepareNights: 3 };
    const { body: preview } = await call<JetLagNight[]>('POST', `/api/sleepers/${sleeper.id}/jetlag`, trip);
    expect(preview[0]).toMatchObject({ date: TODAY, where: 'home', bedtime: '22:15', offsetMin: -45 });

    const applied = await call<StateDto>('PUT', `/api/sleepers/${sleeper.id}/travel`, trip);
    expect(applied.body.sleepers[0]!.travel).toEqual(trip);
    expect((await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body.sleepers[0]!.bedtimeMs).toBe(usual - 45 * 60_000);

    const cleared = await call<StateDto>('DELETE', `/api/sleepers/${sleeper.id}/travel`);
    expect(cleared.body.sleepers[0]!.travel).toBeNull();
    expect((await call<PlanDto>('GET', `/api/rooms/${room.id}/plan`)).body.sleepers[0]!.bedtimeMs).toBe(usual);
  });
});

describe('feedback and insights', () => {
  it('learns from morning feedback, once per night', async () => {
    await start('solo', 3);
    const state = await getState();
    const sleeper = state.sleepers[0]!;
    const nights = (await call<NightSummaryDto[]>('GET', `/api/rooms/${state.rooms[0]!.id}/nights`)).body;
    const night = nights.find((n) => n.sleepers[0]!.feedback === null)!;
    expect(night).toBeDefined();

    const { status, body } = await call<StateDto>('POST', '/api/feedback', { nightId: night.id, sleeperId: sleeper.id, kind: 'tooCold' });
    expect(status).toBe(200);
    expect(body.sleepers[0]!.estimate.preferences).toBe(sleeper.estimate.preferences + 1);
    expect(body.sleepers[0]!.estimate.coreC).toBeGreaterThan(sleeper.estimate.coreC);
    const saved = (await call<NightDetailDto>('GET', `/api/nights/${night.id}`)).body;
    expect(saved.sleepers[0]!.feedback).toBe('tooCold');

    expect((await call('POST', '/api/feedback', { nightId: night.id, sleeperId: sleeper.id, kind: 'tooCold' })).status).toBe(409);
    expect((await call('POST', '/api/feedback', { nightId: 'nope', sleeperId: sleeper.id, kind: 'tooHot' })).status).toBe(404);
    expect((await call('POST', '/api/feedback', { nightId: night.id, sleeperId: sleeper.id, kind: 'meh' })).status).toBe(400);
  });

  it('builds insights from history', async () => {
    await start('solo', 20);
    const sleeper = (await getState()).sleepers[0]!;
    const { status, body } = await call<Insight[]>('GET', `/api/sleepers/${sleeper.id}/insights`);
    expect(status).toBe(200);
    expect(body.some((i) => i.id === 'ideal')).toBe(true);
    expect(body.some((i) => i.id === 'energy')).toBe(true);
  });
});

describe('assistant', () => {
  const ask = async (payload: object): Promise<{ status: number; events: AssistantEvent[]; type: string }> => {
    const res = await app!.inject({ method: 'POST', url: '/api/assistant', payload });
    const events = res.body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
    return { status: res.statusCode, events, type: String(res.headers['content-type']) };
  };

  it('answers from computed insights when no AI model is configured', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      await start('couple', 8);
      const state = await getState();
      expect(state.assistant.ai).toBe(false);

      const fr = await ask({ sleeperId: state.sleepers[0]!.id, message: 'Pourquoi fait-il plus frais ce soir ?' });
      expect(fr.status).toBe(200);
      expect(fr.type).toContain('text/event-stream');
      expect(fr.events[fr.events.length - 1]).toEqual({ type: 'done', source: 'rules' });
      const text = fr.events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
      expect(text).toContain('Votre température idéale');
      // The other partner gets the same kind of answer in their own language.
      const en = await ask({ sleeperId: state.sleepers[1]!.id, message: 'How am I sleeping?' });
      expect(en.events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')).toContain('Your ideal deep-sleep temperature');
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });

  it('validates the request before opening a stream', async () => {
    await start('solo');
    const id = (await getState()).sleepers[0]!.id;
    expect((await call('POST', '/api/assistant', { sleeperId: id, message: '' })).status).toBe(400);
    expect((await call('POST', '/api/assistant', { sleeperId: 'nope', message: 'hi' })).status).toBe(404);
  });
});

describe('reset', () => {
  it('switches scenario and can back-date some history', async () => {
    await start('couple', 3);
    const { status, body } = await call<StateDto>('POST', '/api/sim/reset', { scenario: 'night-sweats', nights: 2 });
    expect(status).toBe(200);
    expect(body.household.city).toBe('Ottawa');
    expect(body.sleepers.map((s) => s.name)).toEqual(['Dominique']);
    expect(body.sleepers[0]!.options.menopauseMode).toBe(true);
    expect(body.sleepers[0]!.estimate.nights).toBe(2);
    expect(body.rooms[0]!.devices.some((d) => d.kind === 'fan')).toBe(true);
    expect((await call('POST', '/api/sim/reset', { scenario: 'nope' })).status).toBe(400);
  });

  it('abandons a night that is playing without saving it', async () => {
    await start('couple', 0);
    const room = (await getState()).rooms[0]!;
    await call('POST', '/api/live/start', { roomId: room.id, secondsPerNight: 10 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { body } = await call<StateDto>('POST', '/api/sim/reset', { scenario: 'solo' });
    expect(body.live).toBeNull();
    expect(body.household.city).toBe('Toronto');
    const date = body.household.date;
    // Give the abandoned night time to have finished, had it still been running.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const later = await getState();
    expect(later.household.date).toBe(date);
    expect(later.sleepers[0]!.estimate.nights).toBe(0);
    expect((await call<NightSummaryDto[]>('GET', `/api/rooms/${later.rooms[0]!.id}/nights`)).body).toEqual([]);
  }, 20_000);

  it('answers unknown API paths with a JSON 404', async () => {
    await start();
    const res = await call<{ error: string }>('GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

/** Typed calls to the server. Every shape comes from @tempcontrol/contracts. */

import type {
  AdvanceResponse,
  ApiError,
  AssistantReplyDto,
  FeedbackKind,
  HoldDto,
  HouseholdPatch,
  JetLagNight,
  JetLagRequest,
  LiveUpdateDto,
  NewDevice,
  NewPreset,
  NightDetailDto,
  NightSummaryDto,
  PlanDto,
  RecommendationDto,
  SleeperPatch,
  StateDto,
  VoiceResponse,
  Insight,
} from '@tempcontrol/contracts';

/** A failed request, carrying the server's own explanation. */
export class RequestFailed extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestFailed(0, 'network', 'The server could not be reached.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = data as ApiError | undefined;
    throw new RequestFailed(res.status, err?.error ?? 'error', err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

export const api = {
  state: () => call<StateDto>('GET', '/api/state'),
  plan: (roomId: string) => call<PlanDto>('GET', `/api/rooms/${roomId}/plan`),
  recommendation: (roomId: string) => call<RecommendationDto>('GET', `/api/rooms/${roomId}/recommendation`),
  answerRecommendation: (roomId: string, action: 'apply' | 'keep') => call<StateDto>('POST', `/api/rooms/${roomId}/recommendation`, { action }),
  nights: (roomId: string, limit = 120) => call<NightSummaryDto[]>('GET', `/api/rooms/${roomId}/nights?limit=${limit}`),
  night: (id: string) => call<NightDetailDto>('GET', `/api/nights/${id}`),
  insights: (sleeperId: string) => call<Insight[]>('GET', `/api/sleepers/${sleeperId}/insights`),

  advance: (nights: number) => call<AdvanceResponse>('POST', '/api/sim/advance', { nights }),
  reset: (scenario: string, nights: number) => call<StateDto>('POST', '/api/sim/reset', { scenario, nights }),

  liveStart: (roomId: string, secondsPerNight: number) => call<LiveUpdateDto>('POST', '/api/live/start', { roomId, secondsPerNight }),
  live: (since: number) => call<LiveUpdateDto>('GET', `/api/live?since=${since}`),
  liveFinish: () => call<LiveUpdateDto>('POST', '/api/live/finish'),
  liveWake: () => call<LiveUpdateDto>('POST', '/api/live/wake'),

  hold: (roomId: string, targetC: number, minutes: number | null, sleeperId?: string) =>
    call<HoldDto>('POST', `/api/rooms/${roomId}/hold`, { targetC, minutes, sleeperId }),
  clearHold: (roomId: string) => call<void>('DELETE', `/api/rooms/${roomId}/hold`),
  createPreset: (preset: NewPreset) => call<unknown>('POST', '/api/presets', preset),
  deletePreset: (id: string) => call<void>('DELETE', `/api/presets/${id}`),
  activatePreset: (id: string, roomId: string) => call<StateDto>('POST', `/api/presets/${id}/activate`, { roomId }),
  clearPreset: (roomId: string) => call<StateDto>('DELETE', `/api/rooms/${roomId}/preset`),

  feedback: (nightId: string, sleeperId: string, kind: FeedbackKind) => call<StateDto>('POST', '/api/feedback', { nightId, sleeperId, kind }),
  patchSleeper: (id: string, patch: SleeperPatch) => call<StateDto>('PATCH', `/api/sleepers/${id}`, patch),
  resetModel: (id: string) => call<StateDto>('POST', `/api/sleepers/${id}/reset-model`),
  patchHousehold: (patch: HouseholdPatch) => call<StateDto>('PATCH', '/api/household', patch),
  addDevice: (roomId: string, device: NewDevice) => call<StateDto>('POST', `/api/rooms/${roomId}/devices`, device),
  removeDevice: (id: string) => call<StateDto>('DELETE', `/api/devices/${id}`),

  voice: (text: string, sleeperId: string) => call<VoiceResponse>('POST', '/api/voice', { text, sleeperId }),
  nap: (sleeperId: string, minutes: number) => call<NightDetailDto>('POST', '/api/nap', { sleeperId, minutes }),
  jetLag: (sleeperId: string, req: JetLagRequest) => call<JetLagNight[]>('POST', `/api/sleepers/${sleeperId}/jetlag`, req),
  applyTravel: (sleeperId: string, req: JetLagRequest) => call<StateDto>('PUT', `/api/sleepers/${sleeperId}/travel`, req),
  clearTravel: (sleeperId: string) => call<StateDto>('DELETE', `/api/sleepers/${sleeperId}/travel`),
  ask: (sleeperId: string, message: string) => call<AssistantReplyDto>('POST', '/api/assistant', { sleeperId, message }),
};

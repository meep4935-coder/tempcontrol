/** Thin client for the TempControl HTTP API. Shapes come from @tempcontrol/contracts. */

import type {
  AdvanceResponse,
  ApiError,
  AssistantEvent,
  AssistantRequest,
  FeedbackRequest,
  HoldDto,
  HoldRequest,
  HouseholdPatch,
  Insight,
  JetLagNight,
  JetLagRequest,
  LiveUpdateDto,
  NapRequest,
  NewDevice,
  NewPreset,
  NightDetailDto,
  NightSummaryDto,
  PlanDto,
  PresetDto,
  SleeperPatch,
  StateDto,
  VoiceRequest,
  VoiceResponse,
} from '@tempcontrol/contracts';

/** An error answered by the server (`{ error, message }`) or a network failure (`code: 'network'`). */
export class RequestFailed extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function readError(res: Response): Promise<RequestFailed> {
  try {
    const body = (await res.json()) as Partial<ApiError>;
    return new RequestFailed(body.error ?? 'http_' + res.status, body.message ?? res.statusText, res.status);
  } catch {
    return new RequestFailed('http_' + res.status, res.statusText || 'Request failed', res.status);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new RequestFailed('network', err instanceof Error ? err.message : 'Network error', 0);
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (v: unknown) => v;

export const api = {
  state: () => call<StateDto>('GET', '/api/state'),
  plan: (roomId: string) => call<PlanDto>('GET', `/api/rooms/${encodeURIComponent(roomId)}/plan`),
  nights: (roomId: string, limit = 90, kind: 'night' | 'nap' = 'night') =>
    call<NightSummaryDto[]>('GET', `/api/rooms/${encodeURIComponent(roomId)}/nights?limit=${limit}&kind=${kind}`),
  night: (id: string) => call<NightDetailDto>('GET', `/api/nights/${encodeURIComponent(id)}`),
  insights: (sleeperId: string) => call<Insight[]>('GET', `/api/sleepers/${encodeURIComponent(sleeperId)}/insights`),

  advance: (nights: number) => call<AdvanceResponse>('POST', '/api/sim/advance', json({ nights })),
  reset: (scenario: string, nights: number) => call<StateDto>('POST', '/api/sim/reset', json({ scenario, nights })),

  liveStart: (roomId: string, secondsPerNight: number) => call<LiveUpdateDto>('POST', '/api/live/start', json({ roomId, secondsPerNight })),
  live: (since: number) => call<LiveUpdateDto>('GET', `/api/live?since=${since}`),
  liveFinish: () => call<LiveUpdateDto>('POST', '/api/live/finish'),
  liveWake: () => call<LiveUpdateDto>('POST', '/api/live/wake'),

  setHold: (roomId: string, body: HoldRequest) => call<HoldDto>('POST', `/api/rooms/${encodeURIComponent(roomId)}/hold`, body),
  clearHold: (roomId: string) => call<void>('DELETE', `/api/rooms/${encodeURIComponent(roomId)}/hold`),

  createPreset: (body: NewPreset) => call<PresetDto>('POST', '/api/presets', body),
  updatePreset: (id: string, body: NewPreset) => call<PresetDto>('PUT', `/api/presets/${encodeURIComponent(id)}`, body),
  deletePreset: (id: string) => call<void>('DELETE', `/api/presets/${encodeURIComponent(id)}`),
  activatePreset: (id: string, roomId: string, sleeperId?: string) =>
    call<StateDto>('POST', `/api/presets/${encodeURIComponent(id)}/activate`, sleeperId ? { roomId, sleeperId } : { roomId }),
  clearPreset: (roomId: string) => call<StateDto>('DELETE', `/api/rooms/${encodeURIComponent(roomId)}/preset`),

  feedback: (body: FeedbackRequest) => call<StateDto>('POST', '/api/feedback', body),

  patchSleeper: (id: string, patch: SleeperPatch) => call<StateDto>('PATCH', `/api/sleepers/${encodeURIComponent(id)}`, patch),
  resetModel: (id: string) => call<StateDto>('POST', `/api/sleepers/${encodeURIComponent(id)}/reset-model`),
  patchHousehold: (patch: HouseholdPatch) => call<StateDto>('PATCH', '/api/household', patch),
  addDevice: (roomId: string, body: NewDevice) => call<StateDto>('POST', `/api/rooms/${encodeURIComponent(roomId)}/devices`, body),
  removeDevice: (id: string) => call<StateDto>('DELETE', `/api/devices/${encodeURIComponent(id)}`),

  voice: (body: VoiceRequest) => call<VoiceResponse>('POST', '/api/voice', body),
  nap: (body: NapRequest) => call<NightDetailDto>('POST', '/api/nap', body),
  jetlagPreview: (sleeperId: string, body: JetLagRequest) =>
    call<JetLagNight[]>('POST', `/api/sleepers/${encodeURIComponent(sleeperId)}/jetlag`, body),
  applyTravel: (sleeperId: string, body: JetLagRequest) => call<StateDto>('PUT', `/api/sleepers/${encodeURIComponent(sleeperId)}/travel`, body),
  clearTravel: (sleeperId: string) => call<StateDto>('DELETE', `/api/sleepers/${encodeURIComponent(sleeperId)}/travel`),
};

/**
 * Ask the assistant. The answer arrives as server-sent events; `onEvent` is
 * called for each one as it is parsed. Resolves when the stream ends.
 */
export async function askAssistant(body: AssistantRequest, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    throw new RequestFailed('network', err instanceof Error ? err.message : 'Network error', 0);
  }
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new RequestFailed('network', 'Empty response', res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (chunk: string): void => {
    const data = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    try {
      onEvent(JSON.parse(data) as AssistantEvent);
    } catch {
      onEvent({ type: 'error', message: 'Unreadable reply from the server.' });
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      flush(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

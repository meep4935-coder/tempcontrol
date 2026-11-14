/** A night played back fast: watch the control loop, interrupt it, then answer the morning question. */

import type { EventDto, FeedbackKind, LiveUpdateDto, NightDetailDto, StateDto, TickDto } from '@tempcontrol/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PlanChart, SeriesChart } from '../charts';
import { useApp, type Format } from '../store';
import type { Key } from '../i18n';

export interface Live {
  /** True while a night is playing, and afterwards until the morning summary is closed. */
  active: boolean;
  update: LiveUpdateDto | null;
  ticks: TickDto[];
  night: NightDetailDto | null;
  begin: (first: LiveUpdateDto) => void;
  replace: (latest: LiveUpdateDto) => void;
  close: () => void;
}

export function useLive(): Live {
  const { state, refresh } = useApp();
  const [update, setUpdate] = useState<LiveUpdateDto | null>(null);
  const [night, setNight] = useState<NightDetailDto | null>(null);
  const [closedId, setClosedId] = useState<string | null>(null);
  const ticks = useRef<TickDto[]>([]);
  const sessionId = useRef<string | null>(null);

  const take = useCallback((u: LiveUpdateDto, whole: boolean) => {
    if (!u.session) return;
    if (whole || sessionId.current !== u.session.id) {
      sessionId.current = u.session.id;
      ticks.current = whole ? [...u.ticks] : [];
      if (!whole) return; // ticks for a session first seen mid-way are fetched from the start on the next poll
    } else if (u.ticks.length > 0) {
      ticks.current = [...ticks.current, ...u.ticks];
    }
    setUpdate(u);
  }, []);

  const running = (update?.session?.status ?? state?.live?.status) === 'running';
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const u = await api.live(sessionId.current ? ticks.current.length : 0);
        if (!stopped) take(u, false);
      } catch {
        /* a missed poll is retried on the next one */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 500);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [running, take]);

  // When the night ends, load what was saved and refresh everything else.
  const finishedNightId = update?.session?.status === 'finished' ? update.session.nightId : null;
  useEffect(() => {
    if (!finishedNightId) return;
    let stale = false;
    void (async () => {
      try {
        const saved = await api.night(finishedNightId);
        if (!stale) setNight(saved);
      } catch {
        /* the summary is optional; the history section has the night either way */
      }
      await refresh();
    })();
    return () => {
      stale = true;
    };
  }, [finishedNightId, refresh]);

  const id = update?.session?.id ?? null;
  return {
    active: id !== null && id !== closedId && (running || update?.session?.status === 'finished'),
    update,
    ticks: ticks.current,
    night,
    begin: (first) => {
      setNight(null);
      take(first, true);
    },
    replace: (latest) => take(latest, true),
    close: () => {
      setClosedId(id);
      setNight(null);
    },
  };
}

/** One event in plain language. */
export function eventText(e: EventDto, names: Record<string, string>, t: (k: Key, p?: Record<string, string | number>) => string, fmt: Format): string {
  const name = 'sleeperId' in e && e.sleeperId ? (names[e.sleeperId] ?? '') : '';
  switch (e.kind) {
    case 'live':
      return t(`event.live.${e.reason}`, { name, delta: fmt.delta(e.deltaC) });
    case 'manual':
      return t(e.source === 'device' ? 'event.manual.device' : e.source === 'voice' ? 'event.manual.voice' : e.source === 'preset' ? 'event.manual.preset' : 'event.manual.app', {
        name: name || t('event.someone'),
        temp: fmt.temp(e.targetC),
        preset: e.presetName ?? '',
      });
    case 'resume':
      return t('event.resume');
    case 'feeling':
      return t(e.feeling === 'tooHot' ? 'event.feeling.hot' : e.feeling === 'tooCold' ? 'event.feeling.cold' : 'event.feeling.right', { name });
    case 'energy':
      return t(`event.energy.${e.change}`, { delta: fmt.delta(e.deltaC) }) + (e.peakEvent ? ` ${t('why.peak')}` : '');
    case 'wake':
      return t('event.wake');
  }
}

const FEELING: Record<'en' | 'fr', { hot: string; cold: string }> = {
  en: { hot: "I'm hot", cold: "I'm cold" },
  fr: { hot: "j'ai chaud", cold: "j'ai froid" },
};

export function LivePanel({ live, state, names }: { live: Live; state: StateDto; names: Record<string, string> }) {
  const { t, fmt, run, busy } = useApp();
  const [said, setSaid] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, FeedbackKind>>({});
  const u = live.update;
  if (!u?.session || !u.plan) return null;
  const running = u.session.status === 'running';
  const ticks = live.ticks;
  const last = ticks[ticks.length - 1];
  const room = state.rooms[0]!;
  const events = [...u.events].sort((a, b) => b.t - a.t);
  const watched = state.sleepers.filter((s) => ticks.some((k) => k.vitals[s.id]?.heartRate !== undefined));
  const labels = ticks.map((k) => fmt.clock(k.t));

  const feel = (sleeperId: string, kind: 'hot' | 'cold'): void => {
    const sleeper = state.sleepers.find((s) => s.id === sleeperId)!;
    void run(
      async () => {
        const res = await api.voice(FEELING[sleeper.locale][kind], sleeperId);
        setSaid(`${sleeper.name}: ${res.reply}`);
      },
      { refresh: false },
    );
  };
  const nudge = (delta: number): void => {
    const base = last?.setpointC ?? u.plan!.segments[0]!.targetC;
    void run(() => api.hold(room.id, Math.min(28, Math.max(12, base + delta)), null), { refresh: false });
  };

  return (
    <section className="card live" aria-labelledby="live-title">
      <header className="row between">
        <h2 id="live-title">{running ? t('live.title') : t('live.finished')}</h2>
        {running && last && (
          <p className="clock" aria-live="off">
            {fmt.clock(last.t)} · {fmt.temp(last.roomTempC)}
            {last.setpointC !== null ? ` → ${fmt.temp(last.setpointC)}` : ''}
          </p>
        )}
      </header>
      <PlanChart plan={u.plan} ticks={ticks} names={names} />

      {running ? (
        <>
          <div className="row wrap">
            {state.sleepers.map((s) => (
              <span key={s.id} className="row">
                <button disabled={busy} onClick={() => feel(s.id, 'hot')}>
                  {t('live.tooWarm', { name: s.name })}
                </button>
                <button disabled={busy} onClick={() => feel(s.id, 'cold')}>
                  {t('live.tooCold', { name: s.name })}
                </button>
              </span>
            ))}
          </div>
          {state.household.manualControl && (
            <div className="row wrap">
              <span className="muted">{t('live.manual')}</span>
              <button disabled={busy} onClick={() => nudge(-0.5)}>
                − {fmt.delta(0.5)}
              </button>
              <button disabled={busy} onClick={() => nudge(0.5)}>
                + {fmt.delta(0.5)}
              </button>
              {u.hold && (
                <button disabled={busy} onClick={() => void run(() => api.clearHold(room.id), { refresh: false })}>
                  {t('manual.resume')}
                </button>
              )}
            </div>
          )}
          <div className="row wrap">
            <button className="primary" disabled={busy} onClick={() => void run(async () => live.replace(await api.liveFinish()), { refresh: false })}>
              {t('live.skip')}
            </button>
            <button disabled={busy} onClick={() => void run(async () => live.replace(await api.liveWake()), { refresh: false })}>
              {t('live.wake')}
            </button>
          </div>
          {said && (
            <p className="reply" role="status">
              {said}
            </p>
          )}
        </>
      ) : (
        <Morning live={live} state={state} answered={answered} setAnswered={setAnswered} />
      )}

      <div className="grid-2">
        <div>
          <h3>{t('live.events')}</h3>
          {events.length === 0 ? (
            <p className="muted">{t('live.noEvents')}</p>
          ) : (
            <ol className="feed">
              {events.map((e, i) => (
                <li key={`${e.t}-${i}`}>
                  <time>{fmt.clock(e.t)}</time> {eventText(e, names, t, fmt)}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <h3>{t('live.vitals')}</h3>
          {watched.length === 0 ? (
            <p className="muted">{t('live.noVitals')}</p>
          ) : (
            watched.map((s) => (
              <div key={s.id}>
                <p className="small muted">{t('live.heartRate', { name: s.name })}</p>
                <SeriesChart
                  height={120}
                  labels={labels}
                  aria={t('live.heartRate', { name: s.name })}
                  format={(v) => `${Math.round(v)}`}
                  series={[{ id: 'hr', label: t('live.bpm'), color: 'c1', values: ticks.map((k) => k.vitals[s.id]?.heartRate ?? null) }]}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function Morning({
  live,
  state,
  answered,
  setAnswered,
}: {
  live: Live;
  state: StateDto;
  answered: Record<string, FeedbackKind>;
  setAnswered: (next: Record<string, FeedbackKind>) => void;
}) {
  const { t, fmt, run, busy } = useApp();
  const night = live.night;
  if (!night) return <p className="muted">{t('live.saving')}</p>;
  const saved = night.baselineKWh - night.kWh;
  return (
    <div className="morning-summary">
      <ul className="plain">
        <li>{t('morning.room', { avg: fmt.temp(night.avgRoomTempC), target: fmt.temp(night.coreTargetC) })}</li>
        <li>{t(saved >= 0 ? 'morning.energyLess' : 'morning.energyMore', { kwh: fmt.num(Math.abs(saved)), used: fmt.num(night.kWh) })}</li>
        <li>{t('morning.adjustments', { live: night.liveAdjustments, manual: night.manualChanges })}</li>
      </ul>
      {night.sleepers.map((s) => {
        const sleeper = state.sleepers.find((x) => x.id === s.sleeperId);
        if (!sleeper) return null;
        const given = answered[s.sleeperId] ?? s.feedback ?? null;
        return (
          <div key={s.sleeperId} className="row wrap">
            <strong>
              {sleeper.name}
              {s.quality !== null ? ` · ${t('morning.score', { score: Math.round(s.quality) })}` : ''}
            </strong>
            {given ? (
              <span className="muted">
                {t(`feedback.${given}`)} · {t('morning.thanks')}
              </span>
            ) : (
              <>
                <span className="muted">{t('morning.ask')}</span>
                {(['tooHot', 'justRight', 'tooCold'] as const).map((kind) => (
                  <button
                    key={kind}
                    className="chip"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.feedback(night.id, s.sleeperId, kind);
                        setAnswered({ ...answered, [s.sleeperId]: kind });
                      })
                    }
                  >
                    {t(`feedback.${kind}`)}
                  </button>
                ))}
              </>
            )}
          </div>
        );
      })}
      <button className="primary" onClick={live.close}>
        {t('morning.done')}
      </button>
    </div>
  );
}

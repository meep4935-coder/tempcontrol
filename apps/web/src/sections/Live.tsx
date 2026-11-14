/** A night played back fast: watch the control loop, interrupt it, then answer the morning question. */

import type { EventDto, FeedbackKind, LiveUpdateDto, NightDetailDto, StateDto, TickDto } from '@tempcontrol/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Curve, Ring } from '../charts';
import type { Key } from '../i18n';
import { useApp, type Format } from '../store';
import { Icon } from '../ui';

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
      return t('event.manual', { temp: fmt.temp(e.targetC) });
    case 'resume':
      return t('event.resume');
    case 'feeling':
      return t(e.feeling === 'tooHot' ? 'event.feeling.hot' : e.feeling === 'tooCold' ? 'event.feeling.cold' : 'event.feeling.right', { name });
    case 'energy':
      return t('event.energy');
    case 'wake':
      return t('event.wake');
  }
}

const FEELING: Record<'en' | 'fr', { hot: string; cold: string }> = {
  en: { hot: "I'm hot", cold: "I'm cold" },
  fr: { hot: "j'ai chaud", cold: "j'ai froid" },
};

/** The night while it plays: one big number, two buttons. */
export function LiveNight({ live, state }: { live: Live; state: StateDto }) {
  const { me, t, fmt, run, busy } = useApp();
  const [said, setSaid] = useState<string | null>(null);
  const u = live.update;
  if (!u?.session || !u.plan || !me) return <p className="empty">{t('loading')}</p>;
  if (u.session.status !== 'running') return <Morning live={live} state={state} />;
  const ticks = live.ticks;
  const last = ticks[ticks.length - 1];
  const names = Object.fromEntries(state.sleepers.map((s) => [s.id, s.name]));
  const events = [...u.events].sort((a, b) => b.t - a.t).slice(0, 3);
  const heart = last?.vitals[me.id]?.heartRate;

  const feel = (kind: 'hot' | 'cold'): void => {
    void run(async () => setSaid((await api.voice(FEELING[me.locale][kind], me.id)).reply), { refresh: false });
  };

  return (
    <div className="stack">
      <section className="hero night" aria-labelledby="live-label">
        <div className="hero-top">
          <span className="hero-mode">
            {last ? fmt.clock(last.t) : fmt.clock(u.session.startMs)}
            {last?.phase ? ` · ${t(`phase.${last.phase}`)}` : ''}
          </span>
          {heart !== undefined && (
            <span className="hero-mode">
              <Icon name="heart" size={14} /> {Math.round(heart)}
            </span>
          )}
        </div>
        <p className="hero-number">{last ? fmt.deg(last.roomTempC) : '–'}</p>
        <p className="hero-label" id="live-label">
          {last?.setpointC == null || Math.abs(last.setpointC - last.roomTempC) < 0.3 ? t('live.steady') : t(last.setpointC < last.roomTempC ? 'live.cooling' : 'live.warming')}
        </p>
        <Curve startMs={u.plan.startMs} endMs={u.plan.endMs} segments={u.plan.segments} ticks={ticks} height={96} aria={t('hero.curve')} deg={fmt.deg} clock={fmt.clock} />
      </section>

      <div className="pair">
        <button className="big" disabled={busy} onClick={() => feel('hot')}>
          <Icon name="sun" /> {t('live.tooWarm')}
        </button>
        <button className="big" disabled={busy} onClick={() => feel('cold')}>
          <Icon name="snow" /> {t('live.tooCold')}
        </button>
      </div>
      {said && (
        <p className="reply" role="status">
          {said}
        </p>
      )}

      <section className="card">
        <h2>{t('live.events')}</h2>
        {events.length === 0 ? (
          <p className="muted">{t('live.noEvents')}</p>
        ) : (
          <ol className="feed">
            {events.map((e, i) => (
              <li key={`${e.t}-${i}`}>
                <time>{fmt.clock(e.t)}</time>
                <span>{eventText(e, names, t, fmt)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <button className="wide" disabled={busy} onClick={() => void run(async () => live.replace(await api.liveFinish()), { refresh: false })}>
        {t('live.skip')}
      </button>
    </div>
  );
}

function Morning({ live, state }: { live: Live; state: StateDto }) {
  const { me, t, fmt, run, busy } = useApp();
  const [answered, setAnswered] = useState<FeedbackKind | null>(null);
  const night = live.night;
  if (!night || !me) return <p className="empty">{t('live.saving')}</p>;
  const mine = night.sleepers.find((s) => s.sleeperId === me.id);
  const others = night.sleepers.filter((s) => s.sleeperId !== me.id);
  const savedCents = night.baselineCostCents - night.costCents;
  const given = answered ?? mine?.feedback ?? null;

  return (
    <div className="stack">
      <section className="card morning">
        <h2>{t('morning.title', { name: me.name })}</h2>
        <Ring value={mine?.quality ?? null} size={132} label={t('score')} />
        <p className="muted">{t('score')}</p>
        {others.map((o) => (
          <p key={o.sleeperId} className="muted">
            {state.sleepers.find((s) => s.id === o.sleeperId)?.name}: {o.quality === null ? '–' : Math.round(o.quality)}
          </p>
        ))}
      </section>

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">{t('morning.room')}</span>
          <span className="tile-number">{fmt.deg(night.avgRoomTempC)}</span>
          <span className="tile-note">{t('morning.roomNote')}</span>
        </div>
        <div className="tile">
          <span className="tile-label">{savedCents >= 0 ? t('tile.saved') : t('tile.extra')}</span>
          <span className="tile-number">{fmt.money(savedCents)}</span>
          <span className="tile-note">{t('morning.savedNote')}</span>
        </div>
      </div>

      {mine && (
        <section className="card">
          <h2>{t('morning.ask')}</h2>
          {given ? (
            <p className="ok">
              <Icon name="check" size={16} /> {t(`feedback.${given}`)} · {t('morning.thanks')}
            </p>
          ) : (
            <div className="trio">
              {(['tooHot', 'justRight', 'tooCold'] as const).map((kind) => (
                <button
                  key={kind}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.feedback(night.id, me.id, kind);
                      setAnswered(kind);
                    })
                  }
                >
                  {t(`feedback.${kind}`)}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <button className="primary wide" onClick={live.close}>
        {t('morning.done')}
      </button>
    </div>
  );
}

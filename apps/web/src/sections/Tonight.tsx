import type { PlanDto, RecommendationDto, ScheduleStepDto, SleeperDto, StateDto } from '@tempcontrol/contracts';
import { describeInsight, type Phase } from '@tempcontrol/engine';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Meter, PlanChart } from '../charts';
import { useApp } from '../store';
import { LivePanel, useLive } from './Live';

/** One line per part of the night: when it starts and the temperature it settles at. */
function summarise(steps: readonly ScheduleStepDto[]): { phase: Phase; startMs: number; targetC: number }[] {
  const out: { phase: Phase; startMs: number; targetC: number }[] = [];
  for (const phase of ['onset', 'deep', 'rem', 'wake'] as Phase[]) {
    const mine = steps.filter((s) => s.phase === phase);
    if (mine.length > 0) out.push({ phase, startMs: mine[0]!.startMs, targetC: mine[mine.length - 1]!.targetC });
  }
  return out;
}

function Schedule({ steps }: { steps: readonly ScheduleStepDto[] }) {
  const { t, fmt } = useApp();
  return (
    <ol className="schedule">
      {summarise(steps).map((s) => (
        <li key={s.phase}>
          <span className="schedule-temp">{fmt.temp(s.targetC)}</span>
          <span>{t(`phase.${s.phase}`)}</span>
          <span className="muted">{t('rec.from', { time: fmt.clock(s.startMs) })}</span>
        </li>
      ))}
    </ol>
  );
}

function Recommendation({ rec, state }: { rec: RecommendationDto; state: StateDto }) {
  const { t, fmt, locale, units, run, busy } = useApp();
  const name = (id: string): string => state.sleepers.find((s) => s.id === id)?.name ?? '';
  const answer = (action: 'apply' | 'keep'): void => {
    void run(() => api.answerRecommendation(rec.roomId, action), { done: action === 'apply' ? t('rec.appliedToast') : t('rec.keptToast') });
  };

  return (
    <section className="card recommendation" aria-labelledby="rec-title">
      <h2 id="rec-title">{t('rec.title')}</h2>
      <div className="rec-grid">
        <div>
          <h3>{t('rec.dataSuggest')}</h3>
          {rec.findings.map((f) => (
            <div key={f.sleeperId} className="finding">
              <p>
                {f.nights === 0
                  ? t('rec.noData', { name: name(f.sleeperId), ideal: fmt.temp(f.idealC) })
                  : t('rec.suggest', { name: name(f.sleeperId), ideal: fmt.temp(f.idealC), sd: fmt.delta(f.sdC), nights: f.nights })}
                {f.lastNight && f.lastNight.experiencedCoreC !== null && f.lastNight.quality !== null
                  ? ` ${t('rec.last', { temp: fmt.temp(f.lastNight.experiencedCoreC), score: Math.round(f.lastNight.quality) })}`
                  : ''}
              </p>
              {f.insights.length > 0 && (
                <ul className="plain">
                  {f.insights.map((i) => (
                    <li key={i.id}>{describeInsight(i, { locale, units })}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <div>
          <h3>{t('rec.weRecommend')}</h3>
          <Schedule steps={rec.recommended} />
          {rec.mode === 'auto' && <p className="note good">{t('rec.auto')}</p>}
          {rec.mode === 'preset' && rec.current && (
            <>
              <p>
                {t('rec.presetNow', { name: rec.presetName ?? '', temp: fmt.temp(summarise(rec.current).find((s) => s.phase === 'deep')?.targetC ?? 0) })}{' '}
                {Math.abs(rec.deepDifferenceC) < 0.25
                  ? t('rec.diffSame')
                  : t(rec.deepDifferenceC < 0 ? 'rec.diffCooler' : 'rec.diffWarmer', { delta: fmt.delta(rec.deepDifferenceC) })}
              </p>
              {rec.status === 'kept' ? (
                <p className="note">{t('rec.kept')}</p>
              ) : (
                <div className="row">
                  <button className="primary" disabled={busy} onClick={() => answer('apply')}>
                    {t('rec.apply')}
                  </button>
                  <button disabled={busy} onClick={() => answer('keep')}>
                    {t('rec.keep')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Plain-language reasons tonight's plan looks the way it does. */
function reasons(plan: PlanDto, state: StateDto, t: ReturnType<typeof useApp>['t'], fmt: ReturnType<typeof useApp>['fmt']): string[] {
  const out: string[] = [];
  const name = (id: string): string => state.sleepers.find((s) => s.id === id)?.name ?? '';
  if (plan.hold) out.push(t('why.hold', { temp: fmt.temp(plan.hold.targetC) }));
  if (plan.presetName) out.push(t('why.preset', { name: plan.presetName }));
  for (const s of plan.sleepers) {
    for (const m of s.modifiers) {
      out.push(t(`why.mod.${m.id}`, { name: name(s.sleeperId), delta: fmt.delta(m.deltaC), dir: t(m.deltaC < 0 ? 'dir.cooler' : 'dir.warmer') }));
    }
    if (s.explorationC !== 0) {
      out.push(t('why.explore', { name: name(s.sleeperId), delta: fmt.delta(s.explorationC), dir: t(s.explorationC < 0 ? 'dir.cooler' : 'dir.warmer') }));
    }
  }
  if (plan.sleepers.length > 1) out.push(t('why.shared', { gap: fmt.delta(plan.gapC) }));
  for (const c of plan.energy.changes) {
    out.push(t(`why.energy.${c.kind}`, { from: fmt.clock(c.startMs), to: fmt.clock(c.endMs), delta: fmt.delta(c.deltaC) }) + (c.peakEvent ? ` ${t('why.peak')}` : ''));
  }
  if (plan.context.seasonIndex > 0.3 && !plan.presetName && !plan.hold) out.push(t('why.winter'));
  return out;
}

function SleeperCard({ sleeper }: { sleeper: SleeperDto }) {
  const { t, fmt } = useApp();
  const e = sleeper.estimate;
  return (
    <article className="card sleeper">
      <header>
        <h3>{sleeper.name}</h3>
        <span className={`badge ${sleeper.wearable.delivery}`}>
          {sleeper.wearable.name} · {t(sleeper.wearable.delivery === 'live' ? 'wearable.live' : 'wearable.morning')}
        </span>
      </header>
      <p className="stat">
        <span className="stat-value">{fmt.temp(e.coreC)}</span>
        <span className="muted"> ± {fmt.delta(e.sdC)}</span>
      </p>
      <p className="stat-label">{t('sleeper.ideal')}</p>
      <div className="meter-row">
        <Meter value={e.confidence} label={t('sleeper.personalised')} />
        <span>{t('sleeper.personalisedPct', { pct: Math.round(e.confidence * 100) })}</span>
      </div>
      <p className="muted small">
        {t('sleeper.nights', { nights: e.nights })} · {sleeper.bedtime}–{sleeper.wakeTime}
      </p>
      {sleeper.demo && (
        <p className="demo-note small">
          {t('sleeper.truth', { temp: fmt.temp(sleeper.demo.trueIdealC) })}
        </p>
      )}
    </article>
  );
}

function ManualControl({ state, plan }: { state: StateDto; plan: PlanDto | null }) {
  const { t, fmt, run, busy } = useApp();
  const room = state.rooms[0]!;
  const deep = plan?.segments.find((s) => s.phase === 'deep')?.targetC;
  const [target, setTarget] = useState<number>(room.hold?.targetC ?? deep ?? 20);
  const [minutes, setMinutes] = useState<'morning' | '60'>('morning');
  const [who, setWho] = useState(state.sleepers[0]?.id ?? '');
  const live = state.live?.status === 'running';

  if (!state.household.manualControl) {
    return (
      <section className="card">
        <h2>{t('manual.title')}</h2>
        <p>{t('manual.off')}</p>
        <button disabled={busy || live} onClick={() => void run(() => api.patchHousehold({ manualControl: true }))}>
          {t('manual.turnOn')}
        </button>
      </section>
    );
  }
  const active = state.presets.find((p) => p.id === room.activePresetId);
  return (
    <section className="card">
      <h2>{t('manual.title')}</h2>
      <p className="muted">{t('manual.on')}</p>
      <div className="row wrap">
        <div className="stepper" role="group" aria-label={t('manual.temperature')}>
          <button aria-label={t('manual.lower')} onClick={() => setTarget((v) => Math.max(12, v - 0.5))}>
            −
          </button>
          <output>{fmt.temp(target)}</output>
          <button aria-label={t('manual.raise')} onClick={() => setTarget((v) => Math.min(28, v + 0.5))}>
            +
          </button>
        </div>
        <label>
          <span className="sr">{t('manual.duration')}</span>
          <select value={minutes} onChange={(e) => setMinutes(e.target.value as 'morning' | '60')}>
            <option value="morning">{t('manual.untilMorning')}</option>
            <option value="60">{t('manual.oneHour')}</option>
          </select>
        </label>
        {state.sleepers.length > 1 && (
          <label>
            <span className="sr">{t('manual.who')}</span>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {state.sleepers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="primary" disabled={busy} onClick={() => void run(() => api.hold(room.id, target, minutes === 'morning' ? null : 60, who || undefined))}>
          {t('manual.set')}
        </button>
      </div>
      {room.hold && <p className="note">{t('manual.holdSet', { temp: fmt.temp(room.hold.targetC) })}</p>}

      <h3>{t('manual.presets')}</h3>
      <div className="row wrap">
        {state.presets.map((p) => (
          <button key={p.id} className={p.id === room.activePresetId ? 'chip on' : 'chip'} disabled={busy || live} onClick={() => void run(() => api.activatePreset(p.id, room.id))}>
            {p.name}
            {p.kind === 'hold' && p.targetC !== undefined ? ` · ${fmt.temp(p.targetC)}` : ''}
          </button>
        ))}
      </div>
      {active && <p className="note">{t('manual.presetActive', { name: active.name })}</p>}
      {(room.hold || active) && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (room.hold) await api.clearHold(room.id);
              if (active && !live) await api.clearPreset(room.id);
            })
          }
        >
          {t('manual.resume')}
        </button>
      )}
    </section>
  );
}

const EXAMPLES: Record<'en' | 'fr', string[]> = {
  en: ["I'm hot", "What's the temperature?", 'Set the bedroom to 19', 'Good night'],
  fr: ["J'ai froid", 'Quelle est la température ?', 'Mets la chambre à 19', 'Bonne nuit'],
};

interface SpeechRecognitionLike {
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
}

function Voice({ state }: { state: StateDto }) {
  const { t, refresh, run } = useApp();
  const [who, setWho] = useState(state.sleepers[0]?.id ?? '');
  const [text, setText] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [speak, setSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const sleeper = state.sleepers.find((s) => s.id === who) ?? state.sleepers[0];
  const Recognition = (globalThis as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
    .SpeechRecognition ?? (globalThis as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

  if (!sleeper) return null;
  const send = (phrase: string): void => {
    if (!phrase.trim()) return;
    void run(
      async () => {
        const res = await api.voice(phrase, sleeper.id);
        setReply(res.reply);
        setText('');
        if (speak && 'speechSynthesis' in globalThis) {
          const u = new SpeechSynthesisUtterance(res.reply);
          u.lang = sleeper.locale === 'fr' ? 'fr-CA' : 'en-CA';
          speechSynthesis.speak(u);
        }
        await refresh();
      },
      { refresh: false },
    );
  };
  const listen = (): void => {
    if (!Recognition) return;
    const rec = new Recognition();
    rec.lang = sleeper.locale === 'fr' ? 'fr-CA' : 'en-CA';
    rec.onresult = (e) => send(e.results[0]?.[0]?.transcript ?? '');
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  return (
    <section className="card">
      <h2>{t('voice.title')}</h2>
      <p className="muted">{t('voice.intro')}</p>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        {state.sleepers.length > 1 && (
          <label>
            <span className="sr">{t('voice.who')}</span>
            <select value={sleeper.id} onChange={(e) => setWho(e.target.value)}>
              {state.sleepers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grow">
          <span className="sr">{t('voice.say')}</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('voice.placeholder')} />
        </label>
        {Recognition && (
          <button type="button" className={listening ? 'on' : ''} onClick={listen} aria-label={t('voice.mic')}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z" fill="currentColor" />
            </svg>
          </button>
        )}
        <button className="primary" type="submit">
          {t('voice.send')}
        </button>
      </form>
      <div className="row wrap">
        {EXAMPLES[sleeper.locale].map((p) => (
          <button key={p} className="chip" onClick={() => send(p)}>
            {p}
          </button>
        ))}
      </div>
      {reply && (
        <p className="reply" role="status">
          {reply}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> {t('voice.speak')}
      </label>
    </section>
  );
}

function Demo({ state, onPlay }: { state: StateDto; onPlay: (seconds: number) => void }) {
  const { t, locale, run, busy } = useApp();
  const [speed, setSpeed] = useState(60);
  const [scenario, setScenario] = useState(state.scenarios[0]?.id ?? 'couple');
  const tariff = state.tariffs.find((x) => x.id === state.household.tariffId);
  const live = state.live?.status === 'running';
  const current = state.scenarios.find((s) => s.id === scenario);

  return (
    <section className="card demo" aria-labelledby="demo-title">
      <h2 id="demo-title">{t('demo.title')}</h2>
      <p className="muted">{t('demo.intro')}</p>

      <h3>{t('demo.run')}</h3>
      <div className="row wrap">
        <label>
          <span className="sr">{t('demo.speed')}</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={30}>{t('demo.speed30')}</option>
            <option value={60}>{t('demo.speed60')}</option>
            <option value={120}>{t('demo.speed120')}</option>
          </select>
        </label>
        <button className="primary" disabled={busy || live} onClick={() => onPlay(speed)}>
          {t('demo.play')}
        </button>
        {[1, 7, 30].map((n) => (
          <button key={n} disabled={busy || live} onClick={() => void run(() => api.advance(n), { done: t('demo.simulated', { n }) })}>
            {t(n === 1 ? 'demo.sim1' : 'demo.simN', { n })}
          </button>
        ))}
      </div>

      <h3>{t('demo.tonightFlags')}</h3>
      {state.sleepers.map((s) => (
        <div key={s.id} className="row wrap">
          {state.sleepers.length > 1 && <strong className="flag-name">{s.name}</strong>}
          {(['alcohol', 'highStrain', 'illness'] as const).map((flag) => (
            <label key={flag} className="check">
              <input
                type="checkbox"
                checked={s.tonight[flag]}
                disabled={busy || live}
                onChange={(e) => void run(() => api.patchSleeper(s.id, { tonight: { [flag]: e.target.checked } }))}
              />{' '}
              {t(`demo.flag.${flag}`)}
            </label>
          ))}
        </div>
      ))}

      {tariff?.hasPeakEvents && (
        <>
          <h3>{t('demo.peak')}</h3>
          <label>
            <span className="sr">{t('demo.peak')}</span>
            <select
              value={state.household.peakEvent ?? ''}
              disabled={busy || live}
              onChange={(e) => void run(() => api.patchHousehold({ peakEvent: e.target.value === '' ? null : (e.target.value as 'morning' | 'evening') }))}
            >
              <option value="">{t('demo.peakNone')}</option>
              <option value="morning">{t('demo.peakMorning')}</option>
              <option value="evening">{t('demo.peakEvening')}</option>
            </select>
          </label>
        </>
      )}

      <h3>{t('demo.scenario')}</h3>
      <div className="row wrap">
        <label>
          <span className="sr">{t('demo.scenario')}</span>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {state.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name[locale]}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={() => void run(() => api.reset(scenario, 0))}>
          {t('demo.resetFresh')}
        </button>
        <button disabled={busy} onClick={() => void run(() => api.reset(scenario, 10))}>
          {t('demo.resetHistory')}
        </button>
      </div>
      {current && <p className="muted small">{current.description[locale]}</p>}
    </section>
  );
}

export function Tonight() {
  const { state, plan, recommendation, planError, t, fmt, locale, run } = useApp();
  const live = useLive();
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live.active) top.current?.scrollIntoView({ block: 'start' });
  }, [live.active]);
  if (!state) return null;
  const room = state.rooms[0];
  const h = state.household;
  const names = Object.fromEntries(state.sleepers.map((s) => [s.id, s.name]));
  const tariff = state.tariffs.find((x) => x.id === h.tariffId);
  const saved = state.savings;
  const why = plan ? reasons(plan, state, t, fmt) : [];

  return (
    <div className="stack" ref={top}>
      <header className="strip">
        <div>
          <h1>{t('tonight.title', { date: fmt.day(h.date) })}</h1>
          <p className="muted">
            {h.city} · {t(`season.${h.season}`)} · {t('tonight.outdoor', { temp: fmt.temp(h.outlook.outdoorC) })}
            {tariff ? ` · ${tariff.name[locale]}` : ''}
          </p>
        </div>
        <div className="tile" aria-label={t('savings.title')}>
          <span className="tile-label">{saved.savedCents >= 0 ? t('savings.saved') : t('savings.extra')}</span>
          <span className="tile-value">{fmt.money(saved.savedCents)}</span>
          <span className="muted small">
            {saved.nights === 0 ? t('savings.none') : t('savings.detail', { kwh: fmt.num(Math.abs(saved.savedKWh)), nights: saved.nights })}
          </span>
        </div>
      </header>

      {live.active ? (
        <LivePanel live={live} state={state} names={names} />
      ) : (
        <>
          {recommendation && <Recommendation rec={recommendation} state={state} />}
          <section className="card" aria-labelledby="plan-title">
            <h2 id="plan-title">{t('plan.title')}</h2>
            {plan ? (
              <>
                <PlanChart plan={plan} names={names} />
                <h3>{t('why.title')}</h3>
                {why.length === 0 ? (
                  <p className="muted">{t('why.none')}</p>
                ) : (
                  <ul className="plain">
                    {why.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="note warn">{planError ?? t('plan.none')}</p>
            )}
          </section>
        </>
      )}

      <div className="grid-2">
        {state.sleepers.map((s) => (
          <SleeperCard key={s.id} sleeper={s} />
        ))}
      </div>
      <div className="grid-2">
        <ManualControl key={`${h.id}-${String(h.manualControl)}`} state={state} plan={plan} />
        <Voice key={h.id} state={state} />
      </div>
      {room && !live.active && (
        <Demo
          key={h.id}
          state={state}
          onPlay={(seconds) =>
            void run(async () => {
              live.begin(await api.liveStart(room.id, seconds));
            })
          }
        />
      )}
    </div>
  );
}

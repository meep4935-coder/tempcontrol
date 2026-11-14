import type { PlanDto, StateDto } from '@tempcontrol/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Curve, Ring, type CurveMark } from '../charts';
import { useApp } from '../store';
import { Icon, Sheet, Stepper } from '../ui';
import { LiveNight, type Live } from './Live';

/** What the thermostat asks for at a given moment of the plan. */
function targetAt(plan: PlanDto, t: number): number {
  let found = plan.segments[0]?.targetC ?? 20;
  for (const s of plan.segments) if (t >= s.startMs) found = s.targetC;
  return found;
}

/** The temperature held for most of the night. */
export function deepTarget(plan: PlanDto): number {
  const deep = plan.segments.filter((s) => s.phase === 'deep');
  return deep.length > 0 ? deep[deep.length - 1]!.targetC : Math.min(...plan.segments.map((s) => s.targetC));
}

/** Short, plain reasons tonight's plan looks the way it does. */
function reasons(plan: PlanDto, state: StateDto, meId: string, t: ReturnType<typeof useApp>['t'], fmt: ReturnType<typeof useApp>['fmt']): string[] {
  const out: string[] = [];
  const who = (id: string): string => (id === meId ? t('you') : (state.sleepers.find((s) => s.id === id)?.name ?? ''));
  if (plan.hold) out.push(t('why.hold', { temp: fmt.temp(plan.hold.targetC) }));
  if (plan.presetName) out.push(t('why.preset', { name: plan.presetName }));
  if (plan.sleepers.length > 1) out.push(t('why.shared'));
  for (const s of plan.sleepers) {
    for (const m of s.modifiers) out.push(t(`why.mod.${m.id}`, { name: who(s.sleeperId), delta: fmt.delta(m.deltaC), dir: t(m.deltaC < 0 ? 'dir.cooler' : 'dir.warmer') }));
    if (s.explorationC !== 0) out.push(t('why.explore', { name: who(s.sleeperId), delta: fmt.delta(s.explorationC), dir: t(s.explorationC < 0 ? 'dir.cooler' : 'dir.warmer') }));
  }
  if (plan.energy.changes.length > 0) out.push(t('why.energy'));
  if (plan.context.seasonIndex > 0.3 && !plan.presetName && !plan.hold) out.push(t('why.winter'));
  return out;
}

function Hero({ plan, state }: { plan: PlanDto; state: StateDto }) {
  const { me, t, fmt } = useApp();
  const [why, setWhy] = useState(false);
  const mine = plan.sleepers.find((s) => s.sleeperId === me?.id) ?? plan.sleepers[0];
  const marks: CurveMark[] = mine
    ? [
        { t: mine.bedtimeMs, value: fmt.deg(targetAt(plan, mine.bedtimeMs)), caption: `${t('hero.bed')} ${fmt.clock(mine.bedtimeMs)}` },
        { t: mine.wakeMs, value: fmt.deg(targetAt(plan, mine.wakeMs)), caption: `${t('hero.wake')} ${fmt.clock(mine.wakeMs)}` },
      ]
    : [];
  const shown = plan.hold ? plan.hold.targetC : deepTarget(plan);
  const lines = me ? reasons(plan, state, me.id, t, fmt) : [];

  return (
    <section className="hero" aria-labelledby="hero-label">
      <div className="hero-top">
        <span className="hero-mode">{plan.hold ? t('mode.hand') : plan.presetName ? plan.presetName : t('mode.auto')}</span>
        <button className="hero-why" onClick={() => setWhy(true)}>
          {t('why.title')}
        </button>
      </div>
      <p className="hero-number">{fmt.deg(shown)}</p>
      <p className="hero-label" id="hero-label">
        {t('hero.label')}
      </p>
      {!plan.hold && <Curve startMs={plan.startMs} endMs={plan.endMs} segments={plan.segments} marks={marks} height={132} aria={t('hero.curve')} deg={fmt.deg} clock={fmt.clock} />}
      {why && (
        <Sheet title={t('why.title')} closeLabel={t('close')} onClose={() => setWhy(false)}>
          {lines.length === 0 ? (
            <p>{t('why.none')}</p>
          ) : (
            <ul className="ticks">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </section>
  );
}

/** "Your data suggest ... so we recommend ...", with the choice to apply it. */
function Tip({ state, plan }: { state: StateDto; plan: PlanDto | null }) {
  const { recommendation: rec, me, t, fmt, run, busy } = useApp();
  if (!rec || !me) return null;
  const mine = rec.findings.find((f) => f.sleeperId === me.id);
  const partner = rec.findings.find((f) => f.sleeperId !== me.id);
  const partnerName = state.sleepers.find((s) => s.id === partner?.sleeperId)?.name ?? '';
  const deepStep = rec.recommended.filter((s) => s.phase === 'deep');
  const recommended = deepStep.length > 0 ? deepStep[deepStep.length - 1]!.targetC : plan ? deepTarget(plan) : null;
  const answer = (action: 'apply' | 'keep'): void => void run(() => api.answerRecommendation(rec.roomId, action), { done: t(action === 'apply' ? 'tip.applied' : 'tip.kept') });

  return (
    <section className="card tip">
      <p className="eyebrow">
        <Icon name="spark" size={16} /> {t('tip.suggest')}
      </p>
      <p className="tip-line">
        {mine && (mine.nights === 0 ? t('tip.start', { temp: fmt.temp(mine.idealC) }) : t('tip.you', { temp: fmt.temp(mine.idealC) }))}
        {partner && partner.nights > 0 ? ` ${t('tip.partner', { name: partnerName, temp: fmt.temp(partner.idealC) })}` : ''}
      </p>
      {recommended !== null && (
        <>
          <p className="eyebrow">{t('tip.recommend')}</p>
          <p className="tip-line">{t(partner ? 'tip.roomShared' : 'tip.room', { temp: fmt.temp(recommended) })}</p>
        </>
      )}
      {rec.mode === 'auto' && (
        <p className="ok">
          <Icon name="check" size={16} /> {t('tip.on')}
        </p>
      )}
      {rec.mode === 'preset' &&
        (rec.status === 'kept' ? (
          <p className="muted">{t('tip.keeping', { name: rec.presetName ?? '' })}</p>
        ) : (
          <div className="pair">
            <button className="primary" disabled={busy} onClick={() => answer('apply')}>
              {t('tip.apply')}
            </button>
            <button disabled={busy} onClick={() => answer('keep')}>
              {t('tip.keep')}
            </button>
          </div>
        ))}
    </section>
  );
}

/** Only shown when the household has switched manual control on. */
function Manual({ state, plan }: { state: StateDto; plan: PlanDto | null }) {
  const { me, t, fmt, run, busy } = useApp();
  const room = state.rooms[0]!;
  const [target, setTarget] = useState<number>(room.hold?.targetC ?? (plan ? deepTarget(plan) : 20));
  const active = state.presets.find((p) => p.id === room.activePresetId);
  return (
    <section className="card">
      <h2>{t('manual.title')}</h2>
      <div className="manual">
        <Stepper value={target} shown={fmt.deg(target)} lower={t('manual.lower')} raise={t('manual.raise')} onChange={(v) => setTarget(Math.min(28, Math.max(12, v)))} />
        <button className="primary" disabled={busy} onClick={() => void run(() => api.hold(room.id, target, null, me?.id), { done: t('manual.done', { temp: fmt.temp(target) }) })}>
          {t('manual.set')}
        </button>
      </div>
      {state.presets.length > 0 && (
        <div className="chips">
          {state.presets.map((p) => (
            <button key={p.id} className="chip" aria-pressed={p.id === room.activePresetId} disabled={busy} onClick={() => void run(() => api.activatePreset(p.id, room.id))}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      {(room.hold || active) && (
        <button
          className="wide"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (room.hold) await api.clearHold(room.id);
              if (active) await api.clearPreset(room.id);
            })
          }
        >
          {t('manual.auto')}
        </button>
      )}
    </section>
  );
}

export function Tonight({ live }: { live: Live }) {
  const { state, plan, recommendation, planError, me, t, fmt, run, busy } = useApp();
  if (!state || !me) return null;
  if (live.active) return <LiveNight live={live} state={state} />;
  const room = state.rooms[0];
  const saved = state.savings;
  const last = recommendation?.findings.find((f) => f.sleeperId === me.id)?.lastNight ?? null;

  return (
    <div className="stack">
      {plan ? (
        <Hero plan={plan} state={state} />
      ) : (
        <section className="card">
          <p>{state.rooms[0]?.devices.length === 0 ? t('plan.noThermostat') : (planError ?? t('plan.none'))}</p>
          <a className="button primary" href="#settings/home">
            {t('plan.fix')}
          </a>
        </section>
      )}

      <Tip state={state} plan={plan} />

      <div className="tiles">
        <a className="tile" href="#sleep">
          <span className="tile-label">{t('tile.lastNight')}</span>
          <Ring value={last?.quality ?? null} size={84} label={t('score')} />
          <span className="tile-note">{last?.quality == null ? t('tile.noNight') : t('score')}</span>
        </a>
        <a className="tile" href="#sleep">
          <span className="tile-label">{saved.savedCents >= 0 ? t('tile.saved') : t('tile.extra')}</span>
          <span className="tile-number">{fmt.money(saved.savedCents)}</span>
          <span className="tile-note">{saved.nights === 0 ? t('tile.noNight') : t('tile.nights', { nights: saved.nights })}</span>
        </a>
      </div>

      {state.household.manualControl && room && <Manual key={`${room.hold?.targetC ?? ''}`} state={state} plan={plan} />}

      {room && plan && (
        <section className="demo-strip">
          <p className="eyebrow">{t('demo.pill')}</p>
          <div className="chips">
            <button className="chip strong" disabled={busy} onClick={() => void run(async () => live.begin(await api.liveStart(room.id, 60)), { refresh: false })}>
              <Icon name="play" size={14} /> {t('demo.play')}
            </button>
            {[1, 7].map((n) => (
              <button key={n} className="chip" disabled={busy} onClick={() => void run(() => api.advance(n), { done: t('demo.simulated', { n }) })}>
                {t(n === 1 ? 'demo.skip1' : 'demo.skipN', { n })}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

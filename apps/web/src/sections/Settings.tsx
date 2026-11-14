import type { Equipment, JetLagNight, NightDetailDto, SleeperDto, StateDto } from '@tempcontrol/contracts';
import { useState } from 'react';
import { api } from '../api';
import { PlanChart } from '../charts';
import { useApp } from '../store';

/** A text-like field that saves when the user leaves it or presses Enter. */
function Field({ label, value, type = 'text', onSave, disabled }: { label: string; value: string; type?: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = (): void => {
    if (draft !== value && draft !== '') onSave(draft);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        {hint && <span className="muted small"> {hint}</span>}
      </span>
    </label>
  );
}

function Household({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, fmt, locale, units, run } = useApp();
  const h = state.household;
  const tariff = state.tariffs.find((x) => x.id === h.tariffId);
  const regions = [...new Set(state.tariffs.map((x) => x.region))];
  const save = (patch: Parameters<typeof api.patchHousehold>[0]): void => void run(() => api.patchHousehold(patch));
  const toC = (v: string): number => (units === 'F' ? ((Number(v) - 32) * 5) / 9 : Number(v));
  const shown = (c: number): string => String(units === 'F' ? Math.round((c * 9) / 5 + 32) : c);

  return (
    <section className="card">
      <h2>{t('settings.household')}</h2>
      <div className="form">
        <label className="field">
          <span>{t('settings.location')}</span>
          <select value={h.climateId} disabled={locked} onChange={(e) => save({ climateId: e.target.value })}>
            {state.climates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.region})
              </option>
            ))}
          </select>
        </label>
        <Field label={t('settings.daySetpoint', { unit: units === 'F' ? '°F' : '°C' })} type="number" value={shown(h.daySetpointC)} disabled={locked} onSave={(v) => save({ daySetpointC: toC(v) })} />
        <label className="field">
          <span>{t('settings.tariff')}</span>
          <select value={h.tariffId} disabled={locked} onChange={(e) => save({ tariffId: e.target.value })}>
            {regions.map((region) => (
              <optgroup key={region} label={region}>
                {state.tariffs
                  .filter((x) => x.region === region)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.utility[locale]} · {x.name[locale]}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      {tariff && (
        <div className="tariff">
          <ul className="plain inline">
            {tariff.rates.map((r) => (
              <li key={r.key}>
                {r.label[locale]}: {fmt.num(r.centsPerKWh, 3)} ¢/kWh
              </li>
            ))}
          </ul>
          <p className="muted small">
            {t('settings.tariffNote', { date: tariff.source.verifiedOn })}{' '}
            {tariff.source.url && (
              <a href={tariff.source.url} target="_blank" rel="noreferrer">
                {t('settings.source')}
              </a>
            )}
          </p>
        </div>
      )}

      <Toggle label={t('settings.manual')} hint={t('settings.manualHint')} checked={h.manualControl} disabled={locked} onChange={(v) => save({ manualControl: v })} />
      <Toggle label={t('settings.energy')} hint={t('settings.energyHint')} checked={h.energy.enabled} disabled={locked} onChange={(v) => save({ energy: { enabled: v } })} />
      {h.energy.enabled && (
        <label className="field">
          <span>{t('settings.tolerance', { delta: fmt.delta(h.energy.toleranceC) })}</span>
          <input type="range" min={0} max={1.5} step={0.5} value={h.energy.toleranceC} disabled={locked} onChange={(e) => save({ energy: { toleranceC: Number(e.target.value) } })} />
        </label>
      )}
    </section>
  );
}

function Sleeper({ sleeper, state, locked }: { sleeper: SleeperDto; state: StateDto; locked: boolean }) {
  const { t, units, run } = useApp();
  const save = (patch: Parameters<typeof api.patchSleeper>[1]): void => void run(() => api.patchSleeper(sleeper.id, patch));
  const toC = (v: string): number => (units === 'F' ? Math.round((((Number(v) - 32) * 5) / 9) * 2) / 2 : Number(v));
  const shown = (c: number): string => String(units === 'F' ? Math.round((c * 9) / 5 + 32) : c);
  const unit = units === 'F' ? '°F' : '°C';

  return (
    <section className="card">
      <h2>{sleeper.name}</h2>
      <div className="form">
        <Field label={t('settings.name')} value={sleeper.name} disabled={locked} onSave={(v) => save({ name: v })} />
        <Field label={t('settings.bedtime')} type="time" value={sleeper.bedtime} disabled={locked} onSave={(v) => save({ bedtime: v })} />
        <Field label={t('settings.wake')} type="time" value={sleeper.wakeTime} disabled={locked} onSave={(v) => save({ wakeTime: v })} />
        <Field label={t('settings.min', { unit })} type="number" value={shown(sleeper.limits.minC)} disabled={locked} onSave={(v) => save({ limits: { minC: toC(v), maxC: sleeper.limits.maxC } })} />
        <Field label={t('settings.max', { unit })} type="number" value={shown(sleeper.limits.maxC)} disabled={locked} onSave={(v) => save({ limits: { minC: sleeper.limits.minC, maxC: toC(v) } })} />
        <label className="field">
          <span>{t('settings.wearable')}</span>
          <select value={sleeper.wearable.id} disabled={locked} onChange={(e) => save({ wearableBrand: e.target.value })}>
            {state.catalog.wearables.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {t(w.delivery === 'live' ? 'wearable.live' : 'wearable.morning')}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('settings.replyLanguage')}</span>
          <select value={sleeper.locale} disabled={locked} onChange={(e) => save({ locale: e.target.value as 'en' | 'fr' })}>
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </label>
        <label className="field">
          <span>{t('settings.replyUnits')}</span>
          <select value={sleeper.units} disabled={locked} onChange={(e) => save({ units: e.target.value as 'C' | 'F' })}>
            <option value="C">°C</option>
            <option value="F">°F</option>
          </select>
        </label>
      </div>
      <p className="muted small">{t('settings.wearableNote')}</p>

      <Toggle label={t('opt.explore')} hint={t('opt.exploreHint')} checked={sleeper.options.explore} disabled={locked} onChange={(v) => save({ options: { explore: v } })} />
      <Toggle label={t('opt.recovery')} hint={t('opt.recoveryHint')} checked={sleeper.options.recoveryAware} disabled={locked} onChange={(v) => save({ options: { recoveryAware: v } })} />
      <Toggle label={t('opt.cycle')} hint={t('opt.cycleHint')} checked={sleeper.options.cycleTracking} disabled={locked} onChange={(v) => save({ options: { cycleTracking: v } })} />
      {sleeper.options.cycleTracking && (
        <Field label={t('opt.lastPeriod')} type="date" value={sleeper.cycle.lastPeriodStart ?? ''} disabled={locked} onSave={(v) => save({ cycle: { lastPeriodStart: v } })} />
      )}
      <Toggle label={t('opt.menopause')} hint={t('opt.menopauseHint')} checked={sleeper.options.menopauseMode} disabled={locked} onChange={(v) => save({ options: { menopauseMode: v } })} />
      <button
        disabled={locked}
        onClick={() => {
          if (confirm(t('settings.forgetConfirm', { name: sleeper.name }))) void run(() => api.resetModel(sleeper.id));
        }}
      >
        {t('settings.forget')}
      </button>
    </section>
  );
}

function Thermostat({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, run } = useApp();
  const room = state.rooms[0]!;
  const device = room.devices[0];
  const [brand, setBrand] = useState(state.catalog.climate[0]!.id);
  const chosen = state.catalog.climate.find((b) => b.id === brand) ?? state.catalog.climate[0]!;
  const [equipment, setEquipment] = useState<Equipment>(chosen.equipment[0] ?? 'central');
  const usable = chosen.equipment.includes(equipment) ? equipment : (chosen.equipment[0] ?? 'central');

  return (
    <section className="card">
      <h2>{t('settings.thermostat')}</h2>
      <p className="muted small">{t('settings.simulated')}</p>
      {device ? (
        <div className="row between wrap">
          <p>
            <strong>{device.name}</strong> · {t(`equipment.${device.equipment}`)}
          </p>
          <button disabled={locked} onClick={() => void run(() => api.removeDevice(device.id))}>
            {t('settings.remove')}
          </button>
        </div>
      ) : (
        <>
          <p className="note warn">{t('settings.noThermostat')}</p>
          <div className="row wrap">
            <label>
              <span className="sr">{t('settings.brand')}</span>
              <select value={brand} onChange={(e) => setBrand(e.target.value)}>
                {state.catalog.climate.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr">{t('settings.equipment')}</span>
              <select value={usable} onChange={(e) => setEquipment(e.target.value as Equipment)}>
                {chosen.equipment.map((eq) => (
                  <option key={eq} value={eq}>
                    {t(`equipment.${eq}`)}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={locked} onClick={() => void run(() => api.addDevice(room.id, { brand, equipment: usable }))}>
              {t('settings.connect')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Presets({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, fmt, units, run } = useApp();
  const room = state.rooms[0]!;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'hold' | 'curve'>('hold');
  const [temps, setTemps] = useState({ onset: 19.5, deep: 18, rem: 18.5, wake: 21 });
  const [fixed, setFixed] = useState(20);
  const shown = (c: number): number => (units === 'F' ? Math.round((c * 9) / 5 + 32) : c);
  const toC = (v: number): number => (units === 'F' ? Math.round((((v - 32) * 5) / 9) * 2) / 2 : v);
  const number = (value: number, set: (c: number) => void, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={units === 'F' ? 1 : 0.5} value={shown(value)} onChange={(e) => set(toC(Number(e.target.value)))} />
    </label>
  );

  return (
    <section className="card">
      <h2>{t('settings.presets')}</h2>
      <p className="muted small">{t('settings.presetsNote')}</p>
      <ul className="rows">
        {state.presets.map((p) => (
          <li key={p.id} className="row between wrap">
            <span>
              <strong>{p.name}</strong>{' '}
              <span className="muted">
                {p.kind === 'hold' && p.targetC !== undefined
                  ? fmt.temp(p.targetC)
                  : p.temps
                    ? `${fmt.temp(p.temps.onset)} → ${fmt.temp(p.temps.deep)} → ${fmt.temp(p.temps.rem)} → ${fmt.temp(p.temps.wake)}`
                    : ''}
              </span>
              {room.activePresetId === p.id && <span className="badge live"> {t('settings.active')}</span>}
            </span>
            <span className="row">
              {room.activePresetId === p.id ? (
                <button disabled={locked} onClick={() => void run(() => api.clearPreset(room.id))}>
                  {t('settings.backToAuto')}
                </button>
              ) : (
                <button disabled={locked} onClick={() => void run(() => api.activatePreset(p.id, room.id))}>
                  {t('settings.use')}
                </button>
              )}
              <button disabled={locked} onClick={() => void run(() => api.deletePreset(p.id))}>
                {t('settings.remove')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <h3>{t('settings.newPreset')}</h3>
      <div className="form">
        <label className="field">
          <span>{t('settings.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('settings.presetKind')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'hold' | 'curve')}>
            <option value="hold">{t('settings.kindHold')}</option>
            <option value="curve">{t('settings.kindCurve')}</option>
          </select>
        </label>
        {kind === 'hold'
          ? number(fixed, setFixed, t('manual.temperature'))
          : (['onset', 'deep', 'rem', 'wake'] as const).map((phase) => (
              <span key={phase} style={{ display: 'contents' }}>
                {number(temps[phase], (c) => setTemps({ ...temps, [phase]: c }), t(`phase.${phase}`))}
              </span>
            ))}
      </div>
      <button
        className="primary"
        disabled={name.trim() === ''}
        onClick={() =>
          void run(async () => {
            await api.createPreset(kind === 'hold' ? { name: name.trim(), kind, targetC: fixed } : { name: name.trim(), kind, temps });
            setName('');
          })
        }
      >
        {t('settings.addPreset')}
      </button>
    </section>
  );
}

function Travel({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, fmt, run } = useApp();
  const [who, setWho] = useState(state.sleepers[0]!.id);
  const sleeper = state.sleepers.find((s) => s.id === who) ?? state.sleepers[0]!;
  const [shift, setShift] = useState(6);
  const [arrival, setArrival] = useState(state.household.date);
  const [preview, setPreview] = useState<JetLagNight[] | null>(null);
  const [nap, setNap] = useState<NightDetailDto | null>(null);
  const req = { shiftHours: shift, arrivalDate: arrival, prepareNights: 3 };

  return (
    <section className="card">
      <h2>{t('travel.title')}</h2>
      {state.sleepers.length > 1 && (
        <label className="field">
          <span>{t('travel.who')}</span>
          <select value={sleeper.id} onChange={(e) => setWho(e.target.value)}>
            {state.sleepers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <h3>{t('travel.jetlag')}</h3>
      <p className="muted small">{t('travel.jetlagNote')}</p>
      <div className="form">
        <label className="field">
          <span>{t('travel.shift')}</span>
          <input type="number" min={-12} max={12} step={1} value={shift} onChange={(e) => setShift(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>{t('travel.arrival')}</span>
          <input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />
        </label>
      </div>
      <div className="row wrap">
        <button onClick={() => void run(async () => setPreview(await api.jetLag(sleeper.id, req)), { refresh: false })}>{t('travel.preview')}</button>
        <button className="primary" disabled={locked} onClick={() => void run(() => api.applyTravel(sleeper.id, req), { done: t('travel.applied') })}>
          {t('travel.apply')}
        </button>
        {sleeper.travel && (
          <button disabled={locked} onClick={() => void run(() => api.clearTravel(sleeper.id))}>
            {t('travel.cancel')}
          </button>
        )}
      </div>
      {sleeper.travel && <p className="note">{t('travel.active', { hours: sleeper.travel.shiftHours, date: fmt.day(sleeper.travel.arrivalDate) })}</p>}
      {preview && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('history.col.date')}</th>
                <th scope="col">{t('travel.where')}</th>
                <th scope="col" className="num">{t('settings.bedtime')}</th>
                <th scope="col" className="num">{t('settings.wake')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.length === 0 && (
                <tr>
                  <td colSpan={4}>{t('travel.none')}</td>
                </tr>
              )}
              {preview.map((n) => (
                <tr key={n.date}>
                  <th scope="row">{fmt.day(n.date)}</th>
                  <td>{t(n.where === 'home' ? 'travel.home' : 'travel.destination')}</td>
                  <td className="num">{n.bedtime}</td>
                  <td className="num">{n.wakeTime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>{t('travel.nap')}</h3>
      <p className="muted small">{t('travel.napNote')}</p>
      <div className="row wrap">
        {[20, 45, 90].map((minutes) => (
          <button key={minutes} disabled={locked} onClick={() => void run(async () => setNap(await api.nap(sleeper.id, minutes)), { refresh: false })}>
            {t('travel.napMinutes', { minutes })}
          </button>
        ))}
      </div>
      {nap && <PlanChart plan={nap.plan} ticks={nap.trace} names={{ [sleeper.id]: sleeper.name }} height={220} />}
    </section>
  );
}

export function Settings() {
  const { state, t } = useApp();
  if (!state) return null;
  const locked = state.live?.status === 'running';
  const hasRoom = state.rooms.length > 0 && state.sleepers.length > 0;
  return (
    <div className="stack">
      <header className="strip">
        <div>
          <h1>{t('settings.title')}</h1>
          <p className="muted">{t('settings.subtitle')}</p>
        </div>
      </header>
      {locked && <p className="note warn">{t('settings.locked')}</p>}
      <Household state={state} locked={locked} />
      <div className="grid-2">
        {state.sleepers.map((s) => (
          <Sleeper key={s.id} sleeper={s} state={state} locked={locked} />
        ))}
      </div>
      {hasRoom && <Thermostat state={state} locked={locked} />}
      {hasRoom && state.household.manualControl && <Presets state={state} locked={locked} />}
      {hasRoom && <Travel key={state.household.id} state={state} locked={locked} />}
    </div>
  );
}

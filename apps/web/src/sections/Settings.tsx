import type { Equipment, JetLagNight, StateDto } from '@tempcontrol/contracts';
import { useState, type ReactNode } from 'react';
import { api } from '../api';
import type { Key } from '../i18n';
import { useApp } from '../store';
import { Group, Icon, Input, Row, Segmented, Stepper, Switch } from '../ui';

const PAGES = ['profile', 'comfort', 'home', 'energy', 'manual', 'travel', 'demo'] as const;
type Page = (typeof PAGES)[number];

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="stack">
      <h1 className="page-title">{title}</h1>
      {children}
    </div>
  );
}

function Profile({ state, locked }: { state: StateDto; locked: boolean }) {
  const { me, t, locale, units, setLocale, setUnits, run } = useApp();
  if (!me) return null;
  const save = (patch: Parameters<typeof api.patchSleeper>[1]): void => void run(() => api.patchSleeper(me.id, patch));
  return (
    <Sub title={t('set.profile')}>
      <Group>
        <Row label={t('set.name')}>
          <Input label={t('set.name')} value={me.name} disabled={locked} onSave={(v) => save({ name: v })} />
        </Row>
        <Row label={t('set.bedtime')}>
          <Input label={t('set.bedtime')} type="time" value={me.bedtime} disabled={locked} onSave={(v) => save({ bedtime: v })} />
        </Row>
        <Row label={t('set.wake')}>
          <Input label={t('set.wake')} type="time" value={me.wakeTime} disabled={locked} onSave={(v) => save({ wakeTime: v })} />
        </Row>
      </Group>
      <Group note={t(me.wearable.delivery === 'live' ? 'set.wearableLive' : 'set.wearableMorning')}>
        <Row wrap label={t('set.wearable')}>
          <select value={me.wearable.id} disabled={locked} onChange={(e) => save({ wearableBrand: e.target.value })}>
            {state.catalog.wearables.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group>
        <Row label={t('set.language')}>
          <Segmented
            label={t('set.language')}
            value={locale}
            disabled={locked}
            onChange={setLocale}
            options={[
              { id: 'en', label: 'English' },
              { id: 'fr', label: 'Français' },
            ]}
          />
        </Row>
        <Row label={t('set.units')}>
          <Segmented
            label={t('set.units')}
            value={units}
            disabled={locked}
            onChange={setUnits}
            options={[
              { id: 'C', label: '°C' },
              { id: 'F', label: '°F' },
            ]}
          />
        </Row>
      </Group>
    </Sub>
  );
}

function Comfort({ locked }: { locked: boolean }) {
  const { me, t, fmt, run } = useApp();
  if (!me) return null;
  const save = (patch: Parameters<typeof api.patchSleeper>[1]): void => void run(() => api.patchSleeper(me.id, patch));
  const o = me.options;
  return (
    <Sub title={t('set.comfort')}>
      <Group title={t('set.range')} note={t('set.rangeNote')}>
        <Row label={t('set.min')}>
          <Stepper value={me.limits.minC} shown={fmt.deg(me.limits.minC)} lower={t('manual.lower')} raise={t('manual.raise')} disabled={locked} onChange={(v) => save({ limits: { minC: v, maxC: me.limits.maxC } })} />
        </Row>
        <Row label={t('set.max')}>
          <Stepper value={me.limits.maxC} shown={fmt.deg(me.limits.maxC)} lower={t('manual.lower')} raise={t('manual.raise')} disabled={locked} onChange={(v) => save({ limits: { minC: me.limits.minC, maxC: v } })} />
        </Row>
      </Group>
      <Group title={t('set.adapt')}>
        <Row wrap label={t('opt.recovery')} hint={t('opt.recoveryHint')}>
          <Switch checked={o.recoveryAware} disabled={locked} onChange={(v) => save({ options: { recoveryAware: v } })} />
        </Row>
        <Row wrap label={t('opt.cycle')} hint={t('opt.cycleHint')}>
          <Switch checked={o.cycleTracking} disabled={locked} onChange={(v) => save({ options: { cycleTracking: v } })} />
        </Row>
        {o.cycleTracking && (
          <Row label={t('opt.lastPeriod')}>
            <Input label={t('opt.lastPeriod')} type="date" value={me.cycle.lastPeriodStart ?? ''} disabled={locked} onSave={(v) => save({ cycle: { lastPeriodStart: v } })} />
          </Row>
        )}
        <Row wrap label={t('opt.menopause')} hint={t('opt.menopauseHint')}>
          <Switch checked={o.menopauseMode} disabled={locked} onChange={(v) => save({ options: { menopauseMode: v } })} />
        </Row>
        <Row wrap label={t('opt.explore')} hint={t('opt.exploreHint')}>
          <Switch checked={o.explore} disabled={locked} onChange={(v) => save({ options: { explore: v } })} />
        </Row>
      </Group>
      <button
        className="wide danger"
        disabled={locked}
        onClick={() => {
          if (confirm(t('set.forgetConfirm'))) void run(() => api.resetModel(me.id));
        }}
      >
        {t('set.forget')}
      </button>
    </Sub>
  );
}

function Home({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, fmt, run } = useApp();
  const h = state.household;
  const room = state.rooms[0];
  const device = room?.devices[0];
  const [brand, setBrand] = useState(state.catalog.climate[0]!.id);
  const chosen = state.catalog.climate.find((b) => b.id === brand) ?? state.catalog.climate[0]!;
  const [equipment, setEquipment] = useState<Equipment>(chosen.equipment[0] ?? 'central');
  const usable = chosen.equipment.includes(equipment) ? equipment : (chosen.equipment[0] ?? 'central');
  return (
    <Sub title={t('set.home')}>
      <Group title={t('set.thermostat')}>
        {device ? (
          <>
            <Row label={device.name} hint={t(`equipment.${device.equipment}`)}>
              <span className="ok">
                <Icon name="check" size={16} /> {t('set.connected')}
              </span>
            </Row>
            <Row label={t('set.day')} hint={t('set.dayHint')}>
              <Stepper value={h.daySetpointC} shown={fmt.deg(h.daySetpointC)} lower={t('manual.lower')} raise={t('manual.raise')} disabled={locked} onChange={(v) => void run(() => api.patchHousehold({ daySetpointC: v }))} />
            </Row>
          </>
        ) : (
          <>
            <Row wrap label={t('set.brand')}>
              <select value={brand} onChange={(e) => setBrand(e.target.value)}>
                {state.catalog.climate.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row wrap label={t('set.controls')}>
              <select value={usable} onChange={(e) => setEquipment(e.target.value as Equipment)}>
                {chosen.equipment.map((eq) => (
                  <option key={eq} value={eq}>
                    {t(`equipment.${eq}`)}
                  </option>
                ))}
              </select>
            </Row>
          </>
        )}
      </Group>
      {room &&
        (device ? (
          <button className="wide danger" disabled={locked} onClick={() => void run(() => api.removeDevice(device.id))}>
            {t('set.disconnect')}
          </button>
        ) : (
          <button className="wide primary" disabled={locked} onClick={() => void run(() => api.addDevice(room.id, { brand, equipment: usable }))}>
            {t('set.connect')}
          </button>
        ))}
      <Group>
        <Row wrap label={t('set.city')}>
          <select value={h.climateId} disabled={locked} onChange={(e) => void run(() => api.patchHousehold({ climateId: e.target.value }))}>
            {state.climates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
      </Group>
    </Sub>
  );
}

function Energy({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, fmt, locale, run } = useApp();
  const h = state.household;
  const tariff = state.tariffs.find((x) => x.id === h.tariffId);
  const saved = state.savings;
  const save = (patch: Parameters<typeof api.patchHousehold>[0]): void => void run(() => api.patchHousehold(patch));
  return (
    <Sub title={t('set.energy')}>
      <section className="card center">
        <p className="eyebrow">{saved.savedCents >= 0 ? t('tile.saved') : t('tile.extra')}</p>
        <p className="big-number">{fmt.money(saved.savedCents)}</p>
        <p className="muted">{t('tile.nights', { nights: saved.nights })}</p>
      </section>
      <Group note={t('set.energyNote')}>
        <Row wrap label={t('set.energy')}>
          <Switch checked={h.energy.enabled} disabled={locked} onChange={(v) => save({ energy: { enabled: v } })} />
        </Row>
        {h.energy.enabled && (
          <Row label={t('set.flex')} hint={t('set.flexHint')}>
            <Segmented
              label={t('set.flex')}
              value={String(h.energy.toleranceC)}
              disabled={locked}
              onChange={(v) => save({ energy: { toleranceC: Number(v) } })}
              options={[0.5, 1, 1.5].map((v) => ({ id: String(v), label: fmt.deg(v) }))}
            />
          </Row>
        )}
      </Group>
      <Group note={tariff ? t('set.planNote', { date: tariff.source.verifiedOn }) : undefined}>
        <Row wrap label={t('set.plan')}>
          <select value={h.tariffId} disabled={locked} onChange={(e) => save({ tariffId: e.target.value })}>
            {state.tariffs.map((x) => (
              <option key={x.id} value={x.id}>
                {x.utility[locale]} · {x.name[locale]}
              </option>
            ))}
          </select>
        </Row>
      </Group>
    </Sub>
  );
}

function Manual({ state, locked }: { state: StateDto; locked: boolean }) {
  const { t, fmt, run } = useApp();
  const room = state.rooms[0];
  const on = state.household.manualControl;
  const [name, setName] = useState('');
  const [target, setTarget] = useState(20);
  return (
    <Sub title={t('set.manual')}>
      <Group note={t('set.manualNote')}>
        <Row wrap label={t('set.manual')}>
          <Switch checked={on} disabled={locked} onChange={(v) => void run(() => api.patchHousehold({ manualControl: v }))} />
        </Row>
      </Group>
      {on && room && (
        <>
          <Group title={t('set.presets')} note={t('set.presetsNote')}>
            {state.presets.map((p) => (
              <div key={p.id} className="row">
                <span className="row-text">
                  <span className="row-label">{p.name}</span>
                  <span className="row-hint">{p.kind === 'hold' && p.targetC !== undefined ? fmt.temp(p.targetC) : p.temps ? `${fmt.deg(p.temps.onset)} → ${fmt.deg(p.temps.deep)} → ${fmt.deg(p.temps.wake)}` : ''}</span>
                </span>
                <span className="row-value">
                  {room.activePresetId === p.id ? (
                    <button className="small" disabled={locked} onClick={() => void run(() => api.clearPreset(room.id))}>
                      {t('set.stop')}
                    </button>
                  ) : (
                    <button className="small" disabled={locked} onClick={() => void run(() => api.activatePreset(p.id, room.id))}>
                      {t('set.use')}
                    </button>
                  )}
                  <button className="small" disabled={locked} onClick={() => void run(() => api.deletePreset(p.id))} aria-label={`${t('set.remove')}: ${p.name}`}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
              </div>
            ))}
          </Group>
          <Group title={t('set.newPreset')}>
            <Row label={t('set.name')}>
              <input className="inline" value={name} onChange={(e) => setName(e.target.value)} aria-label={t('set.name')} />
            </Row>
            <Row label={t('set.temperature')}>
              <Stepper value={target} shown={fmt.deg(target)} lower={t('manual.lower')} raise={t('manual.raise')} onChange={(v) => setTarget(Math.min(28, Math.max(12, v)))} />
            </Row>
          </Group>
          <button
            className="wide primary"
            disabled={name.trim() === ''}
            onClick={() =>
              void run(async () => {
                await api.createPreset({ name: name.trim(), kind: 'hold', targetC: target });
                setName('');
              })
            }
          >
            {t('set.addPreset')}
          </button>
        </>
      )}
    </Sub>
  );
}

function Travel({ state, locked }: { state: StateDto; locked: boolean }) {
  const { me, t, fmt, run } = useApp();
  const [shift, setShift] = useState(6);
  const [arrival, setArrival] = useState(state.household.date);
  const [preview, setPreview] = useState<JetLagNight[] | null>(null);
  if (!me) return null;
  const req = { shiftHours: shift, arrivalDate: arrival, prepareNights: 3 };
  return (
    <Sub title={t('set.travel')}>
      <Group title={t('travel.jetlag')} note={t('travel.note')}>
        <Row label={t('travel.shift')} hint={t('travel.shiftHint')}>
          <span className="stepper">
            <button type="button" className="round" aria-label={t('manual.lower')} onClick={() => setShift((v) => Math.max(-12, v - 1))}>
              −
            </button>
            <output>{shift > 0 ? `+${shift}` : shift} h</output>
            <button type="button" className="round" aria-label={t('manual.raise')} onClick={() => setShift((v) => Math.min(12, v + 1))}>
              +
            </button>
          </span>
        </Row>
        <Row label={t('travel.arrival')}>
          <input className="inline" type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} aria-label={t('travel.arrival')} />
        </Row>
      </Group>
      {me.travel && <p className="ok">{t('travel.active', { date: fmt.day(me.travel.arrivalDate) })}</p>}
      <div className="pair">
        <button onClick={() => void run(async () => setPreview(await api.jetLag(me.id, req)), { refresh: false })}>{t('travel.preview')}</button>
        {me.travel ? (
          <button disabled={locked} onClick={() => void run(() => api.clearTravel(me.id))}>
            {t('travel.cancel')}
          </button>
        ) : (
          <button className="primary" disabled={locked} onClick={() => void run(() => api.applyTravel(me.id, req), { done: t('travel.applied') })}>
            {t('travel.apply')}
          </button>
        )}
      </div>
      {preview && (
        <Group>
          {preview.length === 0 && <Row label={t('travel.none')} />}
          {preview.map((n) => (
            <Row key={n.date} label={fmt.day(n.date)} hint={t(n.where === 'home' ? 'travel.home' : 'travel.away')}>
              {n.bedtime} → {n.wakeTime}
            </Row>
          ))}
        </Group>
      )}
      <Group title={t('travel.nap')} note={t('travel.napNote')}>
        <div className="row">
          <div className="trio">
            {[20, 45, 90].map((minutes) => (
              <button key={minutes} disabled={locked} onClick={() => void run(() => api.nap(me.id, minutes), { done: t('travel.napDone', { minutes }) })}>
                {minutes} min
              </button>
            ))}
          </div>
        </div>
      </Group>
    </Sub>
  );
}

function Demo({ state, locked }: { state: StateDto; locked: boolean }) {
  const { me, t, locale, run, busy } = useApp();
  const [scenario, setScenario] = useState(state.scenarios[0]?.id ?? 'couple');
  const tariff = state.tariffs.find((x) => x.id === state.household.tariffId);
  if (!me) return null;
  return (
    <Sub title={t('demo.title')}>
      <p className="muted">{t('demo.intro')}</p>
      <Group title={t('demo.time')}>
        <div className="row">
          <div className="trio">
            {[1, 7, 30].map((n) => (
              <button key={n} disabled={busy || locked} onClick={() => void run(() => api.advance(n), { done: t('demo.simulated', { n }) })}>
                {t(n === 1 ? 'demo.skip1' : 'demo.skipN', { n })}
              </button>
            ))}
          </div>
        </div>
      </Group>
      <Group title={t('demo.tonight', { name: me.name })}>
        {(['alcohol', 'highStrain', 'illness'] as const).map((flag) => (
          <Row wrap key={flag} label={t(`demo.flag.${flag}`)}>
            <Switch checked={me.tonight[flag]} disabled={busy || locked} onChange={(v) => void run(() => api.patchSleeper(me.id, { tonight: { [flag]: v } }))} />
          </Row>
        ))}
        {tariff?.hasPeakEvents && (
          <Row wrap label={t('demo.peak')}>
            <Switch checked={state.household.peakEvent !== null} disabled={busy || locked} onChange={(v) => void run(() => api.patchHousehold({ peakEvent: v ? 'morning' : null }))} />
          </Row>
        )}
      </Group>
      <Group title={t('demo.household')} note={state.scenarios.find((s) => s.id === scenario)?.description[locale]}>
        <Row wrap label={t('demo.scenario')}>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {state.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name[locale]}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <div className="pair">
        <button disabled={busy} onClick={() => void run(() => api.reset(scenario, 0))}>
          {t('demo.fresh')}
        </button>
        <button className="primary" disabled={busy} onClick={() => void run(() => api.reset(scenario, 10))}>
          {t('demo.history')}
        </button>
      </div>
    </Sub>
  );
}

export function Settings({ page }: { page: string | null }) {
  const { state, me, t, fmt, theme, setTheme } = useApp();
  if (!state || !me) return null;
  const locked = state.live?.status === 'running';
  const current = (PAGES as readonly string[]).includes(page ?? '') ? (page as Page) : null;
  const h = state.household;
  const go = (id: Page) => () => {
    location.hash = `#settings/${id}`;
  };
  const onOff = (v: boolean): string => t(v ? 'on' : 'off');

  if (current === 'profile') return <Profile state={state} locked={locked} />;
  if (current === 'comfort') return <Comfort locked={locked} />;
  if (current === 'home') return <Home state={state} locked={locked} />;
  if (current === 'energy') return <Energy state={state} locked={locked} />;
  if (current === 'manual') return <Manual state={state} locked={locked} />;
  if (current === 'travel') return <Travel state={state} locked={locked} />;
  if (current === 'demo') return <Demo state={state} locked={locked} />;

  const rows: { id: Page; value?: string }[] = [
    { id: 'profile', value: me.name },
    { id: 'comfort' },
  ];
  const house: { id: Page; value?: string }[] = [
    { id: 'home', value: state.rooms[0]?.devices[0]?.name ?? t('set.none') },
    { id: 'energy', value: onOff(h.energy.enabled) },
    { id: 'manual', value: onOff(h.manualControl) },
    { id: 'travel' },
  ];
  return (
    <div className="stack">
      {locked && <p className="muted">{t('set.locked')}</p>}
      <Group title={t('set.me')}>
        {rows.map((r) => (
          <Row key={r.id} label={t(`set.${r.id}` as Key)} onClick={go(r.id)}>
            {r.value}
          </Row>
        ))}
      </Group>
      <Group title={t('set.house')}>
        {house.map((r) => (
          <Row key={r.id} label={t(`set.${r.id}` as Key)} onClick={go(r.id)}>
            {r.value}
          </Row>
        ))}
      </Group>
      <Group>
        <Row label={t('set.theme')}>
          <Segmented
            label={t('set.theme')}
            value={theme}
            onChange={setTheme}
            options={[
              { id: 'system', label: t('set.themeAuto') },
              { id: 'light', label: t('set.themeLight') },
              { id: 'dark', label: t('set.themeDark') },
            ]}
          />
        </Row>
      </Group>
      <Group note={t('demo.intro')}>
        <Row label={t('demo.title')} onClick={go('demo')}>
          {fmt.day(h.date)}
        </Row>
      </Group>
    </div>
  );
}

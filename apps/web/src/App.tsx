import { useEffect, useState } from 'react';
import type { Key } from './i18n';
import { Ask } from './sections/Ask';
import { useLive } from './sections/Live';
import { Settings } from './sections/Settings';
import { Sleep } from './sections/Sleep';
import { Tonight } from './sections/Tonight';
import { useApp } from './store';
import { Icon, Sheet } from './ui';

const TABS = ['tonight', 'sleep', 'ask', 'settings'] as const;
type Tab = (typeof TABS)[number];
const ICONS = { tonight: 'moon', sleep: 'bars', ask: 'chat', settings: 'gear' } as const;

/** "#settings/demo" is the Settings tab on its Demo page. */
const fromHash = (): { tab: Tab; page: string | null } => {
  const [id = '', page = null] = location.hash.replace('#', '').split('/');
  return (TABS as readonly string[]).includes(id) ? { tab: id as Tab, page } : { tab: 'tonight', page: null };
};

export function App() {
  const { state, me, setMe, loadError, t, fmt, toasts, refresh } = useApp();
  const live = useLive();
  const [{ tab, page }, setPlace] = useState(fromHash);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    const onHash = (): void => {
      setPlace(fromHash());
      scrollTo(0, 0);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    document.title = `${t(`tab.${tab}` as Key)} · TempControl`;
  }, [tab, t]);

  const several = (state?.sleepers.length ?? 0) > 1;
  return (
    <div className="app">
      <header className="top">
        {tab === 'settings' && page ? (
          <a className="back" href="#settings">
            <Icon name="back" size={18} /> {t('tab.settings')}
          </a>
        ) : (
          <div>
            <h1>{t(`tab.${tab}` as Key)}</h1>
            {state && tab === 'tonight' && <p className="top-sub">{fmt.day(state.household.date)}</p>}
          </div>
        )}
        <div className="top-actions">
          <a className="pill" href="#settings/demo">
            {t('demo.pill')}
          </a>
          {me && (
            <button className="avatar" disabled={!several} onClick={() => setSwitching(true)} aria-label={t('profile.switch', { name: me.name })}>
              {me.name.slice(0, 1).toUpperCase()}
            </button>
          )}
        </div>
      </header>

      <main>
        {loadError ? (
          <div className="card">
            <p>{t('error.load')}</p>
            <button className="primary" onClick={() => void refresh()}>
              {t('error.retry')}
            </button>
          </div>
        ) : !state || !me ? (
          <p className="empty">{t('loading')}</p>
        ) : (
          <>
            {tab === 'tonight' && <Tonight live={live} />}
            {tab === 'sleep' && <Sleep key={me.id} />}
            {tab === 'ask' && <Ask key={me.id} />}
            {tab === 'settings' && <Settings key={me.id} page={page} />}
          </>
        )}
      </main>

      <nav className="tabs" aria-label={t('tab.label')}>
        {TABS.map((id) => (
          <a key={id} href={`#${id}`} aria-current={tab === id ? 'page' : undefined}>
            <Icon name={ICONS[id]} />
            <span>{t(`tab.${id}` as Key)}</span>
          </a>
        ))}
      </nav>

      {switching && state && (
        <Sheet title={t('profile.title')} closeLabel={t('close')} onClose={() => setSwitching(false)}>
          <p className="muted">{t('profile.note')}</p>
          <div className="group-body">
            {state.sleepers.map((s) => (
              <button
                key={s.id}
                className="row tap"
                onClick={() => {
                  setMe(s.id);
                  setSwitching(false);
                }}
              >
                <span className="row-text">
                  <span className="row-label">{s.name}</span>
                  <span className="row-hint">
                    {s.wearable.name} · {s.locale === 'fr' ? 'Français' : 'English'}
                  </span>
                </span>
                <span className="row-value">{s.id === me?.id && <Icon name="check" size={18} />}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  );
}

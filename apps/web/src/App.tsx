import { useEffect, useState } from 'react';
import type { Key } from './i18n';
import { Assistant } from './sections/Assistant';
import { History } from './sections/History';
import { Settings } from './sections/Settings';
import { Tonight } from './sections/Tonight';
import { useApp } from './store';

const SECTIONS = ['tonight', 'history', 'settings', 'assistant'] as const;
type Section = (typeof SECTIONS)[number];

const ICONS: Record<Section, string> = {
  tonight: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  history: 'M4 19h16M7 16V9m5 7V5m5 11v-4',
  settings: 'M4 7h10m4 0h2M4 17h4m4 0h8M14 4v6M8 14v6',
  assistant: 'M5 5h14v10H9l-4 4V5z',
};

const fromHash = (): Section => {
  const id = location.hash.replace('#', '');
  return (SECTIONS as readonly string[]).includes(id) ? (id as Section) : 'tonight';
};

export function App() {
  const { state, loadError, t, locale, setLocale, units, setUnits, theme, setTheme, toasts, refresh } = useApp();
  const [section, setSection] = useState<Section>(fromHash);
  useEffect(() => {
    const onHash = (): void => setSection(fromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    document.title = `${t(`nav.${section}` as Key)} · TempControl`;
  }, [section, t]);

  const dark = theme === 'dark' || (theme === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#tonight">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" className="brand-bg" />
            <path d="M20 9a8 8 0 1 0 3 13 7 7 0 0 1-3-13z" className="brand-moon" />
          </svg>
          <span>TempControl</span>
        </a>
        <nav className="nav" aria-label={t('nav.label')}>
          {SECTIONS.map((id) => (
            <a key={id} href={`#${id}`} aria-current={section === id ? 'page' : undefined}>
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path d={ICONS[id]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{t(`nav.${id}` as Key)}</span>
            </a>
          ))}
        </nav>
        <div className="prefs">
          <button onClick={() => setLocale(locale === 'en' ? 'fr' : 'en')} aria-label={t('prefs.language')}>
            {locale === 'en' ? 'FR' : 'EN'}
          </button>
          <button onClick={() => setUnits(units === 'C' ? 'F' : 'C')} aria-label={t('prefs.units')}>
            °{units === 'C' ? 'F' : 'C'}
          </button>
          <button onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label={t(dark ? 'prefs.light' : 'prefs.dark')}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              {dark ? (
                <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              ) : (
                <path d={ICONS.tonight} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>
      </header>

      <main>
        {loadError ? (
          <div className="card">
            <p className="note warn">{t('error.load')}</p>
            <p className="muted small">{loadError}</p>
            <button onClick={() => void refresh()}>{t('error.retry')}</button>
          </div>
        ) : !state ? (
          <p className="empty">{t('loading')}</p>
        ) : (
          <>
            <p className="demo-banner">{t('banner')}</p>
            {section === 'tonight' && <Tonight />}
            {section === 'history' && <History />}
            {section === 'settings' && <Settings />}
            {section === 'assistant' && <Assistant />}
          </>
        )}
      </main>

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

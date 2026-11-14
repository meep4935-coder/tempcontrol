/** App-wide state: what the server knows, plus the viewer's display choices. */

import type { Locale, PlanDto, RecommendationDto, StateDto, Units } from '@tempcontrol/contracts';
import { formatDelta, formatTemp } from '@tempcontrol/engine';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, RequestFailed } from './api';
import { translate, type Key } from './i18n';

type Theme = 'light' | 'dark' | 'system';

/** Preferences live in the browser when it lets us; the app works without. */
const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`tempcontrol.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`tempcontrol.${key}`, value);
    } catch {
      /* private mode or blocked storage: the choice simply lasts for this visit */
    }
  },
};

export interface Format {
  temp: (c: number) => string;
  delta: (c: number) => string;
  clock: (ms: number) => string;
  /** "Fri 13 Nov" from a YYYY-MM-DD date. */
  day: (date: string) => string;
  num: (v: number, digits?: number) => string;
  money: (cents: number) => string;
}

interface App {
  state: StateDto | null;
  plan: PlanDto | null;
  recommendation: RecommendationDto | null;
  /** Set when the plan cannot be made (for instance no thermostat). */
  planError: string | null;
  loadError: string | null;
  locale: Locale;
  units: Units;
  theme: Theme;
  setLocale: (l: Locale) => void;
  setUnits: (u: Units) => void;
  setTheme: (t: Theme) => void;
  t: (key: Key, params?: Record<string, string | number>) => string;
  fmt: Format;
  /** Re-read everything from the server. */
  refresh: () => Promise<void>;
  /** Run an action; on failure show the server's message. Returns whether it succeeded. */
  run: (action: () => Promise<unknown>, opts?: { refresh?: boolean; done?: string }) => Promise<boolean>;
  busy: boolean;
  toasts: { id: number; text: string; kind: 'error' | 'ok' }[];
}

const Ctx = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(Ctx);
  if (!app) throw new Error('useApp must be used inside <AppProvider>');
  return app;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StateDto | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [recommendation, setRecommendation] = useState<RecommendationDto | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<App['toasts']>([]);
  const nextToast = useRef(1);

  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = remember.get('locale');
    if (saved === 'en' || saved === 'fr') return saved;
    return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  });
  const [units, setUnitsState] = useState<Units>(() => (remember.get('units') === 'F' ? 'F' : 'C'));
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = remember.get('theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toast = useCallback((text: string, kind: 'error' | 'ok') => {
    const id = nextToast.current++;
    setToasts((list) => [...list, { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setLoadError(null);
      const room = next.rooms[0];
      if (!room) return;
      try {
        const [p, r] = await Promise.all([api.plan(room.id), api.recommendation(room.id)]);
        setPlan(p);
        setRecommendation(r);
        setPlanError(null);
      } catch (err) {
        setPlan(null);
        setRecommendation(null);
        setPlanError(err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback<App['run']>(
    async (action, opts = {}) => {
      setBusy(true);
      try {
        await action();
        if (opts.refresh !== false) await refresh();
        if (opts.done) toast(opts.done, 'ok');
        return true;
      } catch (err) {
        toast(err instanceof RequestFailed || err instanceof Error ? err.message : String(err), 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, toast],
  );

  const timeZone = state?.household.timeZone ?? 'America/Toronto';
  const fmt = useMemo<Format>(() => {
    const tag = locale === 'fr' ? 'fr-CA' : 'en-CA';
    const clock = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    const day = new Intl.DateTimeFormat(tag, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return {
      temp: (c) => formatTemp(c, { locale, units }),
      delta: (c) => formatDelta(c, { locale, units }),
      clock: (ms) => clock.format(ms),
      day: (date) => day.format(new Date(`${date}T12:00:00Z`)),
      num: (v, digits = 1) => new Intl.NumberFormat(tag, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v),
      money: (cents) => new Intl.NumberFormat(tag, { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol' }).format(Math.abs(cents) / 100),
    };
  }, [locale, units, timeZone]);

  const app: App = {
    state,
    plan,
    recommendation,
    planError,
    loadError,
    locale,
    units,
    theme,
    setLocale: (l) => {
      remember.set('locale', l);
      setLocaleState(l);
    },
    setUnits: (u) => {
      remember.set('units', u);
      setUnitsState(u);
    },
    setTheme: (th) => {
      remember.set('theme', th);
      setThemeState(th);
    },
    t: (key, params) => translate(locale, key, params),
    fmt,
    refresh,
    run,
    busy,
    toasts,
  };
  return <Ctx.Provider value={app}>{children}</Ctx.Provider>;
}

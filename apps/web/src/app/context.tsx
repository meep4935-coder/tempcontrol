import type {
  EventDto,
  HoldDto,
  LiveSessionDto,
  Locale,
  NightDetailDto,
  PlanDto,
  RoomDto,
  SleeperDto,
  StateDto,
  TickDto,
  Units,
} from '@tempcontrol/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, RequestFailed } from '../lib/api';
import { makeFormatter, type Formatter } from '../lib/format';
import { DICTS, type Dict } from '../lib/i18n';
import { readPref, writePref } from '../lib/storage';

export type Section = 'tonight' | 'history' | 'home' | 'assistant';
export const SECTIONS: Section[] = ['tonight', 'history', 'home', 'assistant'];

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface LiveView {
  session: LiveSessionDto;
  plan: PlanDto | null;
  ticks: TickDto[];
  events: EventDto[];
  hold: HoldDto | null;
}

export interface AppValue {
  state: StateDto;
  /** Increments whenever fresh state arrives, so views can refetch what depends on it. */
  version: number;
  setState: (s: StateDto) => void;
  refresh: () => Promise<void>;
  t: Dict;
  f: Formatter;
  lang: Locale;
  setLang: (l: Locale) => void;
  units: Units;
  setUnits: (u: Units) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  reportError: (err: unknown) => void;
  /** Runs an action, reporting any failure. Resolves to undefined on failure. */
  act: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  room: RoomDto | null;
  sleeper: (id: string | undefined) => SleeperDto | undefined;
  sleeperName: (id: string | undefined) => string;
  /** CSS colour of a sleeper's identity (chart series, swatches). */
  sleeperColor: (id: string | undefined) => string;
  live: LiveView | null;
  liveRunning: boolean;
  startLive: (secondsPerNight: number) => Promise<void>;
  morning: NightDetailDto | null;
  dismissMorning: () => void;
  section: Section;
  go: (s: Section) => void;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

const SERIES = ['var(--series-a)', 'var(--series-b)', 'var(--series-measured)'];

function initialLang(): Locale {
  const saved = readPref('lang');
  if (saved === 'en' || saved === 'fr') return saved;
  try {
    return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

function initialUnits(): Units {
  const saved = readPref('units');
  return saved === 'F' ? 'F' : 'C';
}

function systemDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function sectionFromHash(): Section {
  const h = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (SECTIONS as string[]).includes(h) ? (h as Section) : 'tonight';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AppProvider({ initial, children }: { initial: StateDto; children: ReactNode }) {
  const [state, setStateRaw] = useState<StateDto>(initial);
  const [version, setVersion] = useState(0);
  const [lang, setLangRaw] = useState<Locale>(initialLang);
  const [units, setUnitsRaw] = useState<Units>(initialUnits);
  const [themePref, setThemePref] = useState<'light' | 'dark' | null>(() => {
    const v = readPref('theme');
    return v === 'light' || v === 'dark' ? v : null;
  });
  const [sysDark, setSysDark] = useState(systemDark);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [live, setLive] = useState<LiveView | null>(null);
  const [morning, setMorning] = useState<NightDetailDto | null>(null);
  const [section, setSection] = useState<Section>(sectionFromHash);

  const t = DICTS[lang];
  const f = useMemo(() => makeFormatter(lang, units, state.household.timeZone), [lang, units, state.household.timeZone]);
  const theme: 'light' | 'dark' = themePref ?? (sysDark ? 'dark' : 'light');

  /* ------------------------------------------------------------ preferences */

  useEffect(() => {
    document.documentElement.lang = lang === 'fr' ? 'fr-CA' : 'en-CA';
    document.title = `${t.app.name} · ${t.nav[section]}`;
  }, [lang, section, t]);

  useEffect(() => {
    if (themePref) document.documentElement.setAttribute('data-theme', themePref);
    else document.documentElement.removeAttribute('data-theme');
  }, [themePref]);

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const on = () => setSysDark(mq!.matches);
    mq.addEventListener('change', on);
    return () => mq!.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const setLang = useCallback((l: Locale) => {
    setLangRaw(l);
    writePref('lang', l);
  }, []);
  const setUnits = useCallback((u: Units) => {
    setUnitsRaw(u);
    writePref('units', u);
  }, []);
  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemePref(next);
    writePref('theme', next);
  }, [theme]);
  const go = useCallback((s: Section) => {
    window.location.hash = `#/${s}`;
  }, []);

  /* ----------------------------------------------------------------- toasts */

  const nextId = useRef(1);
  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), kind === 'error' ? 12000 : 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((x) => x.id !== id)), []);

  /* ------------------------------------------------------------------ state */

  const setState = useCallback((s: StateDto) => {
    setStateRaw(s);
    setVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    setState(await api.state());
  }, [setState]);

  const tRef = useRef(t);
  tRef.current = t;

  const reportError = useCallback(
    (err: unknown) => {
      const d = tRef.current.errors;
      if (err instanceof RequestFailed) {
        const known = (d as unknown as Record<string, unknown>)[err.code];
        // Known codes get a translated sentence; anything else shows the server's own message.
        toast(typeof known === 'string' ? known : d.generic(err.message), 'error');
        if (err.code === 'not_found' || err.code === 'live_running') void refresh().catch(() => undefined);
      } else {
        toast(d.generic(err instanceof Error ? err.message : String(err)), 'error');
      }
    },
    [toast, refresh],
  );

  const act = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const out = await fn();
        if (success) toast(success);
        return out;
      } catch (err) {
        reportError(err);
        return undefined;
      }
    },
    [reportError, toast],
  );

  /* ------------------------------------------------------------------- live */

  const polling = useRef(false);
  const ticksRef = useRef<TickDto[]>([]);
  const sessionRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      polling.current = false;
    };
  }, []);

  const openMorning = useCallback(
    async (nightId: string) => {
      try {
        const [detail, fresh] = await Promise.all([api.night(nightId), api.state()]);
        if (!mounted.current) return;
        setState(fresh);
        setMorning(detail);
      } catch (err) {
        reportError(err);
      }
    },
    [reportError, setState],
  );

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    let failures = 0;
    try {
      while (polling.current && mounted.current) {
        let u;
        try {
          u = await api.live(ticksRef.current.length);
          failures = 0;
        } catch (err) {
          if (failures === 0) reportError(err);
          failures++;
          await sleep(2000);
          continue;
        }
        if (!u.session) {
          setLive(null);
          break;
        }
        if (sessionRef.current !== u.session.id) {
          // A different session than the one we were following: start its trace from the beginning.
          sessionRef.current = u.session.id;
          ticksRef.current = [];
          if (u.session.ticks > u.ticks.length) continue;
        }
        ticksRef.current = ticksRef.current.concat(u.ticks);
        setLive({ session: u.session, plan: u.plan, ticks: ticksRef.current, events: u.events, hold: u.hold });
        if (u.session.status === 'finished') {
          if (u.session.nightId) {
            writePref('morningSeen', u.session.nightId);
            await openMorning(u.session.nightId);
          }
          break;
        }
        await sleep(500);
      }
    } finally {
      polling.current = false;
    }
  }, [openMorning, reportError]);

  const startLive = useCallback(
    async (secondsPerNight: number) => {
      const room = state.rooms[0];
      if (!room) return;
      try {
        setMorning(null);
        const u = await api.liveStart(room.id, secondsPerNight);
        if (u.session) {
          sessionRef.current = u.session.id;
          ticksRef.current = u.ticks;
          setLive({ session: u.session, plan: u.plan, ticks: u.ticks, events: u.events, hold: u.hold });
          setStateRaw((s) => ({ ...s, live: u.session }));
        }
        void poll();
      } catch (err) {
        reportError(err);
      }
    },
    [state.rooms, poll, reportError],
  );

  // Pick up a night that is already playing (for example after a reload), or a finished one not yet reviewed.
  useEffect(() => {
    const s = state.live;
    if (s?.status === 'running' && !polling.current) void poll();
    if (s?.status === 'finished' && s.nightId && readPref('morningSeen') !== s.nightId && !live) {
      writePref('morningSeen', s.nightId);
      void openMorning(s.nightId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.live?.id, state.live?.status]);

  // A reset or a new state without a session ends what we were showing.
  useEffect(() => {
    if (!state.live && live) {
      polling.current = false;
      setLive(null);
    }
  }, [state.live, live]);

  const dismissMorning = useCallback(() => setMorning(null), []);

  /* --------------------------------------------------------------- helpers */

  const room = state.rooms[0] ?? null;
  const sleeper = useCallback((id: string | undefined) => state.sleepers.find((s) => s.id === id), [state.sleepers]);
  const sleeperName = useCallback((id: string | undefined) => sleeper(id)?.name ?? t.app.someone, [sleeper, t]);
  const sleeperColor = useCallback(
    (id: string | undefined) => {
      const i = state.sleepers.findIndex((s) => s.id === id);
      return SERIES[Math.max(0, i) % SERIES.length]!;
    },
    [state.sleepers],
  );

  const liveRunning = live?.session.status === 'running' || state.live?.status === 'running';

  const value: AppValue = {
    state,
    version,
    setState,
    refresh,
    t,
    f,
    lang,
    setLang,
    units,
    setUnits,
    theme,
    toggleTheme,
    toast,
    reportError,
    act,
    room,
    sleeper,
    sleeperName,
    sleeperColor,
    live,
    liveRunning,
    startLive,
    morning,
    dismissMorning,
    section,
    go,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toasts toasts={toasts} dismiss={dismissToast} label={t.app.dismiss} />
    </Ctx.Provider>
  );
}

function Toasts({ toasts, dismiss, label }: { toasts: Toast[]; dismiss: (id: number) => void; label: string }) {
  return (
    <div className="toasts">
      <div aria-live="polite" className="visually-hidden">
        {toasts
          .filter((x) => x.kind === 'info')
          .map((x) => x.text)
          .join(' ')}
      </div>
      <div role="alert" className="visually-hidden">
        {toasts
          .filter((x) => x.kind === 'error')
          .map((x) => x.text)
          .join(' ')}
      </div>
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind === 'error' ? 'toast-error' : ''}`}>
          {x.kind === 'error' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v6M12 16.5v.5" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <p>{x.text}</p>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => dismiss(x.id)} aria-label={label}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

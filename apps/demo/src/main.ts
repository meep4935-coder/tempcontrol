/**
 * A standalone demo: one sleeper, one bedroom, and the real learning engine.
 * Each night the engine plans the schedule, the simulated room follows it, the
 * simulated person reacts, and the engine learns from what happened.
 */

import {
  buildNightPlan,
  createModel,
  DEFAULT_LIMITS,
  estimateIdeal,
  learnFromNight,
  phaseAt,
  scoreNight,
  segmentAt,
  seededRng,
  type FeedbackKind,
  type NightMetrics,
  type NightPlan,
  type TempSample,
  type ThermalModelState,
} from '@tempcontrol/engine';
import { DEFAULT_TRUTH, ROOM_PRESETS, RoomNightSim, type SleeperTruth } from '@tempcontrol/engine/sim';
import './style.css';

const MIN = 60_000;
const TICK_MIN = 5;
const OPTIONS = { explore: true, cycleTracking: false, menopauseMode: false, recoveryAware: false };
const DAY_SETPOINT_C = 19;
const OUTDOOR_MEAN_C = -5;
const NIGHT_START = Date.UTC(2026, 10, 14, 23, 0);

type Preset = keyof typeof ROOM_PRESETS;
const ROOMS: { id: Preset; label: string }[] = [
  { id: 'central', label: 'Whole-home heat pump' },
  { id: 'miniSplit', label: 'Bedroom heat pump' },
  { id: 'baseboard', label: 'Electric baseboard' },
];

interface NightRecord {
  date: string;
  estimateC: number;
  sdC: number;
  score: number | null;
  roomAvgC: number;
  feedback: FeedbackKind | undefined;
  trace: TempSample[];
  plan: NightPlan;
  truth: number;
}

interface State {
  model: ThermalModelState;
  truth: SleeperTruth;
  room: Preset;
  seed: number;
  nights: NightRecord[];
}

const state: State = {
  model: createModel(),
  truth: { ...DEFAULT_TRUTH, idealCoreC: 18 },
  room: 'central',
  seed: 1,
  nights: [],
};

/** Run one night through the engine and the simulated world. */
function runNight(s: State): NightRecord {
  const index = s.nights.length;
  const bedtimeMs = NIGHT_START + index * 24 * 60 * MIN;
  const wakeMs = bedtimeMs + 8 * 60 * MIN;
  const rng = seededRng(s.seed * 1000 + index);
  const context = {};

  const plan = buildNightPlan({
    model: s.model,
    limits: DEFAULT_LIMITS,
    options: OPTIONS,
    bedtimeMs,
    wakeMs,
    seasonIndex: 1,
    context,
  });

  const sim = new RoomNightSim({
    startMs: plan.startMs,
    endMs: plan.endMs,
    tickMin: TICK_MIN,
    room: ROOM_PRESETS[s.room]!,
    mode: 'heat',
    initialTempC: DAY_SETPOINT_C,
    idleSetpointC: DAY_SETPOINT_C,
    outdoorMeanC: OUTDOOR_MEAN_C,
    rng,
    sleepers: [
      {
        id: 'you',
        truth: s.truth,
        bedtimeMs,
        wakeMs,
        realtime: false,
        ctx: { ...context, seasonIndex: 1 },
        phaseAt: (t) => phaseAt(plan, t),
      },
    ],
  });

  const samples: TempSample[] = [];
  while (!sim.done) {
    const seg = segmentAt(plan, sim.t);
    const reading = sim.advance({ setpointC: seg ? seg.targetC : DAY_SETPOINT_C });
    samples.push({ t: reading.t, roomTempC: reading.roomTempC });
  }
  const result = sim.finish()['you']!;
  const metrics: NightMetrics = result.metrics;
  const quality = scoreNight(metrics);
  const learned = learnFromNight(s.model, {
    plan,
    samples,
    metrics,
    context,
    preferences: result.feedback ? [{ kind: result.feedback }] : [],
  });
  s.model = learned.model;

  const asleep = samples.filter((x) => x.t >= bedtimeMs && x.t < wakeMs);
  const est = estimateIdeal(s.model, 1);
  return {
    date: new Date(bedtimeMs).toISOString().slice(0, 10),
    estimateC: est.coreC,
    sdC: est.sdC,
    score: quality.overall,
    roomAvgC: asleep.reduce((sum, x) => sum + x.roomTempC, 0) / Math.max(1, asleep.length),
    feedback: result.feedback,
    trace: samples,
    plan,
    truth: s.truth.idealCoreC,
  };
}

// ----- drawing ------------------------------------------------------------

const f1 = (v: number) => v.toFixed(1).replace('.', ',') + ' °C';

function nightCurve(rec: NightRecord): string {
  const W = 640, H = 220, L = 40, R = 12, T = 12, B = 28;
  const pts = rec.trace;
  const t0 = rec.plan.startMs, t1 = rec.plan.endMs;
  const planPts: [number, number][] = [];
  for (let t = t0; t <= t1; t += 5 * MIN) planPts.push([t, segmentAt(rec.plan, t)?.targetC ?? DAY_SETPOINT_C]);
  const all = [...pts.map((p) => p.roomTempC), ...planPts.map((p) => p[1])];
  const lo = Math.min(...all) - 0.5, hi = Math.max(...all) + 0.5;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (c: number) => T + (1 - (c - lo) / (hi - lo)) * (H - T - B);
  const line = (arr: [number, number][]) => arr.map(([t, c], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(c).toFixed(1)}`).join('');
  const ticks = [];
  for (let c = Math.ceil(lo); c <= hi; c += 1) ticks.push(`<text x="${L - 6}" y="${y(c) + 4}" font-size="12" text-anchor="end" fill="currentColor" opacity=".6">${c}</text>`);
  const hours = [];
  for (let t = t0; t <= t1; t += 2 * 60 * MIN) {
    const d = new Date(t);
    hours.push(`<text x="${x(t)}" y="${H - 8}" font-size="12" text-anchor="middle" fill="currentColor" opacity=".6">${String(d.getUTCHours()).padStart(2, '0')}:00</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tonight's plan and the room temperature">
    ${ticks.join('')}${hours.join('')}
    <path d="${line(planPts)}" fill="none" stroke="var(--hot)" stroke-width="2.5" stroke-dasharray="6 5"/>
    <path d="${line(pts.map((p) => [p.t, p.roomTempC] as [number, number]))}" fill="none" stroke="var(--series)" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
}

function learningChart(): string {
  const W = 640, H = 200, L = 40, R = 12, T = 12, B = 26;
  const recs = state.nights;
  if (recs.length === 0) return `<p class="muted">No nights yet. Press "Run a night" to start.</p>`;
  const vals = recs.flatMap((r) => [r.estimateC - r.sdC, r.estimateC + r.sdC, r.estimateC, r.truth]);
  const lo = Math.floor(Math.min(...vals)) - 0.5, hi = Math.ceil(Math.max(...vals)) + 0.5;
  const n = Math.max(2, recs.length);
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const y = (c: number) => T + (1 - (c - lo) / (hi - lo)) * (H - T - B);
  const band = recs.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.estimateC + r.sdC).toFixed(1)}`).join('') +
    recs.slice().reverse().map((r, k) => `L${x(recs.length - 1 - k).toFixed(1)},${y(r.estimateC - r.sdC).toFixed(1)}`).join('') + 'Z';
  const est = recs.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.estimateC).toFixed(1)}`).join('');
  const truth = `M${L},${y(recs[0]!.truth)}L${W - R},${y(recs[0]!.truth)}`;
  const grid = [];
  for (let c = Math.ceil(lo); c <= hi; c += 1) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(c)}" y2="${y(c)}" stroke="currentColor" opacity=".1"/><text x="${L - 6}" y="${y(c) + 4}" font-size="12" text-anchor="end" fill="currentColor" opacity=".6">${c}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The estimate of the ideal temperature after each night">
    ${grid.join('')}
    <path d="${band}" fill="var(--series)" opacity=".15"/>
    <path d="${truth}" stroke="var(--good)" stroke-width="2" stroke-dasharray="4 4" fill="none"/>
    <path d="${est}" stroke="var(--series)" stroke-width="3" fill="none"/>
    <text x="${W - R}" y="${H - 6}" font-size="12" text-anchor="end" fill="currentColor" opacity=".6">night ${recs.length}</text>
  </svg>`;
}

// ----- page ---------------------------------------------------------------

function render(): void {
  const app = document.getElementById('app')!;
  const last = state.nights[state.nights.length - 1];
  const est = estimateIdeal(state.model, 1);
  const room = ROOMS.find((r) => r.id === state.room)!;
  app.innerHTML = `
    <header>
      <h1>How a bedroom learns your temperature</h1>
      <p class="muted">A demo. One simulated sleeper, one simulated bedroom. The learning and planning are the real engine.</p>
    </header>

    <section class="card grid">
      <div>
        <h2>What the app thinks</h2>
        <p class="stat">${f1(est.coreC)}</p>
        <p class="muted">ideal deep-sleep temperature, ±${est.sdC.toFixed(1).replace('.', ',')} °C</p>
        <p class="muted">${state.nights.length} nights learned · confidence ${Math.round(est.confidence * 100)}%</p>
      </div>
      <div>
        <h2>The truth (only the demo knows)</h2>
        <p class="stat">${f1(state.truth.idealCoreC)}</p>
        <p class="muted">the sleeper's real preference, hidden from the app</p>
      </div>
    </section>

    <section class="card">
      <h2>Learning over the nights</h2>
      ${learningChart()}
      <div class="legend">
        <span><i style="background:var(--series)"></i>Estimate</span>
        <span><i style="background:var(--series);opacity:.25;height:10px"></i>Uncertainty</span>
        <span><i style="background:var(--good)"></i>True preference</span>
      </div>
    </section>

    <section class="card">
      <h2>${last ? `Last night (${last.date})` : 'Last night'}</h2>
      ${last ? `
        <div class="grid">
          <div><p class="stat">${last.score === null ? '–' : Math.round(last.score)}<small> / 100</small></p><p class="muted">sleep score</p></div>
          <div><p class="stat">${f1(last.roomAvgC)}</p><p class="muted">average room temperature while asleep</p></div>
        </div>
        <div style="margin-top:14px">${nightCurve(last)}</div>
        <div class="legend">
          <span><i style="background:var(--hot)"></i>Planned schedule</span>
          <span><i style="background:var(--series)"></i>Room temperature</span>
        </div>
        <p class="note">The sleeper's morning answer: ${last.feedback ? { tooHot: 'too warm', tooCold: 'too cold', justRight: 'just right' }[last.feedback] : 'none given'}.</p>
      ` : `<p class="muted">Run a night to see the plan and how the room followed it.</p>`}
    </section>

    <section class="card">
      <h2>Settings for the demo</h2>
      <label>The sleeper's real ideal temperature: <span id="truth-out">${f1(state.truth.idealCoreC)}</span>
        <input id="truth" type="range" min="15" max="23" step="0.5" value="${state.truth.idealCoreC}" />
      </label>
      <label>How sharply sleep suffers away from it: <span id="sens-out">${state.truth.sensitivity.toFixed(1)}</span>
        <input id="sens" type="range" min="0.5" max="2" step="0.1" value="${state.truth.sensitivity}" />
      </label>
      <label>Bedroom equipment: <span>${room.label}</span></label>
      <div class="row">
        <select id="room" aria-label="Bedroom equipment">
          ${ROOMS.map((r) => `<option value="${r.id}" ${r.id === state.room ? 'selected' : ''}>${r.label}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <button class="primary" id="one">Run a night</button>
        <button id="ten">Run 10 nights</button>
        <button id="reset">Start again</button>
      </div>
      <p class="note">Changing a setting applies from the next night. "Start again" forgets everything learned.</p>
    </section>
  `;
  bind();
}

function bind(): void {
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
  const run = (n: number) => {
    for (let i = 0; i < n; i++) state.nights.push(runNight(state));
    render();
  };
  $('one').onclick = () => run(1);
  $('ten').onclick = () => run(10);
  $('reset').onclick = () => {
    state.model = createModel();
    state.nights = [];
    render();
  };
  ($('truth') as HTMLInputElement).oninput = (e) => {
    state.truth = { ...state.truth, idealCoreC: Number((e.target as HTMLInputElement).value) };
    document.getElementById('truth-out')!.textContent = f1(state.truth.idealCoreC);
  };
  ($('sens') as HTMLInputElement).oninput = (e) => {
    state.truth = { ...state.truth, sensitivity: Number((e.target as HTMLInputElement).value) };
    document.getElementById('sens-out')!.textContent = state.truth.sensitivity.toFixed(1);
  };
  ($('room') as HTMLSelectElement).onchange = (e) => {
    state.room = (e.target as HTMLSelectElement).value as Preset;
    render();
  };
}

render();

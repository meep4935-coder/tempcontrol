/**
 * Charts, hand-drawn in SVG at the container's real pixel width so text stays
 * legible on a phone. Colour is assigned by role (see styles.css), every chart
 * can be inspected by pointer, touch or keyboard, and no chart has two y-axes.
 */

import type { Phase, PlanDto, RateLevel, TickDto } from '@tempcontrol/contracts';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useApp } from './store';

/** Live width of an element. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const MIN = 60_000;

interface Step {
  startMs: number;
  endMs: number;
  targetC: number;
}

function stepPath(steps: readonly Step[], x: (ms: number) => number, y: (c: number) => number): string {
  let d = '';
  steps.forEach((s, i) => {
    d += i === 0 ? `M${x(s.startMs)},${y(s.targetC)}` : `V${y(s.targetC)}`;
    d += `H${x(s.endMs)}`;
  });
  return d;
}

export function Legend({ items }: { items: { key: string; label: string; swatch: string }[] }) {
  return (
    <ul className="legend">
      {items.map((item) => (
        <li key={item.key}>
          <span className={`swatch ${item.swatch}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ the plan */

export interface PlanChartProps {
  plan: PlanDto;
  /** What actually happened, for a night in progress or a recorded one. */
  ticks?: readonly TickDto[];
  names: Record<string, string>;
  height?: number;
}

/**
 * A night: the room's schedule as a stepped line over shaded phases, each
 * sleeper's own plan when two share the room, the measured room temperature
 * when there is one, and the price of electricity along the bottom.
 */
export function PlanChart({ plan, ticks, names, height = 300 }: PlanChartProps) {
  const { t, fmt } = useApp();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const narrow = width < 520;
  const m = { left: narrow ? 44 : 52, right: 10, top: 24, bottom: 46 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const shared = plan.sleepers.length > 1;
  const recorded = ticks && ticks.length > 0 ? ticks : null;

  const [lo, hi] = useMemo(() => {
    const temps = plan.segments.map((s) => s.targetC);
    for (const s of plan.sleepers) for (const seg of s.segments) temps.push(seg.targetC);
    for (const tick of recorded ?? []) {
      temps.push(tick.roomTempC);
      if (tick.setpointC !== null) temps.push(tick.setpointC);
    }
    return [Math.floor(Math.min(...temps) - 0.5), Math.ceil(Math.max(...temps) + 0.5)];
  }, [plan, recorded]);

  const x = (ms: number): number => m.left + ((ms - plan.startMs) / (plan.endMs - plan.startMs)) * w;
  const y = (c: number): number => m.top + (1 - (c - lo) / (hi - lo)) * h;

  const bands = useMemo(() => {
    const out: { phase: Phase; startMs: number; endMs: number }[] = [];
    for (const seg of plan.segments) {
      const last = out[out.length - 1];
      if (last && last.phase === seg.phase) last.endMs = seg.endMs;
      else out.push({ phase: seg.phase, startMs: seg.startMs, endMs: seg.endMs });
    }
    return out;
  }, [plan]);

  const hours = useMemo(() => {
    // As many hour labels as fit without touching.
    const span = (plan.endMs - plan.startMs) / (60 * MIN);
    const fit = Math.max(2, Math.floor(w / 64));
    const every = Math.max(1, Math.ceil(span / fit)) * 60 * MIN;
    const out: number[] = [];
    for (let ms = Math.ceil(plan.startMs / every) * every; ms <= plan.endMs; ms += every) out.push(ms);
    return out;
  }, [plan, w]);
  const degrees = useMemo(() => {
    const step = hi - lo > 8 ? 2 : 1;
    const out: number[] = [];
    for (let c = lo; c <= hi; c += step) out.push(c);
    return out;
  }, [lo, hi]);

  const levels = [...new Set(plan.energy.periods.map((p) => (p.peakEvent ? 'critical' : p.level)))] as RateLevel[];
  const showPrices = levels.length > 1;

  const measured = recorded ? `M${recorded.map((tick) => `${x(tick.t)},${y(tick.roomTempC)}`).join('L')}` : '';
  const sent = recorded
    ? stepPath(
        recorded.filter((tick) => tick.setpointC !== null).map((tick) => ({ startMs: tick.t - 5 * MIN, endMs: tick.t, targetC: tick.setpointC! })),
        x,
        y,
      )
    : '';
  const nowMs = recorded && recorded[recorded.length - 1]!.t < plan.endMs - 5 * MIN ? recorded[recorded.length - 1]!.t : null;

  const at = hover === null ? null : Math.min(plan.endMs - 1, Math.max(plan.startMs, hover));
  const segment = at === null ? undefined : plan.segments.find((s) => at >= s.startMs && at < s.endMs);
  const tick = at === null || !recorded ? undefined : [...recorded].reverse().find((k) => k.t <= at + 5 * MIN && k.t >= at - 5 * MIN);

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    setHover(plan.startMs + ((px - m.left) / w) * (plan.endMs - plan.startMs));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = 15 * MIN;
    const current = at ?? plan.startMs;
    if (e.key === 'ArrowRight') setHover(Math.min(plan.endMs - 1, current + step));
    else if (e.key === 'ArrowLeft') setHover(Math.max(plan.startMs, current - step));
    else if (e.key === 'Home') setHover(plan.startMs);
    else if (e.key === 'End') setHover(plan.endMs - 1);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const legend = [
    { key: 'room', label: recorded ? t('chart.planned') : t('chart.room'), swatch: 'line c1' },
    ...(shared && !recorded ? plan.sleepers.map((s, i) => ({ key: s.sleeperId, label: t('chart.own', { name: names[s.sleeperId] ?? '' }), swatch: `line thin c${i + 2}` })) : []),
    ...(recorded
      ? [
          { key: 'measured', label: t('chart.measured'), swatch: 'line ink' },
          { key: 'sent', label: t('chart.sent'), swatch: 'line thin c2' },
        ]
      : []),
  ];

  return (
    <figure className="chart">
      <Legend items={legend} />
      <div
        ref={ref}
        className="chart-box"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={t('chart.planAria', { from: fmt.clock(plan.startMs), to: fmt.clock(plan.endMs) })}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {bands.map((b, i) => {
              const bw = x(b.endMs) - x(b.startMs);
              const label = t(`phase.${b.phase}`);
              return (
                <g key={b.startMs}>
                  <rect className={i % 2 === 0 ? 'band' : 'band alt'} x={x(b.startMs)} y={m.top} width={bw} height={h} />
                  {bw > label.length * 6.4 + 8 && (
                    <text className="band-label" x={x(b.startMs) + bw / 2} y={m.top - 8} textAnchor="middle">
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
            {degrees.map((c) => (
              <g key={c}>
                <line className="grid" x1={m.left} x2={m.left + w} y1={y(c)} y2={y(c)} />
                <text className="tick" x={m.left - 8} y={y(c)} dy="0.32em" textAnchor="end">
                  {fmt.temp(c)}
                </text>
              </g>
            ))}
            {hours.map((ms) => (
              <text key={ms} className="tick" x={x(ms)} y={m.top + h + (showPrices ? 30 : 18)} textAnchor="middle">
                {fmt.clock(ms)}
              </text>
            ))}

            {showPrices &&
              plan.energy.periods.map((p) => (
                <rect
                  key={p.startMs}
                  className={`price ${p.peakEvent ? 'critical' : p.level}`}
                  x={x(p.startMs) + 1}
                  y={m.top + h + 6}
                  width={Math.max(0, x(p.endMs) - x(p.startMs) - 2)}
                  height={8}
                  rx={2}
                />
              ))}

            {shared &&
              !recorded &&
              plan.sleepers.map((s, i) => <path key={s.sleeperId} className={`line thin c${i + 2}`} d={stepPath(s.segments, x, y)} />)}
            <path className={recorded ? 'line c1 faded' : 'line c1'} d={stepPath(plan.segments, x, y)} />
            {recorded && <path className="line thin c2" d={sent} />}
            {recorded && <path className="line ink" d={measured} />}
            {nowMs !== null && <line className="now" x1={x(nowMs)} x2={x(nowMs)} y1={m.top} y2={m.top + h} />}

            {at !== null && (
              <g>
                <line className="cross" x1={x(at)} x2={x(at)} y1={m.top} y2={m.top + h} />
                {segment && <circle className="dot c1" cx={x(at)} cy={y(segment.targetC)} r={5} />}
                {tick && <circle className="dot ink" cx={x(at)} cy={y(tick.roomTempC)} r={5} />}
              </g>
            )}
          </svg>
        )}
        {at !== null && segment && (
          <div className="tip" style={x(at) > width * 0.6 ? { right: width - x(at) + 12 } : { left: x(at) + 12 }}>
            <strong>{fmt.clock(at)}</strong> · {t(`phase.${segment.phase}`)}
            <dl>
              <dt>{recorded ? t('chart.planned') : t('chart.room')}</dt>
              <dd>{fmt.temp(segment.targetC)}</dd>
              {tick && (
                <>
                  <dt>{t('chart.measured')}</dt>
                  <dd>{fmt.temp(tick.roomTempC)}</dd>
                  {tick.setpointC !== null && (
                    <>
                      <dt>{t('chart.sent')}</dt>
                      <dd>{fmt.temp(tick.setpointC)}</dd>
                    </>
                  )}
                </>
              )}
              {shared &&
                segment.contributions.map((c) => (
                  <span key={c.sleeperId} style={{ display: 'contents' }}>
                    <dt>
                      {names[c.sleeperId]} ({Math.round(c.share * 100)}%)
                    </dt>
                    <dd>{fmt.temp(c.targetC)}</dd>
                  </span>
                ))}
            </dl>
          </div>
        )}
      </div>
      {showPrices && (
        <Legend items={levels.map((level) => ({ key: level, label: t(`price.${level}`), swatch: `block price ${level}` }))} />
      )}
    </figure>
  );
}

/* ------------------------------------------------------------- generic lines */

export interface Series {
  id: string;
  label: string;
  /** Colour role: c1..c3 for series, ink for the measured truth, muted for a baseline. */
  color: 'c1' | 'c2' | 'c3' | 'ink' | 'muted';
  values: (number | null)[];
  /** A plus-or-minus band around the line. */
  band?: { lo: number[]; hi: number[] };
  thin?: boolean;
}

export interface SeriesChartProps {
  labels: string[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
  /** A horizontal reference line, labelled at its right end. */
  reference?: { value: number; label: string };
  /** Text alternative. */
  aria: string;
  /** Force zero into the y-range (for quantities that start at zero). */
  zero?: boolean;
}

/** One or more lines over the same nights, with an optional band and reference line. */
export function SeriesChart({ labels, series, format, height = 220, reference, aria, zero }: SeriesChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const m = { left: 52, right: reference ? 14 : 10, top: 12, bottom: 26 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;

  const all: number[] = [];
  for (const s of series) {
    for (const v of s.values) if (v !== null) all.push(v);
    if (s.band) all.push(...s.band.lo, ...s.band.hi);
  }
  if (reference) all.push(reference.value);
  if (zero) all.push(0);
  if (all.length === 0) all.push(0, 1);
  const span = Math.max(1e-6, Math.max(...all) - Math.min(...all));
  const lo = zero ? Math.min(0, Math.min(...all)) : Math.min(...all) - span * 0.08;
  const hi = Math.max(...all) + span * 0.08;

  const x = (i: number): number => m.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number): number => m.top + (1 - (v - lo) / (hi - lo)) * h;
  const line = (values: (number | null)[]): string => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) pen = false;
      else {
        d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
        pen = true;
      }
    });
    return d;
  };

  // Ticks on round values (1, 2, 2.5 or 5 times a power of ten apart).
  const rough = (hi - lo) / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 2.5, 5, 10].find((u) => u * power >= rough)! * power;
  const yTicks: number[] = [];
  for (let v = Math.ceil(lo / unit) * unit; v <= hi + 1e-9; v += unit) yTicks.push(Math.round(v * 1e6) / 1e6);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  const index = (px: number): number => Math.min(n - 1, Math.max(0, Math.round(((px - m.left) / Math.max(1, w)) * (n - 1))));

  return (
    <figure className="chart">
      {series.length > 1 && <Legend items={series.map((s) => ({ key: s.id, label: s.label, swatch: `line ${s.thin ? 'thin ' : ''}${s.color}` }))} />}
      <div
        ref={ref}
        className="chart-box"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={aria}
        onPointerMove={(e) => setHover(index(e.clientX - e.currentTarget.getBoundingClientRect().left))}
        onPointerDown={(e) => setHover(index(e.clientX - e.currentTarget.getBoundingClientRect().left))}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover(Math.min(n - 1, (hover ?? -1) + 1));
          else if (e.key === 'ArrowLeft') setHover(Math.max(0, (hover ?? n) - 1));
          else if (e.key === 'Escape') setHover(null);
          else return;
          e.preventDefault();
        }}
      >
        {width > 0 && n > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {yTicks.map((v) => (
              <g key={v}>
                <line className="grid" x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} />
                <text className="tick" x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {format(v)}
                </text>
              </g>
            ))}
            {labels.map((label, i) =>
              i % every === 0 ? (
                <text key={i} className="tick" x={x(i)} y={m.top + h + 18} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
                  {label}
                </text>
              ) : null,
            )}
            {reference && (
              <g>
                <line className="reference" x1={m.left} x2={m.left + w} y1={y(reference.value)} y2={y(reference.value)} />
                <text className="tick strong" x={m.left + w} y={y(reference.value) - 6} textAnchor="end">
                  {reference.label}
                </text>
              </g>
            )}
            {series.map((s) =>
              s.band ? (
                <path
                  key={`${s.id}-band`}
                  className={`area ${s.color}`}
                  d={`M${s.band.hi.map((v, i) => `${x(i)},${y(v)}`).join('L')}L${[...s.band.lo].map((v, i) => `${x(i)},${y(v)}`).reverse().join('L')}Z`}
                />
              ) : null,
            )}
            {series.map((s) => (
              <path key={s.id} className={`line ${s.thin ? 'thin ' : ''}${s.color}`} d={line(s.values)} />
            ))}
            {n === 1 && series.map((s) => (s.values[0] === null ? null : <circle key={s.id} className={`dot ${s.color}`} cx={x(0)} cy={y(s.values[0]!)} r={5} />))}
            {hover !== null && (
              <g>
                <line className="cross" x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} />
                {series.map((s) => (s.values[hover] === null || s.values[hover] === undefined ? null : <circle key={s.id} className={`dot ${s.color}`} cx={x(hover)} cy={y(s.values[hover]!)} r={5} />))}
              </g>
            )}
          </svg>
        )}
        {hover !== null && n > 0 && (
          <div className="tip" style={x(hover) > width * 0.6 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }}>
            <strong>{labels[hover]}</strong>
            <dl>
              {series.map((s) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  <dt>{s.label}</dt>
                  <dd>{s.values[hover] === null || s.values[hover] === undefined ? '–' : format(s.values[hover]!)}</dd>
                </span>
              ))}
            </dl>
          </div>
        )}
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------- scatter */

export interface ScatterProps {
  points: { x: number; y: number; label: string }[];
  formatX: (v: number) => string;
  formatY: (v: number) => string;
  /** A vertical marker, for instance the current estimate. */
  marker?: { x: number; label: string };
  xTitle: string;
  yTitle: string;
  aria: string;
  height?: number;
}

/** One dot per night: was sleep better at some temperatures than others? */
export function Scatter({ points, formatX, formatY, marker, xTitle, yTitle, aria, height = 240 }: ScatterProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { left: 48, right: 26, top: 18, bottom: 40 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const xs = points.map((p) => p.x).concat(marker ? [marker.x] : []);
  const ys = points.map((p) => p.y);
  const xLo = Math.floor(Math.min(...xs, 99) - 0.5);
  const xHi = Math.ceil(Math.max(...xs, -99) + 0.5);
  const yLo = Math.max(0, Math.floor((Math.min(...ys, 100) - 5) / 10) * 10);
  const yHi = Math.min(100, Math.ceil((Math.max(...ys, 0) + 5) / 10) * 10);
  const x = (v: number): number => m.left + ((v - xLo) / Math.max(1e-6, xHi - xLo)) * w;
  const y = (v: number): number => m.top + (1 - (v - yLo) / Math.max(1e-6, yHi - yLo)) * h;
  const xTicks: number[] = [];
  for (let v = xLo; v <= xHi; v += xHi - xLo > 6 ? 2 : 1) xTicks.push(v);
  const yTicks: number[] = [];
  for (let v = yLo; v <= yHi; v += 10) yTicks.push(v);

  const nearest = (px: number, py: number): number | null => {
    let best: number | null = null;
    let bestD = 24 * 24;
    points.forEach((p, i) => {
      const d = (x(p.x) - px) ** 2 + (y(p.y) - py) ** 2;
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };
  const p = hover === null ? null : points[hover];

  return (
    <figure className="chart">
      <div
        ref={ref}
        className="chart-box"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={aria}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(nearest(e.clientX - box.left, e.clientY - box.top));
        }}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (points.length === 0) return;
          if (e.key === 'ArrowRight') setHover(((hover ?? -1) + 1) % points.length);
          else if (e.key === 'ArrowLeft') setHover(((hover ?? points.length) - 1 + points.length) % points.length);
          else if (e.key === 'Escape') setHover(null);
          else return;
          e.preventDefault();
        }}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {yTicks.map((v) => (
              <g key={v}>
                <line className="grid" x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} />
                <text className="tick" x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {formatY(v)}
                </text>
              </g>
            ))}
            {xTicks.map((v) => (
              <text key={v} className="tick" x={x(v)} y={m.top + h + 16} textAnchor="middle">
                {formatX(v)}
              </text>
            ))}
            <text className="tick" x={m.left + w / 2} y={height - 4} textAnchor="middle">
              {xTitle}
            </text>
            <text className="tick" x={m.left} y={10} textAnchor="start">
              {yTitle}
            </text>
            {marker && (
              <g>
                <line className="reference" x1={x(marker.x)} x2={x(marker.x)} y1={m.top} y2={m.top + h} />
                <text className="tick strong" x={x(marker.x) + 6} y={m.top + 10} textAnchor="start">
                  {marker.label}
                </text>
              </g>
            )}
            {points.map((pt, i) => (
              <circle key={i} className={`dot c1${hover === i ? ' on' : ''}`} cx={x(pt.x)} cy={y(pt.y)} r={hover === i ? 6 : 4.5} />
            ))}
          </svg>
        )}
        {p && (
          <div className="tip" style={x(p.x) > width * 0.6 ? { right: width - x(p.x) + 12 } : { left: x(p.x) + 12 }}>
            <strong>{p.label}</strong>
            <dl>
              <dt>{xTitle}</dt>
              <dd>{formatX(p.x)}</dd>
              <dt>{yTitle}</dt>
              <dd>{formatY(p.y)}</dd>
            </dl>
          </div>
        )}
      </div>
    </figure>
  );
}

/** A labelled 0..1 meter. */
export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** The app's few pictures: a night's temperature curve, a week of bars, a score ring. */

import type { TickDto } from '@tempcontrol/contracts';
import { useEffect, useRef, useState, type RefObject } from 'react';

/** The width of an element, kept up to date as the layout changes. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export interface CurveMark {
  t: number;
  value: string;
  caption: string;
}

interface CurveProps {
  startMs: number;
  endMs: number;
  segments: readonly { startMs: number; endMs: number; targetC: number }[];
  /** What the room actually did; drawn as the main line when present. */
  ticks?: readonly TickDto[];
  /** Up to three labelled moments on the plan. */
  marks?: readonly CurveMark[];
  height?: number;
  aria: string;
  deg: (c: number) => string;
  clock: (ms: number) => string;
}

const STEP = 5 * 60_000;

/** The night as one smooth line. Touch or hover to read any moment. */
export function Curve({ startMs, endMs, segments, ticks, marks = [], height = 120, aria, deg, clock }: CurveProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);

  const planAt = (t: number): number => {
    let found = segments[0]?.targetC ?? 20;
    for (const s of segments) if (t >= s.startMs) found = s.targetC;
    return found;
  };
  // The thermostat steps; the room glides. Averaging over 45 minutes draws the glide.
  const times: number[] = [];
  for (let t = startMs; t <= endMs; t += STEP) times.push(t);
  const raw = times.map(planAt);
  const plan = raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(raw.length - 1, i + 4); k++) {
      sum += raw[k]!;
      n++;
    }
    return sum / n;
  });
  const index = (t: number): number => Math.min(times.length - 1, Math.max(0, Math.round((t - startMs) / STEP)));
  const room = (ticks ?? []).filter((k) => k.t >= startMs && k.t <= endMs);

  const all = [...plan, ...room.map((k) => k.roomTempC)];
  const lo = Math.min(...all) - 0.4;
  const hi = Math.max(...all) + 0.4;
  const labelSpace = marks.length > 0 ? 44 : 8;
  const top = 26;
  const x = (t: number): number => 6 + ((t - startMs) / Math.max(1, endMs - startMs)) * (width - 12);
  const y = (c: number): number => top + (1 - (c - lo) / Math.max(0.1, hi - lo)) * (height - top - labelSpace);
  const path = (pts: readonly (readonly [number, number])[]): string => pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  const planPath = path(times.map((t, i) => [x(t), y(plan[i]!)] as const));
  const roomPath = room.length > 1 ? path(room.map((k) => [x(k.t), y(k.roomTempC)] as const)) : null;
  const valueAt = (t: number): number => {
    const lastRoom = room[room.length - 1];
    if (lastRoom && t <= lastRoom.t) return room.reduce((best, k) => (Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best), room[0]!).roomTempC;
    return plan[index(t)]!;
  };

  const move = (clientX: number, target: SVGSVGElement): void => {
    const box = target.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left - 6) / Math.max(1, box.width - 12)));
    setAt(startMs + Math.round((ratio * (endMs - startMs)) / STEP) * STEP);
  };
  const step = (dir: number): void => setAt((t) => Math.min(endMs, Math.max(startMs, (t ?? startMs) + dir * 6 * STEP)));

  return (
    <div ref={ref} className="curve">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={aria}
        tabIndex={0}
        onPointerDown={(e) => move(e.clientX, e.currentTarget)}
        onPointerMove={(e) => move(e.clientX, e.currentTarget)}
        onPointerLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') step(1);
          else if (e.key === 'ArrowLeft') step(-1);
          else if (e.key === 'Escape') setAt(null);
        }}
      >
        <path d={planPath} className={roomPath ? 'curve-plan faint' : 'curve-plan'} />
        {roomPath && <path d={roomPath} className="curve-room" />}
        {at === null &&
          marks.map((m, i) => {
            const px = x(m.t);
            const anchor = px < 44 ? 'start' : px > width - 44 ? 'end' : 'middle';
            const tx = anchor === 'start' ? 6 : anchor === 'end' ? width - 6 : px;
            return (
              <g key={i}>
                <circle cx={px} cy={y(plan[index(m.t)]!)} r={5} className="curve-dot" />
                <text x={tx} y={height - 22} textAnchor={anchor} className="curve-value">
                  {m.value}
                </text>
                <text x={tx} y={height - 6} textAnchor={anchor} className="curve-caption">
                  {m.caption}
                </text>
              </g>
            );
          })}
        {at !== null && (
          <g>
            <line x1={x(at)} x2={x(at)} y1={top - 4} y2={height - labelSpace + 4} className="curve-hair" />
            <circle cx={x(at)} cy={y(valueAt(at))} r={5} className="curve-dot" />
            <text x={x(at) < 60 ? 6 : x(at) > width - 60 ? width - 6 : x(at)} y={14} textAnchor={x(at) < 60 ? 'start' : x(at) > width - 60 ? 'end' : 'middle'} className="curve-value">
              {clock(at)} · {deg(valueAt(at))}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

export interface Bar {
  key: string;
  label: string;
  value: number | null;
  onClick?: () => void;
}

/** A handful of bars with their numbers on top. Out of `max`. */
export function Bars({ items, max = 100, aria }: { items: readonly Bar[]; max?: number; aria: string }) {
  return (
    <div className="bars" role="group" aria-label={aria}>
      {items.map((b) => (
        <button key={b.key} className="bar" onClick={b.onClick} disabled={!b.onClick} aria-label={`${b.label}: ${b.value === null ? '–' : Math.round(b.value)}`}>
          <span className="bar-value">{b.value === null ? '–' : Math.round(b.value)}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ height: `${b.value === null ? 0 : Math.max(4, (b.value / max) * 100)}%` }} />
          </span>
          <span className="bar-label">{b.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A score out of 100 as a ring with the number inside. */
export function Ring({ value, size = 96, label }: { value: number | null; size?: number; label: string }) {
  const stroke = Math.max(6, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  const share = value === null ? 0 : Math.min(1, Math.max(0, value / 100));
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${value === null ? '–' : Math.round(value)}`}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-fill" strokeWidth={stroke} strokeDasharray={`${around * share} ${around}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="ring-number" style={{ fontSize: size * 0.34 }}>
        {value === null ? '–' : Math.round(value)}
      </span>
    </div>
  );
}

/** How far along something is, 0..1. */
export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="progress" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

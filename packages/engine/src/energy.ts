/**
 * Energy-aware scheduling.
 *
 * Electricity in much of Canada costs more at certain hours (Ontario time-of-use
 * and ultra-low overnight plans) or during declared peak events (Hydro-Quebec's
 * winter dynamic pricing). Heating and cooling are the largest flexible loads
 * in a home, and a bedroom holds its temperature for a while, so the plan can
 * be nudged to do its work just before an expensive period and coast through it.
 *
 * The shaping stays inside a comfort tolerance the user chooses (half a degree
 * by default). With a tolerance of zero it changes nothing.
 */

import type { RoomPlan, RoomSegment } from './couples';
import { settle } from './plan';
import { localParts, MIN } from './util';

export interface LocalizedText {
  en: string;
  fr: string;
}

export type RateLevel = 'low' | 'mid' | 'high' | 'critical';

export interface TariffRate {
  label: LocalizedText;
  centsPerKWh: number;
  level: RateLevel;
}

export interface TariffRule {
  /** Months (1-12) the rule applies to; all months when omitted. */
  months?: number[];
  /** Weekdays only or weekends (and holidays) only; every day when omitted. */
  days?: 'weekday' | 'weekend';
  /** Local hours, [fromHour, toHour). A range with fromHour > toHour wraps past midnight. */
  fromHour: number;
  toHour: number;
  /** Key into `rates`. */
  rate: string;
}

export interface Tariff {
  id: string;
  /** Province or territory code, for example "ON" or "QC". */
  region: string;
  utility: LocalizedText;
  name: LocalizedText;
  rates: Record<string, TariffRate>;
  /** Checked in order; the first rule that matches wins. */
  rules: TariffRule[];
  /** Rate used when no rule matches. */
  fallbackRate: string;
  /** Rate charged during declared peak events, for event-based plans. */
  peakEventRate?: string;
  /** When the utility typically calls events; used for display and simulation. */
  peakEventWindows?: { months: number[]; fromHour: number; toHour: number }[];
  /** Where the numbers came from and when they were last checked. Rates change; verify before relying on them. */
  source: { url: string; verifiedOn: string; note?: string };
}

export interface PeakEvent {
  startMs: number;
  endMs: number;
}

export interface PricePeriod {
  startMs: number;
  endMs: number;
  rate: string;
  centsPerKWh: number;
  level: RateLevel;
  peakEvent: boolean;
}

function ruleMatches(rule: TariffRule, month: number, weekend: boolean, hour: number): boolean {
  if (rule.months && !rule.months.includes(month)) return false;
  if (rule.days === 'weekday' && weekend) return false;
  if (rule.days === 'weekend' && !weekend) return false;
  return rule.fromHour <= rule.toHour ? hour >= rule.fromHour && hour < rule.toHour : hour >= rule.fromHour || hour < rule.toHour;
}

/** The rate in force at an instant. `holidays` are YYYY-MM-DD dates billed like weekends. */
export function rateKeyAt(tariff: Tariff, ms: number, timeZone: string, holidays: readonly string[] = []): string {
  const p = localParts(ms, timeZone);
  const weekend = p.weekday === 0 || p.weekday === 6 || holidays.includes(p.date);
  const hour = p.hour + p.minute / 60;
  return tariff.rules.find((r) => ruleMatches(r, p.month, weekend, hour))?.rate ?? tariff.fallbackRate;
}

/** Price of electricity across a window, as a list of back-to-back periods. */
export function pricePeriods(
  tariff: Tariff,
  startMs: number,
  endMs: number,
  timeZone: string,
  opts: { events?: readonly PeakEvent[]; holidays?: readonly string[] } = {},
): PricePeriod[] {
  const events = tariff.peakEventRate ? (opts.events ?? []) : [];
  // Rates change on the hour; half-hour steps also cover zones offset by 30 minutes.
  const cuts = new Set<number>([startMs, endMs]);
  const step = 30 * MIN;
  for (let t = Math.ceil(startMs / step) * step; t < endMs; t += step) cuts.add(t);
  for (const e of events) {
    if (e.startMs > startMs && e.startMs < endMs) cuts.add(e.startMs);
    if (e.endMs > startMs && e.endMs < endMs) cuts.add(e.endMs);
  }
  const times = [...cuts].sort((a, b) => a - b);

  const periods: PricePeriod[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i]!;
    const b = times[i + 1]!;
    const mid = (a + b) / 2;
    const peakEvent = events.some((e) => mid >= e.startMs && mid < e.endMs);
    const key = peakEvent ? tariff.peakEventRate! : rateKeyAt(tariff, mid, timeZone, opts.holidays);
    const rate = tariff.rates[key];
    if (!rate) throw new Error(`pricePeriods: tariff ${tariff.id} has no rate "${key}"`);
    const last = periods[periods.length - 1];
    if (last && last.rate === key && last.peakEvent === peakEvent) last.endMs = b;
    else periods.push({ startMs: a, endMs: b, rate: key, centsPerKWh: rate.centsPerKWh, level: rate.level, peakEvent });
  }
  return periods;
}

export type EnergyChangeKind = 'preheat' | 'precool' | 'coast';

export interface EnergyChange {
  kind: EnergyChangeKind;
  startMs: number;
  endMs: number;
  /** Largest shift from the comfort-only plan during this stretch. */
  deltaC: number;
  peakEvent: boolean;
}

export interface ShapeOptions {
  /** Degrees the user accepts being off the comfort-only plan. Zero disables shaping. */
  toleranceC: number;
  /** Whether the room is being heated or cooled tonight. */
  direction: 'heat' | 'cool' | 'none';
  stepC?: number;
  /** How far ahead of an expensive period to start preparing. */
  prepareMin?: number;
}

export interface ShapedPlan {
  plan: RoomPlan;
  changes: EnergyChange[];
}

/** A period counts as expensive when it costs clearly more than the cheapest part of the night. */
function expensive(p: PricePeriod, cheapest: number): boolean {
  return p.peakEvent || (p.centsPerKWh >= cheapest * 1.25 && p.centsPerKWh - cheapest >= 2);
}

/**
 * Reshape a room plan around electricity prices.
 *
 *  - During an expensive period the target relaxes by the tolerance in the
 *    direction that saves energy (cooler when heating, warmer when cooling).
 *  - In the run-up to it the room is prepared: the target moves the other way
 *    by the tolerance, and any change the plan would have made early in the
 *    expensive period (typically the wake-up warming) is brought forward so
 *    it finishes at the cheaper price.
 *  - During a declared peak event the tolerance is doubled (to at most 1.5
 *    degrees), since that is when the grid and the bill are most stressed.
 */
export function shapePlanForEnergy(plan: RoomPlan, periods: readonly PricePeriod[], opts: ShapeOptions): ShapedPlan {
  const tolerance = Math.max(0, opts.toleranceC);
  if (tolerance === 0 || opts.direction === 'none' || periods.length === 0 || plan.segments.length === 0) {
    return { plan, changes: [] };
  }
  const stepC = opts.stepC ?? 0.5;
  const prepare = (opts.prepareMin ?? 45) * MIN;
  const sign = opts.direction === 'heat' ? 1 : -1; // direction that uses energy
  const cheapest = Math.min(...periods.map((p) => p.centsPerKWh));
  const costly = periods.filter((p) => expensive(p, cheapest));
  if (costly.length === 0) return { plan, changes: [] };

  const baseAt = (t: number): RoomSegment | undefined => plan.segments.find((s) => t >= s.startMs && t < s.endMs);
  const costlyAt = (t: number): PricePeriod | undefined => costly.find((p) => t >= p.startMs && t < p.endMs);
  const band = (p: PricePeriod): number => (p.peakEvent ? Math.min(2 * tolerance, 1.5) : tolerance);

  // Starts of expensive runs (an expensive period not directly preceded by another).
  const runStarts = costly.filter((p) => !costly.some((q) => q.endMs === p.startMs));

  const cuts = new Set<number>([plan.startMs, plan.endMs]);
  for (const seg of plan.segments) {
    cuts.add(seg.startMs).add(seg.endMs);
    cuts.add(seg.startMs - prepare).add(seg.endMs - prepare);
  }
  for (const p of costly) cuts.add(p.startMs).add(p.endMs);
  for (const p of runStarts) cuts.add(p.startMs - prepare);
  const times = [...cuts].filter((t) => t >= plan.startMs && t <= plan.endMs).sort((a, b) => a - b);

  const segments: RoomSegment[] = [];
  const changes: EnergyChange[] = [];
  const note = (kind: EnergyChangeKind, startMs: number, endMs: number, deltaC: number, peakEvent: boolean): void => {
    const last = changes[changes.length - 1];
    if (last && last.kind === kind && last.endMs === startMs && last.peakEvent === peakEvent) {
      last.endMs = endMs;
      if (Math.abs(deltaC) > Math.abs(last.deltaC)) last.deltaC = deltaC;
    } else {
      changes.push({ kind, startMs, endMs, deltaC, peakEvent });
    }
  };

  for (let i = 0; i + 1 < times.length; i++) {
    const startMs = times[i]!;
    const endMs = times[i + 1]!;
    const mid = (startMs + endMs) / 2;
    const base = baseAt(mid);
    if (!base) continue;

    let target = base.targetC;
    const now = costlyAt(mid);
    const upcoming = now ? undefined : runStarts.find((p) => mid < p.startMs && mid >= p.startMs - prepare);

    if (now) {
      target = settle(base.targetC - sign * band(now), plan.limits, stepC);
      if (target !== base.targetC) note('coast', startMs, endMs, target - base.targetC, now.peakEvent);
    } else if (upcoming) {
      const banked = base.targetC + sign * band(upcoming);
      const later = baseAt(mid + prepare)?.targetC ?? base.targetC;
      const wanted = sign > 0 ? Math.max(banked, later) : Math.min(banked, later);
      target = settle(wanted, plan.limits, stepC);
      if (target !== base.targetC) {
        note(sign > 0 ? 'preheat' : 'precool', startMs, endMs, target - base.targetC, upcoming.peakEvent);
      }
    }

    const last = segments[segments.length - 1];
    if (last && last.endMs === startMs && last.phase === base.phase && last.targetC === target && last.contributions === base.contributions) {
      last.endMs = endMs;
    } else {
      segments.push({ ...base, startMs, endMs, targetC: target });
    }
  }

  return { plan: { ...plan, segments }, changes };
}

/** Whether the room will need heating or cooling to hold `targetC` given the weather outside. */
export function hvacDirection(outdoorC: number | undefined, targetC: number): 'heat' | 'cool' | 'none' {
  if (outdoorC === undefined || !Number.isFinite(outdoorC)) return 'none';
  if (outdoorC < targetC - 3) return 'heat';
  if (outdoorC > targetC + 1) return 'cool';
  return 'none';
}

/** Cost in cents of energy used over time. `usage` is a list of (time, kWh used in the interval ending at time). */
export function energyCostCents(usage: readonly { t: number; kWh: number }[], periods: readonly PricePeriod[]): number {
  let cents = 0;
  for (const u of usage) {
    if (u.kWh === 0) continue;
    const p = periods.find((q) => u.t > q.startMs && u.t <= q.endMs) ?? periods[periods.length - 1];
    if (p) cents += u.kWh * p.centsPerKWh;
  }
  return cents;
}

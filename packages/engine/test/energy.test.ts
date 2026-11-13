import { describe, expect, it } from 'vitest';
import {
  buildNightPlan,
  buildRoomPlan,
  createModel,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  energyCostCents,
  flatTariff,
  getTariff,
  HOUR,
  hvacDirection,
  MIN,
  pricePeriods,
  roomSegmentAt,
  shapePlanForEnergy,
  zonedTimeToMs,
  type PricePeriod,
  type RoomPlan,
} from '../src/index';

const TZ = 'America/Toronto';
const at = (date: string, time: string): number => zonedTimeToMs(date, time, TZ);

/** A weekday night: Wednesday 18 November into Thursday 19 November 2026. */
function roomPlan(bed = '22:45', wake = '07:30', seasonIndex = 0.6): RoomPlan {
  const plan = buildNightPlan({
    sleeperId: 'a',
    model: createModel(),
    limits: DEFAULT_LIMITS,
    options: { ...DEFAULT_OPTIONS, explore: false },
    bedtimeMs: at('2026-11-18', bed),
    wakeMs: at('2026-11-19', wake),
    seasonIndex,
  });
  return buildRoomPlan([{ plan, limits: DEFAULT_LIMITS, weight: 1 }]);
}

const prices = (tariffId: string, plan: RoomPlan, events: { startMs: number; endMs: number }[] = []): PricePeriod[] =>
  pricePeriods(getTariff(tariffId)!, plan.startMs, plan.endMs, TZ, { events });

describe('electricity prices over a night', () => {
  it('splits an Ontario time-of-use weekday night at 7 am', () => {
    const plan = roomPlan();
    const periods = prices('on-tou', plan);
    expect(periods.map((p) => p.rate)).toEqual(['offPeak', 'onPeak']);
    expect(periods[0]!.startMs).toBe(plan.startMs);
    expect(periods[0]!.endMs).toBe(at('2026-11-19', '07:00'));
    expect(periods[1]!.endMs).toBe(plan.endMs);
    expect(periods[1]!.centsPerKWh).toBeGreaterThan(periods[0]!.centsPerKWh);
  });

  it('covers the window back to back for every tariff', () => {
    const plan = roomPlan();
    for (const id of ['on-tou', 'on-ulo', 'on-tiered', 'qc-d', 'qc-flex-d']) {
      const periods = prices(id, plan);
      expect(periods[0]!.startMs).toBe(plan.startMs);
      expect(periods[periods.length - 1]!.endMs).toBe(plan.endMs);
      for (let i = 1; i < periods.length; i++) expect(periods[i]!.startMs).toBe(periods[i - 1]!.endMs);
    }
  });

  it('prices a declared peak event at the event rate', () => {
    const plan = roomPlan('22:45', '07:30');
    const event = { startMs: at('2026-12-16', '06:00'), endMs: at('2026-12-16', '10:00') };
    const december = pricePeriods(getTariff('qc-flex-d')!, at('2026-12-15', '22:00'), at('2026-12-16', '08:00'), TZ, { events: [event] });
    expect(december[december.length - 1]).toMatchObject({ peakEvent: true, level: 'critical', startMs: event.startMs });
    expect(december[0]!.peakEvent).toBe(false);
    // A tariff without event pricing ignores events.
    expect(prices('on-tou', plan, [{ startMs: plan.startMs, endMs: plan.endMs }]).some((p) => p.peakEvent)).toBe(false);
  });

  it('is a single period on a flat tariff', () => {
    const plan = roomPlan();
    const periods = pricePeriods(flatTariff(12), plan.startMs, plan.endMs, TZ);
    expect(periods).toHaveLength(1);
    expect(periods[0]!.centsPerKWh).toBe(12);
  });
});

describe('energy-aware shaping', () => {
  it('changes nothing with zero tolerance, no direction, or flat prices', () => {
    const plan = roomPlan();
    const tou = prices('on-tou', plan);
    expect(shapePlanForEnergy(plan, tou, { toleranceC: 0, direction: 'heat' }).plan).toBe(plan);
    expect(shapePlanForEnergy(plan, tou, { toleranceC: 0.5, direction: 'none' }).plan).toBe(plan);
    expect(shapePlanForEnergy(plan, prices('on-tiered', plan), { toleranceC: 0.5, direction: 'heat' }).changes).toEqual([]);
  });

  it('brings the wake-up warming forward to finish before the on-peak price starts', () => {
    const plan = roomPlan('22:45', '07:30');
    const sevenAm = at('2026-11-19', '07:00');
    const wakeTarget = roomSegmentAt(plan, plan.endMs - MIN)!.targetC;
    // Unshaped, the room has not reached the wake target by 7:00.
    expect(roomSegmentAt(plan, sevenAm - 10 * MIN)!.targetC).toBeLessThan(wakeTarget);

    const { plan: shaped, changes } = shapePlanForEnergy(plan, prices('on-tou', plan), { toleranceC: 0.5, direction: 'heat' });
    // Shaped, the full wake target is asked for before 7:00...
    expect(roomSegmentAt(shaped, sevenAm - 10 * MIN)!.targetC).toBe(wakeTarget);
    // ...and from 7:00 the room coasts half a degree lower.
    expect(roomSegmentAt(shaped, sevenAm + 10 * MIN)!.targetC).toBe(wakeTarget - 0.5);
    expect(changes.map((c) => c.kind)).toEqual(['preheat', 'coast']);
    expect(changes[1]!.startMs).toBe(sevenAm);
  });

  it('never moves a target by more than the warming it brings forward or the tolerance', () => {
    const plan = roomPlan('22:45', '07:30');
    const { plan: shaped } = shapePlanForEnergy(plan, prices('on-tou', plan), { toleranceC: 0.5, direction: 'heat' });
    const maxPlanned = Math.max(...plan.segments.map((s) => s.targetC));
    for (let t = shaped.startMs; t < shaped.endMs; t += 5 * MIN) {
      const now = roomSegmentAt(shaped, t)!.targetC;
      const before = roomSegmentAt(plan, t)!.targetC;
      expect(now).toBeLessThanOrEqual(maxPlanned);
      expect(now).toBeGreaterThanOrEqual(before - 0.5);
      expect(now).toBeGreaterThanOrEqual(DEFAULT_LIMITS.minC);
    }
  });

  it('keeps the plan contiguous and the same length', () => {
    const plan = roomPlan('22:45', '07:30');
    const { plan: shaped } = shapePlanForEnergy(plan, prices('on-tou', plan), { toleranceC: 0.5, direction: 'heat' });
    expect(shaped.startMs).toBe(plan.startMs);
    expect(shaped.endMs).toBe(plan.endMs);
    expect(shaped.segments[0]!.startMs).toBe(plan.startMs);
    expect(shaped.segments[shaped.segments.length - 1]!.endMs).toBe(plan.endMs);
    for (let i = 1; i < shaped.segments.length; i++) expect(shaped.segments[i]!.startMs).toBe(shaped.segments[i - 1]!.endMs);
  });

  it('leaves a night alone when nothing expensive overlaps it', () => {
    // Saturday night: all off-peak.
    const plan = buildRoomPlan([
      {
        plan: buildNightPlan({
          model: createModel(),
          limits: DEFAULT_LIMITS,
          options: { ...DEFAULT_OPTIONS, explore: false },
          bedtimeMs: at('2026-11-21', '22:45'),
          wakeMs: at('2026-11-22', '07:30'),
          seasonIndex: 0.6,
        }),
        limits: DEFAULT_LIMITS,
        weight: 1,
      },
    ]);
    const shaped = shapePlanForEnergy(plan, pricePeriods(getTariff('on-tou')!, plan.startMs, plan.endMs, TZ), { toleranceC: 0.5, direction: 'heat' });
    expect(shaped.changes).toEqual([]);
  });

  it('pre-heats and coasts harder through a Hydro-Quebec peak event', () => {
    const plan = buildRoomPlan([
      {
        plan: buildNightPlan({
          model: createModel(),
          limits: DEFAULT_LIMITS,
          options: { ...DEFAULT_OPTIONS, explore: false },
          bedtimeMs: at('2026-12-15', '22:45'),
          wakeMs: at('2026-12-16', '06:45'),
          seasonIndex: 0.9,
        }),
        limits: DEFAULT_LIMITS,
        weight: 1,
      },
    ]);
    const event = { startMs: at('2026-12-16', '06:00'), endMs: at('2026-12-16', '10:00') };
    const periods = pricePeriods(getTariff('qc-flex-d')!, plan.startMs, plan.endMs, TZ, { events: [event] });
    const { plan: shaped, changes } = shapePlanForEnergy(plan, periods, { toleranceC: 0.5, direction: 'heat' });

    const wakeTarget = roomSegmentAt(plan, plan.endMs - MIN)!.targetC;
    // Warm before 6:00, at the cheap price.
    expect(roomSegmentAt(shaped, event.startMs - 5 * MIN)!.targetC).toBeGreaterThanOrEqual(wakeTarget);
    // During the event the tolerance doubles: a full degree below the comfort-only plan.
    expect(roomSegmentAt(shaped, plan.endMs - MIN)!.targetC).toBe(wakeTarget - 1);
    expect(changes.every((c) => c.peakEvent)).toBe(true);
    expect(changes.some((c) => c.kind === 'coast')).toBe(true);
  });

  it('mirrors the logic when cooling: pre-cool, then let the room drift up', () => {
    // Ultra-low overnight plan, summer weekday: on-peak until 21:00, mid-peak until 23:00.
    const plan = buildRoomPlan([
      {
        plan: buildNightPlan({
          model: createModel(),
          limits: DEFAULT_LIMITS,
          options: { ...DEFAULT_OPTIONS, explore: false },
          bedtimeMs: at('2026-07-15', '22:00'),
          wakeMs: at('2026-07-16', '06:00'),
          seasonIndex: -1,
        }),
        limits: DEFAULT_LIMITS,
        weight: 1,
      },
    ]);
    const periods = pricePeriods(getTariff('on-ulo')!, plan.startMs, plan.endMs, TZ);
    const { plan: shaped, changes } = shapePlanForEnergy(plan, periods, { toleranceC: 0.5, direction: 'cool' });
    const elevenPm = at('2026-07-15', '23:00');
    // Before 23:00 (mid-peak) the target is relaxed upward; nothing is ever pushed below the comfort plan.
    expect(roomSegmentAt(shaped, elevenPm - 30 * MIN)!.targetC).toBe(roomSegmentAt(plan, elevenPm - 30 * MIN)!.targetC + 0.5);
    expect(roomSegmentAt(shaped, elevenPm + 2 * HOUR)!.targetC).toBe(roomSegmentAt(plan, elevenPm + 2 * HOUR)!.targetC);
    expect(changes.some((c) => c.kind === 'coast')).toBe(true);
    expect(changes.every((c) => c.kind !== 'preheat')).toBe(true);
  });

  it('works out whether the room needs heating or cooling', () => {
    expect(hvacDirection(-10, 19)).toBe('heat');
    expect(hvacDirection(25, 19)).toBe('cool');
    expect(hvacDirection(18, 19)).toBe('none');
    expect(hvacDirection(undefined, 19)).toBe('none');
  });

  it('prices energy use by when it happened', () => {
    const plan = roomPlan('22:45', '07:30');
    const periods = prices('on-tou', plan);
    const offPeak = periods[0]!.centsPerKWh;
    const onPeak = periods[1]!.centsPerKWh;
    const usage = [
      { t: at('2026-11-19', '03:00'), kWh: 2 },
      { t: at('2026-11-19', '07:00'), kWh: 1 },
      { t: at('2026-11-19', '07:15'), kWh: 1 },
    ];
    expect(energyCostCents(usage, periods)).toBeCloseTo(3 * offPeak + onPeak, 6);
    expect(energyCostCents([], periods)).toBe(0);
  });
});

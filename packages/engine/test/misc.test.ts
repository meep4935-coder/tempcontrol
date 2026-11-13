import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarSeasonIndex,
  cToF,
  dayOfYear,
  formatClock,
  fToC,
  jetLagSchedule,
  localParts,
  parseClock,
  roundTo,
  scoreNight,
  seasonIndex,
  seasonName,
  seededRng,
  weatherSeasonIndex,
  zonedTimeToMs,
  type NightMetrics,
} from '../src/index';

describe('season', () => {
  it('peaks in late January and bottoms out in late July in the north', () => {
    expect(calendarSeasonIndex('2026-01-20', 45)).toBeCloseTo(1, 2);
    expect(calendarSeasonIndex('2026-07-21', 45)).toBeCloseTo(-1, 2);
    expect(Math.abs(calendarSeasonIndex('2026-04-21', 45))).toBeLessThan(0.05);
    expect(Math.abs(calendarSeasonIndex('2026-10-20', 45))).toBeLessThan(0.05);
  });

  it('flips in the southern hemisphere and fades toward the equator', () => {
    expect(calendarSeasonIndex('2026-01-20', -35)).toBeCloseTo(-1, 2);
    expect(calendarSeasonIndex('2026-01-20', 0)).toBeCloseTo(0, 6);
    expect(calendarSeasonIndex('2026-01-20', 15)).toBeCloseTo(0.5, 2);
  });

  it('lets the weather pull the index', () => {
    expect(weatherSeasonIndex(-20)).toBe(1);
    expect(weatherSeasonIndex(30)).toBe(-1);
    // A cold snap in April reads as more wintry than the calendar alone.
    expect(seasonIndex('2026-04-21', 45, -8)).toBeGreaterThan(seasonIndex('2026-04-21', 45) + 0.3);
    expect(seasonIndex('2026-04-21', 45, Number.NaN)).toBe(seasonIndex('2026-04-21', 45));
    expect(seasonIndex('2026-01-20', 45, -25)).toBeLessThanOrEqual(1);
  });

  it('names the season', () => {
    expect(seasonName('2026-01-15', 45)).toBe('winter');
    expect(seasonName('2026-04-20', 45)).toBe('spring');
    expect(seasonName('2026-07-15', 45)).toBe('summer');
    expect(seasonName('2026-10-20', 45)).toBe('autumn');
    expect(seasonName('2026-01-15', -34)).toBe('summer');
  });

  it('counts days of the year', () => {
    expect(dayOfYear('2026-01-01')).toBe(1);
    expect(dayOfYear('2026-12-31')).toBe(365);
    expect(dayOfYear('2028-12-31')).toBe(366);
  });
});

describe('time helpers', () => {
  it('converts local wall time to an instant, across daylight saving', () => {
    // Winter: Toronto is UTC-5. Summer: UTC-4.
    expect(new Date(zonedTimeToMs('2026-01-15', '22:30', 'America/Toronto')).toISOString()).toBe('2026-01-16T03:30:00.000Z');
    expect(new Date(zonedTimeToMs('2026-07-15', '22:30', 'America/Toronto')).toISOString()).toBe('2026-07-16T02:30:00.000Z');
    // Half-hour zone.
    expect(new Date(zonedTimeToMs('2026-01-15', '06:00', 'America/St_Johns')).toISOString()).toBe('2026-01-15T09:30:00.000Z');
  });

  it('round-trips through localParts', () => {
    for (const [date, time, zone] of [
      ['2026-11-13', '22:45', 'America/Toronto'],
      ['2026-03-08', '06:15', 'America/Vancouver'],
      ['2026-06-30', '00:00', 'America/Halifax'],
    ] as const) {
      const p = localParts(zonedTimeToMs(date, time, zone), zone);
      expect(p.date).toBe(date);
      expect(`${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`).toBe(time);
    }
    // 13 November 2026 is a Friday.
    expect(localParts(zonedTimeToMs('2026-11-13', '12:00', 'America/Toronto'), 'America/Toronto').weekday).toBe(5);
  });

  it('survives the spring-forward gap and the fall-back overlap', () => {
    // 02:30 does not exist on 8 March 2026 in Toronto; the result must still be a nearby instant.
    const gap = zonedTimeToMs('2026-03-08', '02:30', 'America/Toronto');
    expect(Math.abs(gap - Date.parse('2026-03-08T07:00:00Z'))).toBeLessThanOrEqual(3_600_000);
    const overlap = zonedTimeToMs('2026-11-01', '01:30', 'America/Toronto');
    expect(localParts(overlap, 'America/Toronto').hour).toBe(1);
  });

  it('does clock and date arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(parseClock('22:45')).toBe(1365);
    expect(formatClock(1365)).toBe('22:45');
    expect(formatClock(-30)).toBe('23:30');
    expect(formatClock(1470)).toBe('00:30');
    expect(roundTo(18.74, 0.5)).toBe(18.5);
    expect(cToF(20)).toBe(68);
    expect(fToC(68)).toBe(20);
  });

  it('gives reproducible random numbers', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const c = seededRng(43);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, c)).not.toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('sleep quality score', () => {
  const good: NightMetrics = {
    timeInBedMin: 480,
    totalSleepMin: 450,
    sleepEfficiency: 0.94,
    deepMin: 95,
    remMin: 110,
    awakenings: 1,
    restlessness: 0.07,
    hrvMs: 62,
    restingHr: 54,
    hrvBaselineMs: 55,
    restingHrBaseline: 56,
  };
  const poor: NightMetrics = { ...good, totalSleepMin: 340, sleepEfficiency: 0.74, deepMin: 45, remMin: 50, awakenings: 7, restlessness: 0.3, hrvMs: 44, restingHr: 61 };

  it('scores a good night high and a poor night low, within 0..100', () => {
    const g = scoreNight(good);
    const p = scoreNight(poor);
    expect(g.overall).toBeGreaterThan(80);
    expect(g.thermal).toBeGreaterThan(80);
    expect(p.overall).toBeLessThan(35);
    expect(p.thermal).toBeLessThan(35);
    for (const score of [g, p]) {
      expect(score.overall).toBeGreaterThanOrEqual(0);
      expect(score.overall).toBeLessThanOrEqual(100);
    }
  });

  it('keeps short-but-sound sleep from looking like a temperature problem', () => {
    const short: NightMetrics = { ...good, timeInBedMin: 330, totalSleepMin: 310, deepMin: 66, remMin: 76 };
    expect(scoreNight(short).thermal).toBeCloseTo(scoreNight(good).thermal, 0);
    expect(scoreNight(short).overall).toBeLessThan(scoreNight(good).overall);
  });

  it('works with whatever the device reports', () => {
    const minimal = scoreNight({ timeInBedMin: 480, totalSleepMin: 430, sleepEfficiency: 0.9 });
    expect(minimal.overall).toBeGreaterThan(50);
    expect(minimal.thermal).toBeGreaterThan(50);
    expect(minimal.components.continuity).toBeUndefined();
    expect(minimal.components.recovery).toBeUndefined();
  });
});

describe('jet lag schedule', () => {
  const base = { bedtime: '22:30', wakeTime: '06:30', arrivalDate: '2026-12-10' };

  it('returns nothing when there is no time difference', () => {
    expect(jetLagSchedule({ ...base, shiftHours: 0 })).toEqual([]);
  });

  it('shifts earlier before flying east, then meets the body clock part-way on arrival', () => {
    const nights = jetLagSchedule({ ...base, shiftHours: 6 });
    const home = nights.filter((n) => n.where === 'home');
    const away = nights.filter((n) => n.where === 'destination');
    expect(home.map((n) => n.date)).toEqual(['2026-12-07', '2026-12-08', '2026-12-09']);
    expect(home.map((n) => n.bedtime)).toEqual(['21:45', '21:00', '20:15']);
    expect(home.map((n) => n.wakeTime)).toEqual(['05:45', '05:00', '04:15']);
    // On arrival the body is still behind: bed later than usual by local time, closing nightly.
    expect(away[0]).toMatchObject({ date: '2026-12-10', bedtime: '00:30', offsetMin: 120 });
    expect(away.map((n) => n.offsetMin).every((v, i, a) => i === 0 || v <= a[i - 1]!)).toBe(true);
    expect(away[away.length - 1]!.remainingHours).toBe(0);
  });

  it('shifts later before flying west', () => {
    const nights = jetLagSchedule({ ...base, shiftHours: -3 });
    expect(nights.map((n) => [n.where, n.bedtime])).toEqual([
      ['home', '23:30'],
      ['home', '00:30'],
      ['home', '01:30'],
    ]);
    expect(nights[nights.length - 1]!.remainingHours).toBe(0);
  });

  it('can skip the preparation nights', () => {
    const nights = jetLagSchedule({ ...base, shiftHours: -3, prepareNights: 0 });
    expect(nights.every((n) => n.where === 'destination')).toBe(true);
    expect(nights[0]).toMatchObject({ bedtime: '20:30', offsetMin: -120 });
    expect(nights[nights.length - 1]!.remainingHours).toBe(0);
  });

  it('always terminates and never asks for more than two hours off the local schedule', () => {
    for (const shiftHours of [-12, -9, -1, 1, 5.5, 9, 12, 40]) {
      const nights = jetLagSchedule({ ...base, shiftHours });
      expect(nights.length).toBeLessThanOrEqual(17);
      expect(nights[nights.length - 1]!.remainingHours).toBe(0);
      for (const n of nights.filter((x) => x.where === 'destination')) expect(Math.abs(n.offsetMin)).toBeLessThanOrEqual(120);
    }
  });
});

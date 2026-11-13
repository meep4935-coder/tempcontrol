import { describe, expect, it } from 'vitest';
import { pricePeriods, rateKeyAt } from '../src/energy';
import { flatTariff, getTariff, TARIFFS, tariffsForRegion } from '../src/tariffs';
import { zonedTimeToMs } from '../src/util';
import type { Tariff } from '../src/energy';

const TOR = 'America/Toronto';
const MTL = 'America/Montreal';

// Dates used below (weekdays checked with `node -e`):
const WINTER_WED = '2026-11-18'; // Wednesday
const SATURDAY = '2026-11-21'; // Saturday
const SUMMER_WED = '2027-06-16'; // Wednesday
const CHRISTMAS = '2026-12-25'; // Friday (statutory holiday)
const QC_WINTER_TUE = '2026-12-15'; // Tuesday
const QC_SUMMER_WED = '2026-07-15'; // Wednesday

function must(id: string): Tariff {
  const t = getTariff(id);
  if (!t) throw new Error(`missing tariff ${id}`);
  return t;
}

const at = (t: Tariff, date: string, time: string, tz: string, holidays: string[] = []): string =>
  rateKeyAt(t, zonedTimeToMs(date, time, tz), tz, holidays);

describe('tariff data integrity', () => {
  it('has unique ids', () => {
    const ids = TARIFFS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the required tariffs', () => {
    for (const id of ['on-tou', 'on-ulo', 'on-tiered', 'qc-d', 'qc-flex-d', 'qc-winter-credit']) {
      expect(getTariff(id), id).toBeDefined();
    }
  });

  for (const t of TARIFFS) {
    describe(t.id, () => {
      it('references only existing rates', () => {
        expect(t.rates[t.fallbackRate], 'fallbackRate').toBeDefined();
        for (const r of t.rules) expect(t.rates[r.rate], r.rate).toBeDefined();
        if (t.peakEventRate !== undefined) expect(t.rates[t.peakEventRate]).toBeDefined();
      });

      it('has hours within 0..24 and months within 1..12', () => {
        const windows = [...t.rules, ...(t.peakEventWindows ?? [])];
        for (const w of windows) {
          expect(w.fromHour).toBeGreaterThanOrEqual(0);
          expect(w.fromHour).toBeLessThanOrEqual(24);
          expect(w.toHour).toBeGreaterThanOrEqual(0);
          expect(w.toHour).toBeLessThanOrEqual(24);
          expect(w.fromHour).not.toBe(w.toHour);
          for (const m of w.months ?? []) {
            expect(Number.isInteger(m)).toBe(true);
            expect(m).toBeGreaterThanOrEqual(1);
            expect(m).toBeLessThanOrEqual(12);
          }
        }
      });

      it('has sane prices and bilingual text', () => {
        const texts = [t.utility, t.name, ...Object.values(t.rates).map((r) => r.label)];
        for (const x of texts) {
          expect(x.en.trim()).not.toBe('');
          expect(x.fr.trim()).not.toBe('');
        }
        for (const r of Object.values(t.rates)) {
          expect(Number.isFinite(r.centsPerKWh)).toBe(true);
          expect(r.centsPerKWh).toBeGreaterThan(0);
          expect(r.centsPerKWh).toBeLessThan(100);
        }
        if (t.peakEventRate) {
          expect(t.rates[t.peakEventRate]!.level).toBe('critical');
          expect(t.peakEventWindows?.length ?? 0).toBeGreaterThan(0);
        }
      });

      it('has a source with a valid verification date', () => {
        expect(t.source.url).toMatch(/^https:\/\//);
        expect(t.source.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const d = new Date(`${t.source.verifiedOn}T00:00:00Z`);
        expect(Number.isNaN(d.getTime())).toBe(false);
        expect(d.toISOString().slice(0, 10)).toBe(t.source.verifiedOn);
        expect(t.source.note?.trim()).toBeTruthy();
      });
    });
  }
});

describe('lookups', () => {
  it('finds tariffs by region, case-insensitively', () => {
    expect(tariffsForRegion('ON').map((t) => t.id).sort()).toEqual(['on-tiered', 'on-tou', 'on-ulo']);
    expect(tariffsForRegion('qc').map((t) => t.id).sort()).toEqual(['qc-d', 'qc-flex-d', 'qc-winter-credit']);
    expect(tariffsForRegion('YT')).toEqual([]);
    expect(getTariff('nope')).toBeUndefined();
  });

  it('builds a flat tariff', () => {
    const f = flatTariff(12.5);
    expect(f.id).toBe('flat');
    expect(f.region).toBe('CA');
    expect(f.rates[f.fallbackRate]!.centsPerKWh).toBe(12.5);
    expect(at(f, WINTER_WED, '08:00', TOR)).toBe(f.fallbackRate);
    expect(() => flatTariff(Number.NaN)).toThrow();
    expect(() => flatTariff(-1)).toThrow();
  });
});

describe('Ontario Time-of-Use', () => {
  const tou = must('on-tou');

  it('uses winter weekday windows', () => {
    expect(at(tou, WINTER_WED, '06:59', TOR)).toBe('offPeak');
    expect(at(tou, WINTER_WED, '08:00', TOR)).toBe('onPeak');
    expect(at(tou, WINTER_WED, '13:00', TOR)).toBe('midPeak');
    expect(at(tou, WINTER_WED, '18:00', TOR)).toBe('onPeak');
    expect(at(tou, WINTER_WED, '21:00', TOR)).toBe('offPeak');
    expect(at(tou, WINTER_WED, '02:00', TOR)).toBe('offPeak');
  });

  it('uses summer weekday windows', () => {
    expect(at(tou, SUMMER_WED, '08:00', TOR)).toBe('midPeak');
    expect(at(tou, SUMMER_WED, '13:00', TOR)).toBe('onPeak');
    expect(at(tou, SUMMER_WED, '18:00', TOR)).toBe('midPeak');
    expect(at(tou, SUMMER_WED, '22:00', TOR)).toBe('offPeak');
  });

  it('bills weekends and passed-in holidays as off-peak', () => {
    expect(at(tou, SATURDAY, '08:00', TOR)).toBe('offPeak');
    expect(at(tou, SATURDAY, '18:00', TOR)).toBe('offPeak');
    expect(at(tou, CHRISTMAS, '08:00', TOR)).toBe('onPeak'); // a Friday, unless told it is a holiday
    expect(at(tou, CHRISTMAS, '08:00', TOR, [CHRISTMAS])).toBe('offPeak');
  });

  it('produces back-to-back periods over a winter weekday night and morning', () => {
    const start = zonedTimeToMs('2026-11-17', '22:00', TOR); // Tuesday evening
    const end = zonedTimeToMs(WINTER_WED, '12:00', TOR);
    const periods = pricePeriods(tou, start, end, TOR);
    expect(periods.map((p) => p.rate)).toEqual(['offPeak', 'onPeak', 'midPeak']);
    expect(periods[1]!.startMs).toBe(zonedTimeToMs(WINTER_WED, '07:00', TOR));
    expect(periods[2]!.startMs).toBe(zonedTimeToMs(WINTER_WED, '11:00', TOR));
    expect(periods[0]!.centsPerKWh).toBe(9.1);
    expect(periods[1]!.centsPerKWh).toBe(18.9);
    for (let i = 1; i < periods.length; i++) expect(periods[i]!.startMs).toBe(periods[i - 1]!.endMs);
  });
});

describe('Ontario Ultra-Low Overnight', () => {
  const ulo = must('on-ulo');

  it('applies the windows', () => {
    expect(at(ulo, WINTER_WED, '02:00', TOR)).toBe('ultraLow');
    expect(at(ulo, WINTER_WED, '23:30', TOR)).toBe('ultraLow');
    expect(at(ulo, WINTER_WED, '08:00', TOR)).toBe('midPeak');
    expect(at(ulo, WINTER_WED, '17:00', TOR)).toBe('onPeak');
    expect(at(ulo, WINTER_WED, '22:00', TOR)).toBe('midPeak');
    expect(at(ulo, SATURDAY, '02:00', TOR)).toBe('ultraLow');
    expect(at(ulo, SATURDAY, '17:00', TOR)).toBe('weekendOffPeak');
    expect(at(ulo, CHRISTMAS, '17:00', TOR, [CHRISTMAS])).toBe('weekendOffPeak');
    expect(ulo.rates.ultraLow!.centsPerKWh).toBe(3.7);
  });
});

describe('flat-by-hour tariffs', () => {
  it('Ontario tiered and Rate D never change by hour', () => {
    for (const id of ['on-tiered', 'qc-d']) {
      const t = must(id);
      const tz = id === 'qc-d' ? MTL : TOR;
      const start = zonedTimeToMs(WINTER_WED, '00:00', tz);
      const end = zonedTimeToMs('2026-11-25', '00:00', tz);
      expect(pricePeriods(t, start, end, tz)).toHaveLength(1);
    }
  });
});

describe('Hydro-Quebec Rate Flex D', () => {
  const flex = must('qc-flex-d');

  it('charges the winter price outside events and the base price outside winter', () => {
    expect(at(flex, QC_WINTER_TUE, '07:00', MTL)).toBe('winter');
    expect(at(flex, QC_SUMMER_WED, '07:00', MTL)).toBe('base');
    expect(at(flex, '2026-11-18', '07:00', MTL)).toBe('base'); // November is not in the winter period
  });

  it('charges the event price during a passed-in peak event', () => {
    const event = { startMs: zonedTimeToMs(QC_WINTER_TUE, '06:00', MTL), endMs: zonedTimeToMs(QC_WINTER_TUE, '10:00', MTL) };
    const start = zonedTimeToMs('2026-12-14', '22:00', MTL); // Monday night
    const end = zonedTimeToMs(QC_WINTER_TUE, '12:00', MTL);
    const periods = pricePeriods(flex, start, end, MTL, { events: [event] });
    expect(periods.map((p) => [p.rate, p.peakEvent])).toEqual([
      ['winter', false],
      ['peakEvent', true],
      ['winter', false],
    ]);
    expect(periods[1]!.startMs).toBe(event.startMs);
    expect(periods[1]!.endMs).toBe(event.endMs);
    expect(periods[1]!.centsPerKWh).toBe(46.463);
    expect(periods[1]!.level).toBe('critical');
    expect(periods[0]!.centsPerKWh).toBe(4.886);
  });
});

describe('Hydro-Quebec Winter Credit Option', () => {
  it('models an event as Rate D plus the credit', () => {
    const wc = must('qc-winter-credit');
    const d = must('qc-d');
    const base = d.rates[d.fallbackRate]!.centsPerKWh;
    expect(wc.rates[wc.fallbackRate]!.centsPerKWh).toBe(base);
    expect(wc.rates[wc.peakEventRate!]!.centsPerKWh).toBeCloseTo(base + 58.49, 3);

    const event = { startMs: zonedTimeToMs(QC_WINTER_TUE, '16:00', MTL), endMs: zonedTimeToMs(QC_WINTER_TUE, '20:00', MTL) };
    const periods = pricePeriods(wc, zonedTimeToMs(QC_WINTER_TUE, '12:00', MTL), zonedTimeToMs(QC_WINTER_TUE, '23:00', MTL), MTL, {
      events: [event],
    });
    expect(periods.map((p) => p.peakEvent)).toEqual([false, true, false]);
  });
});

describe('BC Hydro time-of-day', () => {
  it('applies the overnight discount and on-peak surcharge', () => {
    const bc = must('bc-tod');
    const tz = 'America/Vancouver';
    expect(at(bc, WINTER_WED, '02:00', tz)).toBe('overnight');
    expect(at(bc, WINTER_WED, '12:00', tz)).toBe('base');
    expect(at(bc, WINTER_WED, '18:00', tz)).toBe('onPeak');
    const r = bc.rates;
    expect(r.base!.centsPerKWh - r.overnight!.centsPerKWh).toBeCloseTo(5, 6);
    expect(r.onPeak!.centsPerKWh - r.base!.centsPerKWh).toBeCloseTo(5, 6);
  });
});

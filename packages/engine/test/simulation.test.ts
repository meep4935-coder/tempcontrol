/**
 * End-to-end checks: whole simulated nights run through planning, control,
 * live adjustment and learning, against sleepers whose true preference is
 * hidden from the engine. Results are averaged over several seeds so that no
 * single lucky or unlucky run decides a test.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUTH, ROOM_PRESETS, seasonalMode, simulateConstantSetpoint, type SleeperTruth } from '../src/sim';
import { runNights, type HarnessResult } from './harness';

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

const truth = (over: Partial<SleeperTruth>): SleeperTruth => ({ ...DEFAULT_TRUTH, ...over });
const solo = (t: SleeperTruth, over: object = {}) => ({ id: 'a', truth: t, bedtime: '22:45', wakeTime: '06:45', ...over });

const estimateAfter = (r: HarnessResult, night: number, id = 'a'): number => r.nights[night - 1]!.sleepers[id]!.estimateC;
const qualityOver = (r: HarnessResult, from: number, to: number, id = 'a'): number =>
  avg(r.nights.slice(from - 1, to).map((n) => n.sleepers[id]!.thermalQuality!));

describe('learning a hidden preference', () => {
  it('finds a cool sleeper and a warm sleeper within a month', () => {
    for (const [idealCoreC, startDate] of [
      [16.5, '2026-06-15'],
      [21, '2026-12-01'],
    ] as const) {
      const errors = seeds(4).map((seed) => {
        const r = runNights({ sleepers: [solo(truth({ idealCoreC }))], nights: 30, startDate, seed });
        return Math.abs(estimateAfter(r, 30) - idealCoreC);
      });
      expect(Math.max(...errors)).toBeLessThan(1);
      expect(avg(errors)).toBeLessThan(0.6);
    }
  });

  it('leaves a typical sleeper where they started', () => {
    const errors = seeds(4).map((seed) => {
      const r = runNights({ sleepers: [solo(truth({}))], nights: 30, startDate: '2026-09-01', seed });
      return Math.abs(estimateAfter(r, 30) - 18.5);
    });
    expect(avg(errors)).toBeLessThan(0.6);
  });

  it('still learns, more slowly, from sleep data alone', () => {
    // Someone who never overrides and never leaves feedback.
    const quiet = truth({ idealCoreC: 20.5, feedbackRate: 0, overrideRate: 0 });
    const runs = seeds(4).map((seed) => runNights({ sleepers: [solo(quiet)], nights: 60, startDate: '2026-09-01', seed }));
    const errorAt = (night: number): number => avg(runs.map((r) => Math.abs(estimateAfter(r, night) - 20.5)));
    expect(errorAt(60)).toBeLessThan(0.75);
    expect(errorAt(60)).toBeLessThan(errorAt(5));
  });

  it('grows more confident with data', () => {
    const r = runNights({ sleepers: [solo(truth({ idealCoreC: 20 }))], nights: 45, startDate: '2026-09-01', seed: 2 });
    const first = r.nights[0]!.sleepers.a!;
    const last = r.nights[44]!.sleepers.a!;
    expect(last.confidence).toBeGreaterThan(first.confidence + 0.2);
    expect(last.confidence).toBeGreaterThan(0.6);
    expect(last.sdC).toBeLessThan(0.7);
  });

  it('improves sleep for someone far from the typical temperature', () => {
    const cool = truth({ idealCoreC: 16.5 });
    const gains = seeds(4).map((seed) => {
      const r = runNights({ sleepers: [solo(cool)], nights: 42, startDate: '2026-06-15', seed });
      return qualityOver(r, 22, 42) - qualityOver(r, 1, 5);
    });
    expect(avg(gains)).toBeGreaterThan(3);
  });
});

describe('live adjustments', () => {
  it('cut discomfort for a sleeper whose wearable reports during the night', () => {
    const warm = truth({ idealCoreC: 20.5, feedbackRate: 0, overrideRate: 0 });
    const discomfort = (realtime: boolean): number =>
      avg(
        seeds(6).map((seed) => {
          const r = runNights({ sleepers: [solo(warm, { realtime })], nights: 21, startDate: '2026-05-01', seed });
          return avg(r.nights.map((n) => Math.abs(n.sleepers.a!.meanDiscomfortC)));
        }),
      );
    expect(discomfort(true)).toBeLessThan(0.8 * discomfort(false));
  });

  it('stay quiet for a sleeper who is already comfortable', () => {
    const r = runNights({ sleepers: [solo(truth({}), { realtime: true, options: { explore: false } })], nights: 14, startDate: '2026-09-01', seed: 3 });
    expect(avg(r.nights.map((n) => n.liveEvents))).toBeLessThan(0.5);
  });

  it('do nothing for a morning-sync wearable', () => {
    const r = runNights({ sleepers: [solo(truth({ idealCoreC: 21 }), { realtime: false })], nights: 10, startDate: '2026-05-01', seed: 1 });
    expect(r.nights.every((n) => n.liveEvents === 0)).toBe(true);
  });

  it('relieve hot flashes best with a personal fan', () => {
    const flashes = truth({ hotFlashesPerNight: 2.5, feedbackRate: 0, overrideRate: 0 });
    const quality = (menopauseMode: boolean, fan: boolean): number =>
      avg(
        seeds(6).map((seed) => {
          const r = runNights({
            sleepers: [solo(flashes, { realtime: true, fan, options: { menopauseMode, explore: false } })],
            nights: 14,
            startDate: '2026-06-01',
            seed,
          });
          return qualityOver(r, 1, 14);
        }),
      );
    const off = quality(false, false);
    const withFan = quality(true, true);
    expect(withFan).toBeGreaterThan(off + 0.8);
  });
});

describe('couples', () => {
  it('learns each partner\'s own preference from a shared room', () => {
    for (const seed of seeds(3)) {
      const r = runNights({
        sleepers: [
          { id: 'cool', truth: truth({ idealCoreC: 17.5 }), bedtime: '22:30', wakeTime: '06:30', realtime: true },
          { id: 'warm', truth: truth({ idealCoreC: 20.5 }), bedtime: '23:15', wakeTime: '07:15', realtime: false },
        ],
        nights: 45,
        startDate: '2026-05-01',
        seed,
      });
      const cool = estimateAfter(r, 45, 'cool');
      const warm = estimateAfter(r, 45, 'warm');
      expect(Math.abs(cool - 17.5)).toBeLessThan(0.75);
      expect(Math.abs(warm - 20.5)).toBeLessThan(0.75);
      expect(warm - cool).toBeGreaterThan(2);
      // The room settles between the two.
      const roomCore = r.nights[44]!.sleepers.cool!.coreTargetC;
      expect(roomCore).toBeGreaterThanOrEqual(15.5);
    }
  });
});

describe('seasons', () => {
  const year = runNights({
    sleepers: [solo(truth({}), { options: { explore: false } })],
    nights: 365,
    startDate: '2026-01-01',
    seed: 5,
    room: ROOM_PRESETS.central,
  });
  const month = (m: string) => year.nights.filter((n) => n.date.slice(5, 7) === m);

  it('warms winter mornings more than summer mornings', () => {
    const january = avg(month('01').map((n) => n.sleepers.a!.wakeTargetC));
    const july = avg(month('07').map((n) => n.sleepers.a!.wakeTargetC));
    expect(january - july).toBeGreaterThan(1.2);
    expect(avg(month('04').map((n) => n.sleepers.a!.wakeTargetC))).toBeLessThan(january);
  });

  it('keeps the deep-sleep temperature steady through the year for a steady sleeper', () => {
    const cores = ['01', '04', '07', '10'].map((m) => avg(month(m).map((n) => n.sleepers.a!.coreTargetC)));
    expect(Math.max(...cores) - Math.min(...cores)).toBeLessThan(0.6);
  });

  it('holds sleep quality through every season', () => {
    for (const m of ['01', '04', '07', '10']) expect(avg(month(m).map((n) => n.sleepers.a!.thermalQuality!))).toBeGreaterThan(72);
  });

  it('uses less heating overnight than leaving the thermostat at its daytime setting', () => {
    const january = month('01');
    const used = avg(january.map((n) => n.kWh));
    const baseline = avg(
      january.map((n) =>
        simulateConstantSetpoint(
          {
            startMs: n.startMs,
            endMs: n.endMs,
            tickMin: 5,
            room: ROOM_PRESETS.central!,
            mode: seasonalMode(n.outdoorC, ROOM_PRESETS.central!),
            initialTempC: n.initialTempC,
            outdoorMeanC: n.outdoorC,
          },
          21,
        ).reduce((sum, u) => sum + u.kWh, 0),
      ),
    );
    expect(used).toBeLessThan(0.95 * baseline);
  });
});

import { describe, expect, it } from 'vitest';
import { createLiveState, LIVE_LIMITS, liveOffset, liveStep, MIN, type LiveInput, type LiveSleeperInput, type LiveState, type LiveVitals } from '../src/index';

const calm: LiveVitals = { movement: 0.06, skinTempDeltaC: 0, heartRate: 58, heartRateBaseline: 58 };
const hot: LiveVitals = { movement: 0.4, skinTempDeltaC: 0.5, heartRate: 66, heartRateBaseline: 58 };
const cold: LiveVitals = { movement: 0.4, skinTempDeltaC: -0.5, heartRate: 58, heartRateBaseline: 58 };

const sleeper = (id: string, vitals: LiveVitals | null, over: Partial<LiveSleeperInput> = {}): LiveSleeperInput => ({
  id,
  vitals,
  inBed: true,
  menopauseMode: false,
  ...over,
});

/** Run the controller for `minutes` with fixed readings; return final state and everything it logged. */
function run(state: LiveState, startMin: number, minutes: number, sleepers: LiveSleeperInput[], over: Partial<LiveInput> = {}) {
  const events = [];
  let offset = liveOffset(state, startMin * MIN);
  for (let m = startMin; m < startMin + minutes; m += 5) {
    const step = liveStep(state, { t: m * MIN, phase: 'deep', roomTempC: 18.5, targetC: 18.5, sleepers, ...over });
    state = step.state;
    offset = step.offsetC;
    events.push(...step.events);
  }
  return { state, offset, events };
}

describe('live adjustments', () => {
  it('does nothing without live readings', () => {
    const { offset, events } = run(createLiveState(), 0, 240, [sleeper('a', null)]);
    expect(offset).toBe(0);
    expect(events).toEqual([]);
  });

  it('does nothing while the sleeper is calm', () => {
    const { offset, events } = run(createLiveState(), 0, 240, [sleeper('a', calm)]);
    expect(offset).toBe(0);
    expect(events).toEqual([]);
  });

  it('cools in half-degree steps when a sleeper is restless and warm', () => {
    const first = run(createLiveState(), 0, 15, [sleeper('a', hot)]);
    expect(first.offset).toBe(-0.5);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ reason: 'restlessWarm', deltaC: -0.5, sleeperId: 'a' });
  });

  it('waits between changes and stops at the cap', () => {
    const { offset, events } = run(createLiveState(), 0, 180, [sleeper('a', hot)]);
    expect(offset).toBe(LIVE_LIMITS.minOffsetC);
    expect(events).toHaveLength(3);
    for (let i = 1; i < events.length; i++) expect(events[i]!.t - events[i - 1]!.t).toBeGreaterThanOrEqual(LIVE_LIMITS.minGapMs);
  });

  it('warms when a sleeper is restless and cold, up to a smaller cap', () => {
    const { offset, events } = run(createLiveState(), 0, 180, [sleeper('a', cold)]);
    expect(offset).toBe(LIVE_LIMITS.maxOffsetC);
    expect(events.every((e) => e.reason === 'restlessCold')).toBe(true);
  });

  it('does not act on restlessness alone', () => {
    const fidgety: LiveVitals = { movement: 0.5, skinTempDeltaC: 0, heartRate: 58, heartRateBaseline: 58 };
    expect(run(createLiveState(), 0, 120, [sleeper('a', fidgety)]).offset).toBe(0);
  });

  it('reads a room that is warmer than asked as a warm sign', () => {
    const fidgety: LiveVitals = { movement: 0.5 };
    const { offset } = run(createLiveState(), 0, 20, [sleeper('a', fidgety)], { roomTempC: 19.5 });
    expect(offset).toBe(-0.5);
  });

  it('keeps a nudge for the rest of the night, and reverses it if it overshoots', () => {
    const nudged = run(createLiveState(), 0, 15, [sleeper('a', hot)]);
    expect(nudged.offset).toBe(-0.5);
    const later = run(nudged.state, 15, 240, [sleeper('a', calm)]);
    expect(later.offset).toBe(-0.5);
    expect(later.events).toEqual([]);
    const reversed = run(later.state, 255, 20, [sleeper('a', cold)]);
    expect(reversed.offset).toBe(0);
    expect(reversed.events.map((e) => e.reason)).toEqual(['restlessCold']);
  });

  it('never steers during the wind-down or the wake-up', () => {
    for (const phase of ['windDown', 'wake'] as const) {
      const { offset, events } = run(createLiveState(), 0, 120, [sleeper('a', hot)], { phase });
      expect(offset).toBe(0);
      expect(events).toEqual([]);
    }
  });

  it('moves the room less when only one of two partners is uncomfortable', () => {
    const { offset } = run(createLiveState(), 0, 180, [sleeper('a', hot), sleeper('b', calm)]);
    expect(offset).toBe(-LIVE_LIMITS.soloOffsetC);
  });

  it('moves the room fully when both partners agree', () => {
    const { offset } = run(createLiveState(), 0, 180, [sleeper('a', hot), sleeper('b', hot)]);
    expect(offset).toBe(LIVE_LIMITS.minOffsetC);
  });

  it('holds still when partners want opposite things', () => {
    const { offset, events } = run(createLiveState(), 0, 180, [sleeper('a', hot), sleeper('b', cold)]);
    expect(offset).toBe(0);
    expect(events).toEqual([]);
  });

  it('acts for a partner without a live wearable only as a calm presence', () => {
    // b has a morning-sync device: a's discomfort still counts, but with the solo cap.
    const { offset } = run(createLiveState(), 0, 180, [sleeper('a', hot), sleeper('b', null)]);
    expect(offset).toBe(-LIVE_LIMITS.soloOffsetC);
  });

  it('ignores a sleeper who is not in bed', () => {
    const { offset } = run(createLiveState(), 0, 120, [sleeper('a', hot, { inBed: false })]);
    expect(offset).toBe(0);
  });

  const flashing = (skin: number, over: Partial<LiveSleeperInput> = {}): LiveSleeperInput =>
    sleeper('a', { movement: 0.1, skinTempDeltaC: skin, heartRate: 60, heartRateBaseline: 58 }, { menopauseMode: true, ...over });
  const flashInput = (t: number, sleepers: LiveSleeperInput[]): LiveInput => ({ t: t * MIN, phase: 'deep', roomTempC: 18.5, targetC: 18.5, sleepers });

  it('answers a hot flash with a burst of room cooling', () => {
    let step = liveStep(createLiveState(), flashInput(0, [flashing(0)]));
    step = liveStep(step.state, flashInput(5, [flashing(0.7)]));
    expect(step.events.map((e) => e.reason)).toEqual(['hotFlash']);
    expect(step.offsetC).toBe(LIVE_LIMITS.boostC);

    // Still flashing: no second trigger, cooling holds.
    step = liveStep(step.state, flashInput(10, [flashing(0.9)]));
    expect(step.offsetC).toBe(LIVE_LIMITS.boostC);
    expect(step.events).toEqual([]);

    // Skin temperature is back down: the burst ends at once, well before its time limit.
    step = liveStep(step.state, flashInput(15, [flashing(0.1)]));
    expect(step.events.map((e) => e.reason)).toEqual(['hotFlashOver']);
    expect(step.offsetC).toBe(0);
  });

  it('never lets a burst outlast its time limit', () => {
    let step = liveStep(createLiveState(), flashInput(0, [flashing(0)]));
    step = liveStep(step.state, flashInput(5, [flashing(0.7)]));
    step = liveStep(step.state, flashInput(15, [flashing(0.9)]));
    expect(step.offsetC).toBe(LIVE_LIMITS.boostC);
    step = liveStep(step.state, flashInput(26, [flashing(0.9)]));
    expect(step.events.map((e) => e.reason)).toContain('hotFlashOver');
    expect(step.offsetC).toBe(0);
  });

  it('does not treat a fast skin-temperature rise as a hot flash unless the mode is on', () => {
    let step = liveStep(createLiveState(), { t: 0, phase: 'deep', roomTempC: 18.5, targetC: 18.5, sleepers: [sleeper('a', { movement: 0.1, skinTempDeltaC: 0 })] });
    step = liveStep(step.state, { t: 5 * MIN, phase: 'deep', roomTempC: 18.5, targetC: 18.5, sleepers: [sleeper('a', { movement: 0.1, skinTempDeltaC: 0.8 })] });
    expect(step.events).toEqual([]);
    expect(step.offsetC).toBe(0);
  });

  it('uses a gentler burst when a partner shares the bed', () => {
    const a = (skin: number): LiveSleeperInput => sleeper('a', { movement: 0.1, skinTempDeltaC: skin }, { menopauseMode: true });
    let step = liveStep(createLiveState(), { t: 0, phase: 'rem', roomTempC: 19, targetC: 19, sleepers: [a(0), sleeper('b', calm)] });
    step = liveStep(step.state, { t: 5 * MIN, phase: 'rem', roomTempC: 19, targetC: 19, sleepers: [a(0.8), sleeper('b', calm)] });
    expect(step.offsetC).toBe(LIVE_LIMITS.boostSharedC);
  });

  it('limits how many changes it makes in a night', () => {
    // Alternate hot and cold spells all night.
    let state = createLiveState();
    const events = [];
    for (let block = 0; block < 12; block++) {
      const result = run(state, block * 45, 45, [sleeper('a', block % 2 === 0 ? hot : cold)]);
      state = result.state;
      events.push(...result.events);
    }
    expect(events.length).toBe(LIVE_LIMITS.maxChanges);
  });

  it('does not mutate the state it is given', () => {
    const state = createLiveState();
    const frozen = JSON.stringify(state);
    liveStep(state, { t: 0, phase: 'deep', roomTempC: 18.5, targetC: 18.5, sleepers: [sleeper('a', hot)] });
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

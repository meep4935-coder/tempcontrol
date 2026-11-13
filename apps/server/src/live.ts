/**
 * A night played back at high speed, so the control loop can be watched and
 * interrupted: set a temperature by hand, say "I'm hot", end the night early.
 * One session at a time.
 */

import type { HoldDto, LiveSessionDto, LiveUpdateDto, NightDetailDto } from '@tempcontrol/contracts';
import { MIN } from '@tempcontrol/engine';
import { NightRunner, RequestError } from './night';
import { newId, type Store } from './store';

interface Session {
  id: string;
  runner: NightRunner;
  secondsPerNight: number;
  timer: NodeJS.Timeout | null;
  busy: boolean;
  status: 'running' | 'finished';
  nightId: string | null;
  finishing: Promise<NightDetailDto> | null;
}

const TICK_MS = 5 * MIN;

export class LiveManager {
  private session: Session | null = null;

  constructor(private readonly store: Store) {}

  get running(): boolean {
    return this.session?.status === 'running';
  }

  /** The runner of the night in progress, for a given room. */
  runnerFor(roomId: string): NightRunner | null {
    const s = this.session;
    return s && s.status === 'running' && s.runner.setup.room.id === roomId ? s.runner : null;
  }

  dto(): LiveSessionDto | null {
    const s = this.session;
    if (!s) return null;
    const { roomPlan, room, household } = s.runner.setup;
    return {
      id: s.id,
      roomId: room.id,
      date: household.date,
      status: s.status,
      clockMs: s.runner.clockMs,
      startMs: roomPlan.startMs,
      endMs: roomPlan.endMs,
      ticks: s.runner.ticks.length,
      secondsPerNight: s.secondsPerNight,
      nightId: s.nightId,
    };
  }

  start(roomId: string, secondsPerNight = 90): LiveSessionDto {
    if (this.running) throw new RequestError(409, 'live_running', 'A night is already playing.');
    const seconds = Math.min(600, Math.max(10, secondsPerNight));
    const runner = NightRunner.create(this.store, roomId);
    const totalTicks = Math.ceil((runner.setup.roomPlan.endMs - runner.setup.roomPlan.startMs) / TICK_MS);
    const session: Session = { id: newId('live'), runner, secondsPerNight: seconds, timer: null, busy: false, status: 'running', nightId: null, finishing: null };
    this.session = session;

    session.timer = setInterval(
      () => {
        if (session.busy || session.status !== 'running') return;
        session.busy = true;
        void (async () => {
          try {
            if (!runner.done) await runner.step();
            if (runner.done) await this.finalize(session);
          } catch (err) {
            // A failure mid-night must not leave a timer spinning; close the session.
            console.error('live night failed', err);
            this.halt(session);
          } finally {
            session.busy = false;
          }
        })();
      },
      Math.min(10_000, Math.max(40, (seconds * 1000) / totalTicks)),
    );
    session.timer.unref();
    return this.dto()!;
  }

  private halt(session: Session): void {
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    session.status = 'finished';
  }

  private finalize(session: Session): Promise<NightDetailDto> {
    session.finishing ??= (async () => {
      if (session.timer) clearInterval(session.timer);
      session.timer = null;
      const night = await session.runner.finish();
      session.nightId = night.id;
      session.status = 'finished';
      return night;
    })();
    return session.finishing;
  }

  /** Wait for any step in flight, so the session can be driven from here without overlapping it. */
  private async settle(session: Session): Promise<void> {
    while (session.busy) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  /** Skip to the end of the night at once and save it. */
  async finishNow(): Promise<LiveSessionDto | null> {
    const session = this.session;
    if (!session || session.status !== 'running') return this.dto();
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    await this.settle(session);
    session.busy = true;
    try {
      await session.runner.runToEnd();
      await this.finalize(session);
    } finally {
      session.busy = false;
    }
    return this.dto();
  }

  /** End the night at the current moment ("good morning") and save it. */
  async wake(): Promise<LiveSessionDto | null> {
    const session = this.session;
    if (!session || session.status !== 'running') return this.dto();
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    await this.settle(session);
    session.runner.wake();
    await this.finalize(session);
    return this.dto();
  }

  /** Forget the session without saving anything (used when the demo is reset). */
  discard(): void {
    if (this.session?.timer) clearInterval(this.session.timer);
    this.session = null;
  }

  update(since: number): LiveUpdateDto {
    const s = this.session;
    if (!s) return { session: null, plan: null, ticks: [], events: [], hold: null };
    const hold: HoldDto | null = s.status === 'running' ? s.runner.currentHold : null;
    return {
      session: this.dto(),
      plan: s.runner.setup.dto,
      ticks: s.runner.ticks.slice(Math.max(0, since)),
      events: [...s.runner.eventLog],
      hold,
    };
  }
}

/**
 * The assistant's own logic, with the AI model replaced by a stand-in:
 * what is sent, how a streamed answer is passed on, and what happens when the
 * model declines, fails, or the sleeper has not consented.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantEvent } from '@tempcontrol/contracts';
import { describe, expect, it } from 'vitest';
import { answer, type AssistantDeps, type ReplyStream } from '../src/assistant';
import { openDb } from '../src/db';
import { createDemo } from '../src/setup';
import { Store } from '../src/store';

type StreamParams = Parameters<NonNullable<AssistantDeps['openStream']>>[0];

async function demo(): Promise<Store> {
  const store = new Store(openDb(':memory:'));
  await createDemo(store, 'couple', 8, { today: '2026-11-13', seed: 7 });
  return store;
}

const text = (chunk: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }) as Anthropic.Beta.BetaRawMessageStreamEvent;
const thinking = { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } } as Anthropic.Beta.BetaRawMessageStreamEvent;

function fakeStream(events: Anthropic.Beta.BetaRawMessageStreamEvent[], stopReason = 'end_turn', failAfter?: number): ReplyStream {
  return {
    async *[Symbol.asyncIterator]() {
      let sent = 0;
      for (const e of events) {
        if (failAfter !== undefined && sent === failAfter) throw new Error('connection lost');
        sent++;
        yield e;
      }
    },
    finalMessage: async () => ({ stop_reason: stopReason }),
  };
}

async function collect(gen: AsyncGenerator<AssistantEvent>): Promise<{ events: AssistantEvent[]; text: string }> {
  const events: AssistantEvent[] = [];
  for await (const e of gen) events.push(e);
  return { events, text: events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('') };
}

describe('assistant', () => {
  it('passes a streamed answer straight through and says the AI answered', async () => {
    const store = await demo();
    const sleeper = store.sleepers(store.household()!.id)[1]!;
    const out = await collect(
      answer(store, { sleeperId: sleeper.id, message: 'Why is it cooler tonight?' }, { ai: true, openStream: () => fakeStream([thinking, text('It is '), text('humid.')]) }),
    );
    expect(out.text).toBe('It is humid.');
    expect(out.events[out.events.length - 1]).toEqual({ type: 'done', source: 'ai' });
  });

  it('sends the question, the history and a summary of the data, but nothing that identifies the person', async () => {
    const store = await demo();
    const household = store.household()!;
    const [camille] = store.sleepers(household.id);
    let seen: StreamParams | undefined;
    await collect(
      answer(
        store,
        { sleeperId: camille!.id, message: 'Et ce soir ?', history: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }] },
        {
          ai: true,
          openStream: (params) => {
            seen = params;
            return fakeStream([text('ok')]);
          },
        },
      ),
    );
    expect(seen).toBeDefined();
    expect(seen!.model).toBe('claude-opus-5-5');
    expect(seen!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(seen!.messages[2]!.content).toBe('Et ce soir ?');

    const sent = JSON.stringify(seen);
    expect(sent).toContain('Canadian French');
    expect(sent).toContain('idealCoreC');
    expect(sent).toContain('recentNights');
    // No names, no record ids, no location.
    for (const person of store.sleepers(household.id)) {
      expect(sent).not.toContain(person.name);
      expect(sent).not.toContain(person.id);
    }
    expect(sent).not.toContain(household.id);
    expect(sent).not.toContain('Montréal');
  });

  it('never calls the model for a sleeper who has not consented', async () => {
    const store = await demo();
    const sleeper = store.sleepers(store.household()!.id)[1]!;
    store.saveSleeper({ ...sleeper, aiAssistant: false });
    let called = false;
    const out = await collect(
      answer(store, { sleeperId: sleeper.id, message: 'How am I sleeping?' }, { ai: true, openStream: () => ((called = true), fakeStream([text('x')])) }),
    );
    expect(called).toBe(false);
    expect(out.text).toContain('switched off for this profile');
    expect(out.text).toContain('Your ideal deep-sleep temperature');
    expect(out.events[out.events.length - 1]).toEqual({ type: 'done', source: 'rules' });
  });

  it('never calls the model when none is configured', async () => {
    const store = await demo();
    const sleeper = store.sleepers(store.household()!.id)[1]!;
    let called = false;
    const out = await collect(answer(store, { sleeperId: sleeper.id, message: 'Hi' }, { ai: false, openStream: () => ((called = true), fakeStream([])) }));
    expect(called).toBe(false);
    expect(out.events[out.events.length - 1]).toEqual({ type: 'done', source: 'rules' });
  });

  it('falls back to computed insights when the model declines', async () => {
    const store = await demo();
    const sleeper = store.sleepers(store.household()!.id)[1]!;
    const out = await collect(answer(store, { sleeperId: sleeper.id, message: 'Hi' }, { ai: true, openStream: () => fakeStream([], 'refusal') }));
    expect(out.text).toContain('could not answer that');
    expect(out.text).toContain('Your ideal deep-sleep temperature');
    expect(out.events[out.events.length - 1]).toEqual({ type: 'done', source: 'rules' });
  });

  it('falls back when the model cannot be reached, even mid-answer', async () => {
    const store = await demo();
    const sleeper = store.sleepers(store.household()!.id)[0]!;
    const before = await collect(
      answer(store, { sleeperId: sleeper.id, message: 'Bonsoir' }, {
        ai: true,
        openStream: () => {
          throw new Error('no network');
        },
      }),
    );
    expect(before.text).toContain('injoignable');
    expect(before.events[before.events.length - 1]).toEqual({ type: 'done', source: 'rules' });

    const during = await collect(answer(store, { sleeperId: sleeper.id, message: 'Bonsoir' }, { ai: true, openStream: () => fakeStream([text('Ce soir'), text(' ...')], 'end_turn', 1) }));
    expect(during.text.startsWith('Ce soir')).toBe(true);
    expect(during.text).toContain('Votre température idéale');
    expect(during.events.filter((e) => e.type === 'done')).toEqual([{ type: 'done', source: 'rules' }]);
  });

  it('rejects an unknown sleeper', async () => {
    const store = await demo();
    await expect(collect(answer(store, { sleeperId: 'nope', message: 'Hi' }, { ai: true }))).rejects.toThrow('Sleeper not found');
  });
});

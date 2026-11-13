import { describe, expect, it } from 'vitest';
import { answerQuestion, classifyQuestion, createModel, estimateIdeal, observePreference, zonedTimeToMs, type AssistantContext, type AssistantTopic } from '../src/index';

const TZ = 'America/Toronto';
const at = (date: string, time: string): number => zonedTimeToMs(date, time, TZ);

function context(over: Partial<AssistantContext> = {}): AssistantContext {
  let model = createModel();
  for (let i = 0; i < 10; i++) model = observePreference(model, { kind: 'override', tempC: 19, phase: 'deep', seasonIndex: 0 });
  return {
    estimate: estimateIdeal(model, 0),
    insights: [],
    season: 'winter',
    options: { explore: true, cycleTracking: false, menopauseMode: false, recoveryAware: true },
    wearable: { name: 'Oura Ring', delivery: 'morning' },
    tonight: {
      timeZone: TZ,
      steps: [
        { phase: 'windDown', startMs: at('2026-11-13', '22:00'), endMs: at('2026-11-13', '22:45'), targetC: 19.5 },
        { phase: 'onset', startMs: at('2026-11-13', '22:45'), endMs: at('2026-11-14', '00:00'), targetC: 19.5 },
        { phase: 'deep', startMs: at('2026-11-14', '00:00'), endMs: at('2026-11-14', '03:00'), targetC: 18.5 },
        { phase: 'rem', startMs: at('2026-11-14', '03:00'), endMs: at('2026-11-14', '06:00'), targetC: 19.5 },
        { phase: 'wake', startMs: at('2026-11-14', '06:00'), endMs: at('2026-11-14', '07:00'), targetC: 21 },
      ],
      modifiers: [],
      explorationC: 0,
      presetName: null,
      holdC: null,
      energyChanges: [],
      partners: 0,
      gapC: 0,
      humidityPct: null,
    },
    lastNight: { experiencedCoreC: 19.2, quality: 81.4, liveAdjustments: 0, manualChanges: 0 },
    savings: null,
    ...over,
  };
}

describe('understanding the question', () => {
  const cases: [string, AssistantTopic][] = [
    ['What is my ideal temperature?', 'ideal'],
    ['Quelle est ma température idéale ?', 'ideal'],
    ["What's the plan tonight?", 'tonight'],
    ['Pourquoi fait-il plus frais ce soir ?', 'tonight'],
    ['How did I sleep last night?', 'lastNight'],
    ["Comment j'ai dormi la nuit dernière ?", 'lastNight'],
    ['Am I getting better?', 'trend'],
    ['How long does calibration take?', 'learning'],
    ['Comment ça marche ?', 'learning'],
    ['How does it work?', 'learning'],
    ['How does it work with my partner?', 'partner'],
    ['Et pour mon conjoint ?', 'partner'],
    ['What do you recommend?', 'recommendation'],
    ['Que recommandez-vous ?', 'recommendation'],
    ['How much money did I save on my bill?', 'savings'],
    ["Combien d'énergie ai-je économisée ?", 'savings'],
    ['What changes in winter?', 'season'],
    ['Can I use a preset or change the temperature myself?', 'control'],
    ['Does my watch sync live?', 'wearable'],
    ["I'm too hot at night", 'tooHot'],
    ["J'ai trop froid la nuit", 'tooCold'],
    ['Is humidity taken into account?', 'humidity'],
    ['What does menopause mode do?', 'health'],
    ['I had wine and a hard workout', 'recovery'],
    ['What about jet lag when I travel?', 'travel'],
    ['Who can see my data?', 'privacy'],
    ['Do I have sleep apnea?', 'medical'],
    ['Bonjour', 'help'],
    ['Who won the hockey game?', 'unknown'],
    ['', 'unknown'],
  ];
  it.each(cases)('%s -> %s', (question, topic) => {
    expect(classifyQuestion(question)).toBe(topic);
  });
});

describe('answering', () => {
  it('states the ideal temperature with its uncertainty, in the asked language and units', () => {
    const en = answerQuestion('What is my ideal temperature?', context(), { locale: 'en', units: 'C' });
    expect(en.text).toContain('19 °C');
    expect(en.text).toContain('give or take');
    const fr = answerQuestion('What is my ideal temperature?', context(), { locale: 'fr', units: 'F' });
    expect(fr.text).toContain('66 °F');
    expect(fr.text).toContain('température idéale');
  });

  it('lays out tonight phase by phase with the reasons behind it', () => {
    const ctx = context();
    ctx.tonight!.modifiers = [{ id: 'humidity', deltaC: -0.5, phases: ['deep'] }];
    ctx.tonight!.explorationC = 0.5;
    ctx.tonight!.partners = 1;
    ctx.tonight!.gapC = 2;
    const reply = answerQuestion("What's the plan tonight?", ctx, { locale: 'en', units: 'C' });
    expect(reply.text).toContain('19.5 °C for falling asleep (from 22:45)');
    expect(reply.text).toContain('18.5 °C for deep sleep (from 00:00)');
    expect(reply.text).toContain('21 °C for waking up');
    expect(reply.text).toContain('because the air is humid');
    expect(reply.text).toContain('while calibrating');
    expect(reply.text).toContain('differ by 2 °C');
  });

  it('says when a preset or a manual temperature is in charge', () => {
    const preset = context();
    preset.tonight!.presetName = 'Cozy 21';
    expect(answerQuestion("tonight's plan", preset, { locale: 'en', units: 'C' }).text).toContain('following your preset "Cozy 21"');
    expect(answerQuestion('What do you recommend?', preset, { locale: 'en', units: 'C' }).text).toContain('We recommend the automatic setting instead');
    const held = context();
    held.tonight!.holdC = 22;
    expect(answerQuestion("tonight's plan", held, { locale: 'en', units: 'C' }).text).toContain('manual temperature of 22 °C');
    expect(answerQuestion('What do you recommend?', context(), { locale: 'en', units: 'C' }).text).toContain('already on the recommended setting');
  });

  it('reports last night against the estimate, or says there is none', () => {
    const reply = answerQuestion('How did I sleep last night?', context(), { locale: 'en', units: 'C' });
    expect(reply.text).toContain('81 out of 100');
    expect(reply.text).toContain('right at your estimated ideal');
    expect(answerQuestion('How did I sleep last night?', context({ lastNight: null }), { locale: 'en', units: 'C' }).text).toContain('no recorded night');
  });

  it('explains live and morning wearables differently', () => {
    expect(answerQuestion('Is my ring live?', context(), { locale: 'en', units: 'C' }).text).toContain('cannot react during the night');
    const live = context({ wearable: { name: 'Apple Watch', delivery: 'live' } });
    expect(answerQuestion('Is my watch live?', live, { locale: 'en', units: 'C' }).text).toContain('adjusted by half a degree there and then');
  });

  it('only mentions humidity readings when the thermostat reports them', () => {
    expect(answerQuestion('What about humidity?', context(), { locale: 'en', units: 'C' }).text).toContain('does not measure humidity');
    const ctx = context();
    ctx.tonight!.humidityPct = 63;
    expect(answerQuestion('What about humidity?', ctx, { locale: 'en', units: 'C' }).text).toContain('63% humidity');
  });

  it('uses computed insights where they exist', () => {
    const ctx = context({ insights: [{ id: 'energy', savedKWh: 12.4, savedCents: 310, nights: 20 }] });
    expect(answerQuestion('How much have I saved?', ctx, { locale: 'en', units: 'C' }).text).toContain('12.4 kWh less');
    expect(answerQuestion('How much have I saved?', context(), { locale: 'en', units: 'C' }).text).toContain('not enough nights yet');
  });

  it('never gives medical advice, and offers a way forward when it does not understand', () => {
    expect(answerQuestion('Should I take melatonin?', context(), { locale: 'fr', units: 'C' }).text).toContain("Je ne peux pas donner d'avis médical");
    const lost = answerQuestion('asdf qwerty', context(), { locale: 'en', units: 'C' });
    expect(lost.topic).toBe('unknown');
    expect(lost.followUps).toHaveLength(3);
  });

  it('answers every topic in both languages without a plan to lean on', () => {
    const questions = ['ideal temperature', 'tonight', 'last night', 'trend', 'calibration', 'recommend', 'savings', 'partner', 'winter', 'preset', 'watch', 'too hot', 'too cold', 'humidity', 'menopause', 'workout', 'jet lag', 'privacy', 'insomnia', 'hello', 'zzz'];
    for (const locale of ['en', 'fr'] as const) {
      for (const q of questions) {
        const reply = answerQuestion(q, context({ tonight: null, lastNight: null }), { locale, units: 'C' });
        expect(reply.text.length).toBeGreaterThan(20);
        expect(reply.text).not.toContain('undefined');
        expect(reply.text).not.toContain('NaN');
      }
    }
  });
});

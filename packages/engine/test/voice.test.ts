import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from '../src/voice/parse';
import { formatVoiceReply } from '../src/voice/replies';
import type { Locale, Units } from '../src/types';
import type { VoiceIntent, VoiceOutcome, VoiceParseOptions } from '../src/voice/types';

const EN_C: VoiceParseOptions = { locale: 'en', units: 'C' };
const EN_F: VoiceParseOptions = { locale: 'en', units: 'F' };
const FR_C: VoiceParseOptions = { locale: 'fr', units: 'C' };

const intentOf = (text: string, opts: VoiceParseOptions = EN_C): VoiceIntent => parseVoiceCommand(text, opts).intent;

type Case = [text: string, expected: VoiceIntent];

function runTable(name: string, cases: Case[], opts: VoiceParseOptions): void {
  describe(name, () => {
    it.each(cases)('%s', (text, expected) => {
      const parsed = parseVoiceCommand(text, opts);
      expect(parsed.intent).toEqual(expected);
      expect(parsed.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });
}

const set = (valueC: number): VoiceIntent => ({ type: 'setTemperature', valueC });
const adjust = (deltaC: number): VoiceIntent => ({ type: 'adjust', deltaC });
const hot = (deltaC = -1): VoiceIntent => ({ type: 'adjust', deltaC, feeling: 'tooHot' });
const cold = (deltaC = 1): VoiceIntent => ({ type: 'adjust', deltaC, feeling: 'tooCold' });
const nap = (minutes: number): VoiceIntent => ({ type: 'startNap', minutes });
const RESUME: VoiceIntent = { type: 'resumeAuto' };
const STATUS: VoiceIntent = { type: 'status' };
const NIGHT: VoiceIntent = { type: 'goodNight' };
const MORNING: VoiceIntent = { type: 'goodMorning' };
const UNKNOWN: VoiceIntent = { type: 'unknown' };

runTable('English setTemperature', [
  ['Set it to 19', set(19)],
  ['make it 20 degrees', set(20)],
  ['Bedroom to 68', set(20)],
  ['set the temperature to 19.5', set(19.5)],
  ['set it to 19 and a half', set(19.5)],
  ['set it to nineteen', set(19)],
  ['set the bedroom to twenty one degrees', set(21)],
  ['set it to sixty-eight', set(20)],
  ['Set it to 68 F', set(20)],
  ['set it to 68 fahrenheit', set(20)],
  ['set it to 20 celsius', set(20)],
  ['make it 21°', set(21)],
  ['Hey Siri, please set the thermostat to 18.', set(18)],
  ['turn it up to 22', set(22)],
  ['lower the temperature to 17', set(17)],
  ['set it to nineteen point five', set(19.5)],
], EN_C);

runTable('French setTemperature', [
  ['Mets à 19', set(19)],
  ['règle la chambre à 20 degrés', set(20)],
  ['température à 19', set(19)],
  ['mets la chambre à 19,5', set(19.5)],
  ['mets à 19 et demi', set(19.5)],
  ['mets la température à dix-neuf', set(19)],
  ['règle à vingt et un degrés', set(21)],
  ['mets à vingt-deux', set(22)],
  ['mets à vingt-trois et demi', set(23.5)],
  ['Peux-tu mettre la chambre à 20 °C, s’il te plaît?', set(20)],
  ['baisse à 18', set(18)],
  ['monte à 21', set(21)],
  ['regle a 20 degres', set(20)],
  ['mets à soixante-huit fahrenheit', set(20)],
], FR_C);

runTable('English adjust', [
  ['warmer', adjust(1)],
  ['Make it cooler', adjust(-1)],
  ['a bit warmer please', adjust(0.5)],
  ['a little cooler', adjust(-0.5)],
  ['slightly warmer', adjust(0.5)],
  ['much colder', adjust(-2)],
  ['a lot warmer', adjust(2)],
  ['way cooler', adjust(-2)],
  ['2 degrees warmer', adjust(2)],
  ['turn it down 3 degrees', adjust(-3)],
  ['turn it up', adjust(1)],
  ['turn it up a degree', adjust(1)],
  ['half a degree cooler', adjust(-0.5)],
  ['warmer by 3 fahrenheit', adjust(1.5)],
  ['increase the temperature', adjust(1)],
  ['can you make it hotter', adjust(1)],
], EN_C);

runTable('French adjust', [
  ['plus chaud', adjust(1)],
  ['plus frais', adjust(-1)],
  ['un peu plus chaud', adjust(0.5)],
  ['légèrement plus froid', adjust(-0.5)],
  ['beaucoup plus chaud', adjust(2)],
  ['bien plus frais', adjust(-2)],
  ['baisse de 2 degrés', adjust(-2)],
  ["monte d'un degré", adjust(1)],
  ['monte d’un degré', adjust(1)],
  ['augmente un peu', adjust(0.5)],
  ['réchauffe la chambre', adjust(1)],
  ['refroidis la chambre', adjust(-1)],
  ['diminue de un degré et demi', adjust(-1.5)],
  ['baisse la température, s’il vous plaît', adjust(-1)],
], FR_C);

runTable('English feelings', [
  ["I'm hot", hot()],
  ['I’m too hot', hot()],
  ["it's too warm", hot()],
  ["I'm boiling", hot()],
  ["I'm sweating", hot()],
  ["I'm a bit hot", hot(-0.5)],
  ["I'm cold", cold()],
  ["I'm freezing", cold()],
  ["it's too cold", cold()],
  ["I'm a little cold", cold(0.5)],
  ["I'm really cold", cold()],
  ['im cold', cold()],
], EN_C);

runTable('French feelings', [
  ["j'ai chaud", hot()],
  ["j'ai trop chaud", hot()],
  ['il fait trop chaud', hot()],
  ['je crève de chaleur', hot()],
  ['J’ai un peu chaud', hot(-0.5)],
  ["j'ai froid", cold()],
  ["j'ai trop froid", cold()],
  ['il fait frette', cold()],
  ['je gèle', cold()],
  ["j'ai un peu froid", cold(0.5)],
], FR_C);

runTable('English startNap', [
  ['start a nap', nap(20)],
  ['nap for 20 minutes', nap(20)],
  ['power nap', nap(20)],
  ['20 minute nap', nap(20)],
  ['an hour nap', nap(60)],
  ['nap for 1 hour', nap(60)],
  ['nap for half an hour', nap(30)],
  ['nap for an hour and a half', nap(90)],
  ['nap for 45 minutes', nap(45)],
  ['nap for 1 hour and 15 minutes', nap(75)],
  ['nap for 5 minutes', nap(10)],
  ['nap for 5 hours', nap(180)],
], EN_C);

runTable('French startNap', [
  ['sieste', nap(20)],
  ['sieste de 45 minutes', nap(45)],
  ["je fais une sieste d'une heure", nap(60)],
  ['une sieste d’une demi-heure', nap(30)],
  ['sieste de 1h30', nap(90)],
  ['sieste d’une heure et demie', nap(90)],
  ['sieste de vingt minutes', nap(20)],
  ['sieste de deux heures', nap(120)],
], FR_C);

runTable('English resumeAuto', [
  ['resume', RESUME],
  ['resume schedule', RESUME],
  ['back to automatic', RESUME],
  ['auto mode', RESUME],
  ['cancel the hold', RESUME],
  ['cancel override', RESUME],
  ['cancel the nap', RESUME],
], EN_C);

runTable('French resumeAuto', [
  ['reprends le mode automatique', RESUME],
  ['retour au mode auto', RESUME],
  ['annule', RESUME],
  ['mode automatique', RESUME],
  ['arrête la sieste', RESUME],
], FR_C);

runTable('English status', [
  ["what's the temperature", STATUS],
  ['What is the temperature?', STATUS],
  ['how warm is it', STATUS],
  ['what is it set to', STATUS],
  ['status', STATUS],
], EN_C);

runTable('French status', [
  ['quelle est la température', STATUS],
  ['Quelle est la température?', STATUS],
  ['il fait combien', STATUS],
  ["c'est réglé à combien", STATUS],
  ['quelle température fait-il', STATUS],
], FR_C);

runTable('English goodNight and goodMorning', [
  ['good night', NIGHT],
  ['Goodnight!', NIGHT],
  ["I'm going to bed", NIGHT],
  ['bedtime', NIGHT],
  ['start sleep', NIGHT],
  ['good morning', MORNING],
  ["I'm awake", MORNING],
  ["I'm up", MORNING],
  ['stop sleep', MORNING],
], EN_C);

runTable('French goodNight and goodMorning', [
  ['bonne nuit', NIGHT],
  ['je vais me coucher', NIGHT],
  ['je vais au lit', NIGHT],
  ['dodo', NIGHT],
  ['je monte me coucher', NIGHT],
  ['bonjour', MORNING],
  ['bon matin', MORNING],
  ['je suis réveillé', MORNING],
  ['je suis reveillee', MORNING],
  ['je suis debout', MORNING],
  ['je me lève', MORNING],
], FR_C);

describe('unknown and off-topic phrases', () => {
  it.each([
    "what's the weather tomorrow",
    'play some music',
    'set an alarm for 7',
    'turn on the lights',
    "what's up",
    'tell me a joke',
    'what time is it',
    'quelle météo demain',
    'joue de la musique',
    '',
    '   ',
    '?!',
    'please',
    'call mom at 5',
  ])('%j is unknown with zero confidence', (text) => {
    expect(parseVoiceCommand(text, EN_C)).toEqual({ intent: UNKNOWN, confidence: 0 });
    expect(parseVoiceCommand(text, FR_C)).toEqual({ intent: UNKNOWN, confidence: 0 });
  });

  it('does not crash on negations', () => {
    expect(() => parseVoiceCommand('not too cold', EN_C)).not.toThrow();
    expect(() => parseVoiceCommand('pas trop chaud', FR_C)).not.toThrow();
  });
});

describe('temperature units', () => {
  it('reads a bare number in the user units', () => {
    expect(intentOf('set it to 19', EN_C)).toEqual(set(19));
    expect(intentOf('set it to 68', EN_F)).toEqual(set(20));
    expect(intentOf('set it to 67', EN_F)).toEqual(set(19.5)); // 19.44 rounds to 19.5
  });

  it('reads 45 and above as Fahrenheit for a Celsius user', () => {
    expect(intentOf('set it to 45', EN_C)).toEqual(set(7)); // 7.2 C
    expect(intentOf('set it to 44', EN_C)).toEqual(set(44));
  });

  it('reads under 40 as Celsius for a Fahrenheit user', () => {
    expect(intentOf('set it to 19', EN_F)).toEqual(set(19));
    expect(intentOf('set it to 39', EN_F)).toEqual(set(39));
    expect(intentOf('set it to 40', EN_F)).toEqual(set(4.5)); // 4.4 C
  });

  it('lets an explicit unit win', () => {
    expect(intentOf('set it to 20 celsius', EN_F)).toEqual(set(20));
    expect(intentOf('set it to 70 fahrenheit', EN_C)).toEqual(set(21));
    expect(intentOf('set it to 68°F', EN_C)).toEqual(set(20));
    expect(intentOf('set it to 20°C', EN_F)).toEqual(set(20));
    expect(intentOf('set it to 68F', EN_C)).toEqual(set(20));
  });

  it('accepts a decimal comma and a decimal point', () => {
    expect(intentOf('mets à 19,5', FR_C)).toEqual(set(19.5));
    expect(intentOf('set it to 19.5', EN_C)).toEqual(set(19.5));
    expect(intentOf('mets à dix-neuf virgule cinq', FR_C)).toEqual(set(19.5));
  });

  it('rounds to the nearest half degree', () => {
    expect(intentOf('set it to 19.2', EN_C)).toEqual(set(19));
    expect(intentOf('set it to 19.3', EN_C)).toEqual(set(19.5));
    expect(intentOf('set it to 72', EN_C)).toEqual(set(22)); // 22.2 C
  });

  it('converts a relative Fahrenheit amount as a difference, not with fToC', () => {
    expect(intentOf('2 degrees warmer', EN_F)).toEqual(adjust(1)); // 1.1 C
    expect(intentOf('4 degrees cooler', EN_F)).toEqual(adjust(-2)); // 2.2 C
    expect(intentOf('1 degree warmer', EN_F)).toEqual(adjust(0.5)); // 0.56 C
    expect(intentOf('2 degrees warmer', EN_C)).toEqual(adjust(2));
  });

  it('never returns a zero adjustment', () => {
    expect(intentOf('warmer by 0.1 degrees', EN_C)).toEqual(adjust(0.5));
    expect(intentOf('cooler by 0.2 degrees', EN_C)).toEqual(adjust(-0.5));
  });

  it('gives a bare number moderate confidence and a full sentence high confidence', () => {
    expect(parseVoiceCommand('19', EN_C)).toEqual({ intent: set(19), confidence: 0.6 });
    expect(parseVoiceCommand('dix-neuf', FR_C)).toEqual({ intent: set(19), confidence: 0.6 });
    expect(parseVoiceCommand('set it to 19', EN_C).confidence).toBe(0.9);
    expect(parseVoiceCommand('19 degrees', EN_C).confidence).toBe(0.9);
  });

  it('does not read durations or unrelated numbers as temperatures', () => {
    expect(intentOf('19 minutes', EN_C)).toEqual(UNKNOWN);
  });
});

describe('number words', () => {
  it.each<[string, number]>([
    ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
    ['twenty one', 21], ['twenty-two', 22], ['twenty five', 25], ['thirty', 30],
    ['quinze', 15], ['seize', 16], ['dix-sept', 17], ['dix-huit', 18], ['dix-neuf', 19], ['vingt', 20],
    ['vingt et un', 21], ['vingt-deux', 22], ['vingt-cinq', 25], ['vingt-neuf', 29], ['trente', 30],
  ])('Celsius: %s', (words, value) => {
    expect(intentOf(`set it to ${words}`, EN_C)).toEqual(set(value));
    expect(intentOf(`mets à ${words}`, FR_C)).toEqual(set(value));
  });

  it.each<[string, number]>([
    ['sixty', 60], ['sixty-two', 62], ['sixty-eight', 68], ['seventy', 70], ['seventy-two', 72], ['eighty', 80],
    ['soixante', 60], ['soixante-huit', 68], ['soixante-dix', 70], ['soixante et onze', 71],
    ['soixante-douze', 72], ['soixante-dix-huit', 78], ['quatre-vingts', 80], ['quatre-vingt', 80],
  ])('Fahrenheit: %s', (words, value) => {
    expect(intentOf(`set it to ${words}`, EN_F)).toEqual(set(Math.round(((value - 32) * 5) / 9 * 2) / 2));
  });

  it('handles halves in words', () => {
    expect(intentOf('set it to nineteen and a half', EN_C)).toEqual(set(19.5));
    expect(intentOf('mets à dix-neuf et demi', FR_C)).toEqual(set(19.5));
    expect(intentOf('mets à vingt et demi', FR_C)).toEqual(set(20.5));
  });
});

describe('language fallback', () => {
  it('understands French in an English locale and English in a French locale', () => {
    expect(intentOf('bonne nuit', EN_C)).toEqual(NIGHT);
    expect(intentOf("j'ai froid", EN_C)).toEqual(cold());
    expect(intentOf('good morning', FR_C)).toEqual(MORNING);
    expect(intentOf('a bit warmer', FR_C)).toEqual(adjust(0.5));
  });

  it('handles mixed-language phrases', () => {
    expect(intentOf('set it to dix-neuf', EN_C)).toEqual(set(19));
    expect(intentOf('mets à twenty', FR_C)).toEqual(set(20));
  });

  it('tolerates missing accents and apostrophe variants', () => {
    expect(intentOf('je suis reveille', FR_C)).toEqual(MORNING);
    expect(intentOf('je suis réveillé', FR_C)).toEqual(MORNING);
    expect(intentOf('J’AI CHAUD', FR_C)).toEqual(hot());
    expect(intentOf('quelle est la temperature', FR_C)).toEqual(STATUS);
  });
});

describe('presets', () => {
  const presetNames = ['Movie night', 'Night', 'Hiver', 'Été chaud', 'Good night'] as const;
  const withPresets = (locale: Locale = 'en'): VoiceParseOptions => ({ locale, units: 'C', presetNames });
  const preset = (name: string): VoiceIntent => ({ type: 'activatePreset', name });

  it.each<[string, string, Locale]>([
    ['start movie night', 'Movie night', 'en'],
    ['activate the movie night preset', 'Movie night', 'en'],
    ['MOVIE NIGHT', 'Movie night', 'en'],
    ['movie night mode', 'Movie night', 'en'],
    ['night preset', 'Night', 'en'],
    ['active le préréglage hiver', 'Hiver', 'fr'],
    ['lance hiver', 'Hiver', 'fr'],
    ['mode ete chaud', 'Été chaud', 'fr'],
    ['préréglage été chaud', 'Été chaud', 'fr'],
  ])('%s -> %s', (text, name, locale) => {
    expect(parseVoiceCommand(text, withPresets(locale))).toEqual({ intent: preset(name), confidence: 0.9 });
  });

  it('prefers the longest matching name', () => {
    expect(intentOf('movie night', withPresets())).toEqual(preset('Movie night'));
  });

  it('gives lower confidence when the name is surrounded by unrecognised words', () => {
    expect(parseVoiceCommand('I would like movie night now', withPresets())).toEqual({
      intent: preset('Movie night'),
      confidence: 0.75,
    });
  });

  it('lets goodNight win unless a preset is asked for explicitly', () => {
    expect(intentOf('good night', withPresets())).toEqual(NIGHT);
    expect(intentOf('activate good night', withPresets())).toEqual(preset('Good night'));
    expect(intentOf('good night preset', withPresets())).toEqual(preset('Good night'));
  });

  it('returns unknown with low confidence for an unknown preset that was asked for', () => {
    expect(parseVoiceCommand('activate preset foo', withPresets())).toEqual({ intent: UNKNOWN, confidence: 0.3 });
    expect(parseVoiceCommand('active le préréglage printemps', withPresets('fr'))).toEqual({
      intent: UNKNOWN,
      confidence: 0.3,
    });
    expect(parseVoiceCommand('activate preset foo', EN_C)).toEqual({ intent: UNKNOWN, confidence: 0.3 });
  });

  it('keeps built-in intents when presets exist', () => {
    expect(intentOf('set it to 19', withPresets())).toEqual(set(19));
    expect(intentOf('auto mode', withPresets())).toEqual(RESUME);
  });
});

describe('formatVoiceReply', () => {
  const NB = ' ';
  const reply = (outcome: VoiceOutcome, locale: Locale, units: Units = 'C'): string =>
    formatVoiceReply(outcome, { locale, units });

  it.each<[VoiceOutcome, string, string]>([
    [
      { type: 'held', targetC: 19.5, untilMorning: true },
      'OK, holding at 19.5 °C until morning.',
      `D'accord, je maintiens 19,5${NB}°C jusqu'au matin.`,
    ],
    [
      { type: 'held', targetC: 20, untilMorning: false, minutes: 90 },
      'OK, holding at 20 °C for an hour and 30 minutes.',
      `D'accord, je maintiens 20${NB}°C pendant une heure 30.`,
    ],
    [
      { type: 'held', targetC: 20, untilMorning: false },
      'OK, holding at 20 °C.',
      `D'accord, je maintiens 20${NB}°C.`,
    ],
    [
      { type: 'adjusted', targetC: 20, deltaC: 1 },
      'OK, raising it by 1 degree to 20 °C.',
      `D'accord, je monte la température d'un degré, à 20${NB}°C.`,
    ],
    [
      { type: 'adjusted', targetC: 18.5, deltaC: -0.5 },
      'OK, lowering it by half a degree to 18.5 °C.',
      `D'accord, je baisse la température d'un demi-degré, à 18,5${NB}°C.`,
    ],
    [
      { type: 'adjusted', targetC: 17, deltaC: -2 },
      'OK, lowering it by 2 degrees to 17 °C.',
      `D'accord, je baisse la température de 2 degrés, à 17${NB}°C.`,
    ],
    [
      { type: 'adjusted', targetC: 25, deltaC: 0 },
      'It stays at 25 °C.',
      `La température reste à 25${NB}°C.`,
    ],
    [
      { type: 'presetActivated', name: 'Movie night' },
      'OK, switching to your Movie night preset.',
      "D'accord, le préréglage Movie night est activé.",
    ],
    [{ type: 'presetNotFound' }, "Sorry, I couldn't find a preset with that name.", 'Aucun préréglage ne porte ce nom.'],
    [
      { type: 'napStarted', minutes: 20, targetC: 21 },
      'OK, starting a nap for 20 minutes at 21 °C.',
      `D'accord, je lance une sieste de 20 minutes à 21${NB}°C.`,
    ],
    [
      { type: 'napStarted', minutes: 60, targetC: 21 },
      'OK, starting a nap for an hour at 21 °C.',
      `D'accord, je lance une sieste d'une heure à 21${NB}°C.`,
    ],
    [{ type: 'resumed' }, 'OK, back to your automatic schedule.', "D'accord, je reprends l'horaire automatique."],
    [
      { type: 'status', roomTempC: 21.04, targetC: 19, mode: 'auto' },
      "It's 21 °C in the room, and your schedule is aiming for 19 °C.",
      `Il fait 21${NB}°C dans la chambre, et votre horaire vise 19${NB}°C.`,
    ],
    [
      { type: 'status', roomTempC: 20.5, targetC: 19.5, mode: 'hold' },
      "It's 20.5 °C in the room, held at 19.5 °C.",
      `Il fait 20,5${NB}°C dans la chambre, et la consigne est maintenue à 19,5${NB}°C.`,
    ],
    [
      { type: 'status', roomTempC: 20, targetC: 18, mode: 'preset' },
      "It's 20 °C in the room, and your preset is aiming for 18 °C.",
      `Il fait 20${NB}°C dans la chambre, et votre préréglage vise 18${NB}°C.`,
    ],
    [
      { type: 'status', roomTempC: 22, targetC: null, mode: 'idle' },
      "It's 22 °C in the room, and nothing is running right now.",
      `Il fait 22${NB}°C dans la chambre, et aucun réglage n'est en cours.`,
    ],
    [
      { type: 'status', roomTempC: 22, targetC: 21, mode: 'idle' },
      "It's 22 °C in the room, with a target of 21 °C.",
      `Il fait 22${NB}°C dans la chambre, et la consigne est de 21${NB}°C.`,
    ],
    [
      { type: 'nightStarted', targetC: 18.5 },
      'Good night, setting the room to 18.5 °C for the night.',
      `Bonne nuit, je règle la chambre à 18,5${NB}°C pour la nuit.`,
    ],
    [
      { type: 'nightEnded' },
      'Good morning, the room is back on your usual settings.',
      'Bonjour, la chambre revient à vos réglages habituels.',
    ],
    [
      { type: 'outOfRange', minC: 15.5, maxC: 25 },
      'I can only set the temperature between 15.5 °C and 25 °C.',
      `Je ne peux régler la température qu'entre 15,5${NB}°C et 25${NB}°C.`,
    ],
    [
      { type: 'notUnderstood' },
      "Sorry, I didn't catch that; you can say warmer, cooler, or a temperature.",
      "Pardon, je n'ai pas compris; vous pouvez dire plus chaud, plus frais ou une température.",
    ],
  ])('%o', (outcome, en, fr) => {
    expect(reply(outcome, 'en')).toBe(en);
    expect(reply(outcome, 'fr')).toBe(fr);
  });

  it('shows Fahrenheit as whole numbers and converts differences with 9/5', () => {
    expect(reply({ type: 'adjusted', targetC: 20, deltaC: 1 }, 'en', 'F')).toBe('OK, raising it by 2 degrees to 68 °F.');
    expect(reply({ type: 'adjusted', targetC: 19.5, deltaC: -0.5 }, 'en', 'F')).toBe(
      'OK, lowering it by 1 degree to 67 °F.',
    );
    expect(reply({ type: 'adjusted', targetC: 20, deltaC: 1 }, 'fr', 'F')).toBe(
      `D'accord, je monte la température de 2 degrés, à 68${NB}°F.`,
    );
    expect(reply({ type: 'outOfRange', minC: 15.5, maxC: 25 }, 'en', 'F')).toBe(
      'I can only set the temperature between 60 °F and 77 °F.',
    );
  });

  it('rounds Celsius to one decimal without a trailing zero', () => {
    expect(reply({ type: 'nightStarted', targetC: 19.04 }, 'en')).toBe('Good night, setting the room to 19 °C for the night.');
    expect(reply({ type: 'nightStarted', targetC: 18.25 }, 'fr')).toContain(`18,3${NB}°C`);
    expect(reply({ type: 'adjusted', targetC: 21.5, deltaC: 1.5 }, 'fr')).toBe(
      `D'accord, je monte la température de 1,5 degré, à 21,5${NB}°C.`,
    );
  });

  it('never uses markdown, emoji or line breaks', () => {
    const outcomes: VoiceOutcome[] = [
      { type: 'resumed' },
      { type: 'manualControlOff' },
      { type: 'feedbackNoted' },
      { type: 'notUnderstood' },
      { type: 'status', roomTempC: 21, targetC: 19, mode: 'auto' },
    ];
    for (const outcome of outcomes) {
      for (const locale of ['en', 'fr'] as const) {
        expect(reply(outcome, locale)).toMatch(/^[^*_#\n`\u{1F300}-\u{1FAFF}]+$/u);
      }
    }
  });
});

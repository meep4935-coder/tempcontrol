import type { Locale, Units } from '../types';
import { clamp, fToC, roundTo } from '../util';
import type { VoiceIntent, VoiceParseOptions, VoiceParseResult } from './types';

/*
 * Voice command parser: speech-to-text output in, structured intent out.
 *
 * Phrase tables come first so anyone can add a phrase. Write phrases the way people say them,
 * with accents and apostrophes: every phrase goes through the same normalisation as the input
 * (lowercase, accents stripped, "I'm" -> "i am", "j'ai" -> "je ai", hyphens -> spaces), and a
 * phrase matches only on whole words ("up" does not match "upstairs").
 *
 * Decision order, inside each language:
 *   status, resumeAuto, startNap, a temperature with a number (set or relative amount),
 *   goodNight, goodMorning, feelings ("I'm cold"), then plain "warmer"/"cooler".
 * The user's locale is tried first, then the other language; the more confident result wins
 * (the user's locale wins ties), so bilingual households can mix languages.
 *
 * Presets: if a preset name appears in the phrase together with an explicit preset word
 * ("preset", "mode", "activate", "préréglage"...), the preset wins. Otherwise built-in intents
 * win, and a bare preset name is used only when nothing else matched. So with a preset called
 * "Good night", "good night" starts the night and "activate good night" starts the preset.
 *
 * Confidence: 0.9 clear match; 0.75 preset name found among other unrecognised words;
 * 0.6 bare number ("19"); 0.3 unknown although a preset was explicitly asked for;
 * 0 anything else.
 */

interface LanguagePhrases {
  status: string[];
  resumeAuto: string[];
  nap: string[];
  goodNight: string[];
  goodMorning: string[];
  tooHot: string[];
  tooCold: string[];
  warmer: string[];
  cooler: string[];
  /** "a bit warmer": half a degree. Also stripped before matching feelings ("I'm a bit cold"). */
  smallStep: string[];
  /** "much warmer": two degrees. */
  bigStep: string[];
  /** Stripped before matching feelings so "I'm really cold" still reads as "I'm cold". */
  intensifiers: string[];
  /** Words that show a number is a temperature request ("set it to 19", "mets à 19"). */
  setContext: string[];
}

const PHRASES: Record<Locale, LanguagePhrases> = {
  en: {
    status: [
      "what's the temperature", 'what temperature is it', "what's the room temperature", 'what the temperature is',
      'how warm is it', 'how cold is it', 'how hot is it', "what's it set to", "what's the thermostat set to",
      'what are you set to', "what's the target", 'status', 'current temperature', 'tell me the temperature',
    ],
    resumeAuto: [
      'resume', 'back to automatic', 'back to auto', 'back to the schedule', 'back to normal', 'auto mode',
      'automatic mode', 'cancel', 'stop the hold', 'end the hold', 'release the hold', 'remove the hold',
      'follow the schedule', 'stop the nap', 'end the nap',
    ],
    nap: ['nap', 'naps', 'napping', 'siesta'],
    goodNight: [
      'good night', 'goodnight', 'night night', 'going to bed', 'off to bed', 'time for bed', 'bedtime', 'bed time',
      'start sleep', 'start sleeping', 'going to sleep', 'time to sleep', 'sleep mode',
    ],
    goodMorning: [
      'good morning', "i'm awake", "i'm up", "i'm getting up", 'getting up', 'woke up', 'stop sleep', 'end sleep',
      'rise and shine',
    ],
    tooHot: [
      "i'm hot", "i'm warm", 'too hot', 'too warm', "it's hot", 'boiling', 'sweating', 'roasting', 'burning up',
      'stuffy',
    ],
    tooCold: ["i'm cold", 'too cold', 'too cool', "it's cold", 'freezing', 'chilly', 'shivering'],
    warmer: ['warmer', 'hotter', 'up', 'raise', 'increase', 'higher', 'more heat'],
    cooler: ['cooler', 'colder', 'down', 'lower', 'decrease', 'reduce', 'less heat', 'chill'],
    smallStep: ['a bit', 'a little', 'a little bit', 'slightly', 'a touch', 'a tad', 'kind of', 'kinda', 'sort of'],
    bigStep: ['much', 'a lot', 'lots', 'way'],
    intensifiers: ['very', 'really', 'so', 'super'],
    setContext: [
      'set', 'make it', 'turn it', 'put it', 'keep it', 'change it', 'bring it', 'temperature', 'temp',
      'thermostat', 'heat', 'heating', 'room', 'bedroom',
    ],
  },
  fr: {
    status: [
      'quelle est la température', 'quelle température fait-il', 'quelle température il fait', 'il fait combien',
      "c'est réglé à combien", "c'est à combien", "à combien c'est réglé", 'combien de degrés', 'statut', 'état',
      'température actuelle', 'quelle est la consigne',
    ],
    resumeAuto: [
      'reprends', 'reprendre', 'reprenez', 'mode automatique', 'mode auto', "retour à l'automatique",
      "retour à l'horaire", "reviens à l'horaire", 'annule', 'annuler', 'annulez', 'arrête la sieste',
      'fin de la sieste',
    ],
    nap: ['sieste', 'roupillon', 'petit somme'],
    goodNight: [
      'bonne nuit', 'je vais me coucher', 'je vais au lit', 'je me couche', 'au lit', 'dodo', 'je vais dormir',
      'on va se coucher', 'on va dormir', 'mode nuit', 'je monte me coucher',
    ],
    goodMorning: [
      'bonjour', 'bon matin', 'je suis réveillé', 'je suis réveillée', 'je suis debout', 'je me lève',
      'je me réveille', 'je suis levé', 'je suis levée',
    ],
    tooHot: [
      "j'ai chaud", 'trop chaud', 'il fait chaud', 'je crève de chaleur', 'on crève', 'je meurs de chaleur',
      'on étouffe', 'je cuis', 'on cuit', 'je transpire', 'je sue',
    ],
    tooCold: [
      "j'ai froid", 'trop froid', 'il fait froid', 'frette', 'je gèle', 'on gèle', 'je suis gelé', 'je suis gelée',
      'je grelotte', 'on grelotte',
    ],
    warmer: [
      'plus chaud', 'monte', 'monter', 'montez', 'augmente', 'augmenter', 'augmentez', 'réchauffe', 'réchauffer',
      'réchauffez', 'chauffe plus', 'plus de chaleur', 'hausse',
    ],
    cooler: [
      'plus frais', 'plus froid', 'moins chaud', 'baisse', 'baisser', 'baissez', 'diminue', 'diminuer', 'diminuez',
      'refroidis', 'refroidir', 'refroidissez', 'rafraîchis', 'rafraîchir', 'rafraîchissez',
    ],
    smallStep: ['un peu', 'un petit peu', 'légèrement', 'un brin'],
    bigStep: ['beaucoup', 'bien plus', 'pas mal plus', 'vraiment plus'],
    intensifiers: ['vraiment', 'tellement', 'très', 'ben'],
    setContext: [
      'mets', 'met', 'mettre', 'mettez', 'règle', 'régler', 'réglez', 'ajuste', 'ajuster', 'chambre', 'pièce',
      'chauffage', 'chauffe', 'température', 'thermostat',
    ],
  },
};

/** Politeness and wake words, removed before matching (both languages). */
const FILLERS = [
  'please', 'hey', 'ok', 'okay', 'can you', 'could you', 'would you', 'will you', 'just', 'thanks', 'thank you',
  'siri', 'alexa', 'hey google', 'ok google', 'um', 'uh',
  "s'il te plaît", "s'il vous plaît", 'svp', 'stp', 'peux-tu', 'pouvez-vous', 'pourrais-tu', 'pourriez-vous',
  'tu peux', 'vous pouvez', 'est-ce que tu peux', 'est-ce que vous pouvez', 'merci', 'euh',
];

/** Requests that belong to another app. Any of these makes the built-in intents bail out. */
const OFF_TOPIC = [
  'weather', 'outside', 'music', 'song', 'play', 'volume', 'light', 'lights', 'alarm', 'timer', 'remind',
  'reminder', 'wake me', 'call', 'text', 'message', 'news', "what's up",
  'météo', 'dehors', 'musique', 'chanson', 'joue', 'lumière', 'lumières', 'alarme', 'minuterie', 'rappel',
  'réveille-moi', 'appelle',
];

/** Words that ask for a preset explicitly. */
const PRESET_CUES = [
  'preset', 'presets', 'mode', 'scene', 'profile', 'activate', 'enable', 'préréglage', 'profil', 'active', 'activer',
  'activez',
];

/** Words that may surround a spoken preset name without making the match partial. */
const PRESET_VERBS = [
  'start', 'turn', 'on', 'switch', 'to', 'use', 'run', 'the', 'my', 'go', 'put', 'set', 'lance', 'lancer', 'démarre',
  'passe', 'en', 'mets', 'le', 'la', 'les', 'mon', 'ma', 'au',
];

const DEGREE_WORDS = ['degree', 'degrees', 'deg', 'degré', 'degrés'];
const CELSIUS_WORDS = ['c', 'celsius', 'centigrade'];
const FAHRENHEIT_WORDS = ['f', 'fahrenheit', 'farenheit'];
const HOUR_WORDS = ['hour', 'hours', 'hr', 'hrs', 'h', 'heure', 'heures'];
const MINUTE_WORDS = ['minute', 'minutes', 'min', 'mins', 'mn'];

/** Single-word numbers, both languages. "un"/"une"/"a"/"an" are handled separately (see ARTICLES). */
const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
  zéro: 0, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
  treize: 13, quatorze: 14, quinze: 15, seize: 16,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, septante: 70, huitante: 80, octante: 80,
  nonante: 90,
};

// ---------------------------------------------------------------------------------------------
// Normalisation

/** Contractions as they look once apostrophes are removed ("i'm" and "im" both become "i am"). */
const CONTRACTIONS: Record<string, string> = {
  im: 'i am', whats: 'what is', its: 'it is', thats: 'that is', hows: 'how is', dont: 'do not', cant: 'cannot',
};

/** Lowercase, strip accents and punctuation, expand contractions and elisions, collapse spaces. */
function normalise(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/(\d),(\d)/g, '$1.$2') // decimal comma: "19,5"
    .replace(/°\s*c\b/g, ' celsius ')
    .replace(/°\s*f\b/g, ' fahrenheit ')
    .replace(/°/g, ' degrees ')
    .replace(/(\d)([cf])\b/g, '$1 $2') // "68f", "20c"
    .replace(/\b(qu|[cdjlmnst])'/g, '$1e ') // French elision: "j'ai" -> "je ai", "d'un" -> "de un"
    .replace(/'/g, '')
    .replace(/[^a-z0-9.]+/g, ' ');
  const words: string[] = [];
  for (const raw of s.split(' ')) {
    const word = raw.replace(/^\.+|\.+$/g, ''); // keep "19.5", drop sentence dots
    if (word) words.push(CONTRACTIONS[word] ?? word);
  }
  return words.join(' ');
}

const normaliseAll = (phrases: readonly string[]): string[] =>
  phrases.map(normalise).sort((a, b) => b.length - a.length); // longest first, for removal

const normalisedPhrases = (p: LanguagePhrases): LanguagePhrases => ({
  status: normaliseAll(p.status),
  resumeAuto: normaliseAll(p.resumeAuto),
  nap: normaliseAll(p.nap),
  goodNight: normaliseAll(p.goodNight),
  goodMorning: normaliseAll(p.goodMorning),
  tooHot: normaliseAll(p.tooHot),
  tooCold: normaliseAll(p.tooCold),
  warmer: normaliseAll(p.warmer),
  cooler: normaliseAll(p.cooler),
  smallStep: normaliseAll(p.smallStep),
  bigStep: normaliseAll(p.bigStep),
  intensifiers: normaliseAll(p.intensifiers),
  setContext: normaliseAll(p.setContext),
});

const TABLES: Record<Locale, LanguagePhrases> = { en: normalisedPhrases(PHRASES.en), fr: normalisedPhrases(PHRASES.fr) };
const FILLER_SET = normaliseAll(FILLERS);
const OFF_TOPIC_SET = normaliseAll(OFF_TOPIC);
const PRESET_CUE_SET = new Set(PRESET_CUES.map(normalise));
const PRESET_VERB_SET = new Set(PRESET_VERBS.map(normalise));
const DEGREES = new Set(DEGREE_WORDS.map(normalise));
const CELSIUS = new Set(CELSIUS_WORDS);
const FAHRENHEIT = new Set(FAHRENHEIT_WORDS);
const HOURS = new Set(HOUR_WORDS.map(normalise));
const MINUTES = new Set(MINUTE_WORDS);
const SMALL = new Map(Object.entries(SMALL_NUMBERS).map(([w, n]) => [normalise(w), n]));
const TEN_WORDS = new Map(Object.entries(TENS));
const ARTICLES = new Set(['a', 'an', 'un', 'une']);
const HALF = new Set(['half', 'demi', 'demie']);
/** After an article, these make it mean "one": "a degree", "une heure". */
const TEMPERATURE_UNITS = new Set([...DEGREES, ...CELSIUS, ...FAHRENHEIT]);
const TIME_UNITS = new Set([...HOURS, ...MINUTES]);

/** Whole-word containment on normalised text. */
const has = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);
const hasAny = (text: string, phrases: readonly string[]): boolean => phrases.some((p) => has(text, p));

function removePhrases(text: string, phrases: readonly string[]): string {
  let out = ` ${text} `;
  for (const p of phrases) {
    while (out.includes(` ${p} `)) out = out.replace(` ${p} `, ' ');
  }
  return out.trim();
}

// ---------------------------------------------------------------------------------------------
// Numbers

interface ParsedNumber {
  value: number;
  /** Index of the first token after the number. */
  next: number;
}

/** "and a half", "and half", "et demi", "et demie": returns the index after it, or -1. */
function halfSuffix(tokens: readonly string[], i: number): number {
  if (tokens[i] !== 'and' && tokens[i] !== 'et') return -1;
  if (HALF.has(tokens[i + 1] ?? '')) return i + 2;
  if (ARTICLES.has(tokens[i + 1] ?? '') && HALF.has(tokens[i + 2] ?? '')) return i + 3;
  return -1;
}

/** 1-19 as words, including French "dix-sept" to "dix-neuf". */
function parseSmall(tokens: readonly string[], i: number): ParsedNumber | null {
  const t = tokens[i] ?? '';
  const unit = SMALL.get(tokens[i + 1] ?? '');
  if (t === 'dix' && unit !== undefined && unit >= 7 && unit <= 9) return { value: 10 + unit, next: i + 2 };
  const value = SMALL.get(t);
  return value === undefined ? null : { value, next: i + 1 };
}

/** Number words such as "sixty eight", "vingt et un", "soixante dix huit", "quatre vingt". */
function parseNumberWords(tokens: readonly string[], i: number): ParsedNumber | null {
  let base: number | undefined;
  let j = i + 1;
  if (tokens[i] === 'quatre' && (tokens[j] === 'vingt' || tokens[j] === 'vingts')) {
    base = 80;
    j++;
  } else {
    base = TEN_WORDS.get(tokens[i] ?? '');
  }
  if (base === undefined) return parseSmall(tokens, i);

  if (tokens[j] === 'et' && (tokens[j + 1] === 'un' || tokens[j + 1] === 'une')) return { value: base + 1, next: j + 2 };
  if (tokens[j] === 'et' && tokens[j + 1] === 'onze') return { value: base + 11, next: j + 2 };
  if (tokens[j] === 'un' || tokens[j] === 'une') return { value: base + 1, next: j + 1 };
  const unit = parseSmall(tokens, j);
  // French counts 70-79 and 90-99 as "soixante-dix...", "quatre-vingt-dix..."
  const teensAllowed = base === 60 || base === 80;
  if (unit && unit.value > 0 && (unit.value <= 9 || teensAllowed)) return { value: base + unit.value, next: unit.next };
  return { value: base, next: j };
}

/**
 * A number at token `i`: digits ("19.5"), words, halves. "a", "an", "un", "une" count as one only
 * when followed by a word in `unitWords`, so "un peu" or "a bit" are not numbers.
 */
function parseNumber(tokens: readonly string[], i: number, unitWords: ReadonlySet<string>): ParsedNumber | null {
  const t = tokens[i] ?? '';
  let parsed: ParsedNumber | null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    parsed = { value: Number(t), next: i + 1 };
  } else if (HALF.has(t)) {
    parsed = { value: 0.5, next: ARTICLES.has(tokens[i + 1] ?? '') ? i + 2 : i + 1 }; // "half a degree"
  } else if (ARTICLES.has(t)) {
    if (HALF.has(tokens[i + 1] ?? '')) parsed = { value: 0.5, next: i + 2 }; // "une demi-heure"
    else if (unitWords.has(tokens[i + 1] ?? '')) parsed = { value: 1, next: i + 1 };
    else return null;
  } else {
    parsed = parseNumberWords(tokens, i);
  }
  if (!parsed) return null;

  const half = halfSuffix(tokens, parsed.next);
  if (half >= 0) return { value: parsed.value + 0.5, next: half };

  // "nineteen point five", "dix-neuf virgule cinq"
  const sep = tokens[parsed.next];
  if ((sep === 'point' || sep === 'virgule') && Number.isInteger(parsed.value)) {
    const after = tokens[parsed.next + 1] ?? '';
    const digits = /^\d+$/.test(after) ? after : String(SMALL.get(after) ?? '');
    if (digits) {
      return { value: parsed.value + Number(digits) / 10 ** digits.length, next: parsed.next + 2 };
    }
  }
  return parsed;
}

interface SpokenTemperature {
  value: number;
  /** The unit said aloud, if any. */
  unit: Units | null;
  start: number;
  end: number;
}

/** The first number in the phrase that is not a duration, with any unit said after it. */
function findTemperature(tokens: readonly string[]): SpokenTemperature | null {
  for (let i = 0; i < tokens.length; i++) {
    const n = parseNumber(tokens, i, TEMPERATURE_UNITS);
    if (!n) continue;
    let j = n.next;
    if (TIME_UNITS.has(tokens[j] ?? '')) {
      i = j;
      continue;
    }
    let value = n.value;
    if (DEGREES.has(tokens[j] ?? '')) {
      j++;
      const half = halfSuffix(tokens, j); // "a degree and a half"
      if (half >= 0) {
        value += 0.5;
        j = half;
      }
    }
    let unit: Units | null = null;
    if (CELSIUS.has(tokens[j] ?? '')) unit = 'C';
    else if (FAHRENHEIT.has(tokens[j] ?? '')) unit = 'F';
    if (unit) j++;
    return { value, unit, start: i, end: j };
  }
  return null;
}

/** Absolute temperature in Celsius, applying the "68 is Fahrenheit, 19 is Celsius" rule. */
function absoluteToC(t: SpokenTemperature, displayUnits: Units): number {
  const unit = t.unit ?? (displayUnits === 'C' ? (t.value >= 45 ? 'F' : 'C') : t.value < 40 ? 'C' : 'F');
  return roundTo(unit === 'F' ? fToC(t.value) : t.value, 0.5);
}

/** A temperature difference in Celsius: Fahrenheit degrees are 5/9 of a Celsius degree. */
function relativeToC(t: SpokenTemperature, displayUnits: Units): number {
  const unit = t.unit ?? displayUnits;
  return unit === 'F' ? (t.value * 5) / 9 : t.value;
}

/** Nearest 0.5, never zero, with the given sign. */
function stepDelta(magnitudeC: number, sign: number): number {
  return sign * Math.max(0.5, roundTo(Math.abs(magnitudeC), 0.5));
}

const NAP_DEFAULT_MIN = 20;
const NAP_MIN = 10;
const NAP_MAX = 180;
/** A relative amount this large ("turn it up 22") is really an absolute target. */
const MAX_RELATIVE_AMOUNT = 10;

/** Total minutes in "1 hour", "an hour and a half", "1h30", "une heure trente", "45 minutes". */
function parseDuration(tokens: readonly string[]): number | null {
  let total = 0;
  let found = false;
  for (let i = 0; i < tokens.length; ) {
    const compact = /^(\d+)h(\d{1,2})?$/.exec(tokens[i] ?? '');
    if (compact) {
      total += Number(compact[1]) * 60 + Number(compact[2] ?? 0);
      found = true;
      i++;
      continue;
    }
    const n = parseNumber(tokens, i, TIME_UNITS);
    if (!n) {
      i++;
      continue;
    }
    let j = n.next;
    if (HOURS.has(tokens[j] ?? '')) {
      let hours = n.value;
      j++;
      const half = halfSuffix(tokens, j);
      if (half >= 0) {
        hours += 0.5;
        j = half;
      }
      total += hours * 60;
      found = true;
      // trailing minutes: "1 h 30", "an hour and 20 minutes"
      const k = tokens[j] === 'and' || tokens[j] === 'et' ? j + 1 : j;
      const minutes = parseNumber(tokens, k, MINUTES);
      if (minutes && !HOURS.has(tokens[minutes.next] ?? '')) {
        total += minutes.value;
        j = MINUTES.has(tokens[minutes.next] ?? '') ? minutes.next + 1 : minutes.next;
      }
      i = j;
    } else if (MINUTES.has(tokens[j] ?? '')) {
      total += n.value;
      found = true;
      i = j + 1;
    } else {
      i++;
    }
  }
  return found ? total : null;
}

// ---------------------------------------------------------------------------------------------
// Intent detection

const CLEAR = 0.9;
const PARTIAL_PRESET = 0.75;
const BARE_NUMBER = 0.6;
const ASKED_FOR_MISSING_PRESET = 0.3;

const result = (intent: VoiceIntent, confidence: number): VoiceParseResult => ({ intent, confidence });
const UNKNOWN: VoiceParseResult = { intent: { type: 'unknown' }, confidence: 0 };

/** +1 warmer, -1 cooler, 0 none or contradictory. */
function direction(text: string, p: LanguagePhrases): number {
  const up = hasAny(text, p.warmer);
  const down = hasAny(text, p.cooler);
  return up === down ? 0 : up ? 1 : -1;
}

/** Built-in intents using one language's phrases. Numbers and units are shared by both languages. */
function parseInLanguage(text: string, p: LanguagePhrases, units: Units): VoiceParseResult {
  if (hasAny(text, p.status)) return result({ type: 'status' }, CLEAR);
  if (hasAny(text, p.resumeAuto)) return result({ type: 'resumeAuto' }, CLEAR);

  const tokens = text.split(' ');
  if (hasAny(text, p.nap)) {
    const minutes = parseDuration(tokens) ?? NAP_DEFAULT_MIN;
    return result({ type: 'startNap', minutes: Math.round(clamp(minutes, NAP_MIN, NAP_MAX)) }, CLEAR);
  }

  const sign = direction(text, p);
  const temperature = findTemperature(tokens);
  if (temperature) {
    const before = tokens[temperature.start - 1];
    const saysTo = before === 'to' || before === 'at' || before === 'a';
    if (sign !== 0 && !saysTo && temperature.value < MAX_RELATIVE_AMOUNT) {
      return result({ type: 'adjust', deltaC: stepDelta(relativeToC(temperature, units), sign) }, CLEAR);
    }
    const valueC = absoluteToC(temperature, units);
    if (temperature.start === 0 && temperature.end === tokens.length && !temperature.unit) {
      const saidDegrees = temperature.end > 0 && DEGREES.has(tokens[temperature.end - 1] ?? '');
      return result({ type: 'setTemperature', valueC }, saidDegrees ? CLEAR : BARE_NUMBER);
    }
    if (sign !== 0 || temperature.unit || hasAny(text, p.setContext) || tokens.some((t) => DEGREES.has(t))) {
      return result({ type: 'setTemperature', valueC }, CLEAR);
    }
  }

  if (hasAny(text, p.goodNight)) return result({ type: 'goodNight' }, CLEAR);
  if (hasAny(text, p.goodMorning)) return result({ type: 'goodMorning' }, CLEAR);

  const small = hasAny(text, p.smallStep);
  const feelingText = removePhrases(text, [...p.smallStep, ...p.intensifiers]);
  const feelingStep = small ? 0.5 : 1;
  if (hasAny(feelingText, p.tooHot)) return result({ type: 'adjust', deltaC: -feelingStep, feeling: 'tooHot' }, CLEAR);
  if (hasAny(feelingText, p.tooCold)) return result({ type: 'adjust', deltaC: feelingStep, feeling: 'tooCold' }, CLEAR);

  if (sign !== 0) {
    const size = small ? 0.5 : hasAny(text, p.bigStep) ? 2 : 1;
    return result({ type: 'adjust', deltaC: sign * size }, CLEAR);
  }
  return UNKNOWN;
}

/** The longest preset name found in the phrase, as the user wrote it. */
function findPreset(text: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const name of names) {
    const n = normalise(name);
    if (n && n.length > bestLength && has(text, n)) {
      best = name;
      bestLength = n.length;
    }
  }
  return best;
}

export function parseVoiceCommand(text: string, opts: VoiceParseOptions): VoiceParseResult {
  const normalised = normalise(text);
  const stripped = removePhrases(normalised, FILLER_SET);
  if (!stripped) return UNKNOWN;

  const words = stripped.split(' ');
  const presetName = findPreset(normalised, opts.presetNames ?? []);
  const askedForPreset = words.some((w) => PRESET_CUE_SET.has(w));
  if (presetName && askedForPreset) return result({ type: 'activatePreset', name: presetName }, CLEAR);

  const builtIn = parseBuiltIn(stripped, opts);
  if (builtIn.intent.type !== 'unknown') return builtIn;

  if (presetName) {
    const nameWords = new Set(normalise(presetName).split(' '));
    const extra = words.filter((w) => !nameWords.has(w) && !PRESET_VERB_SET.has(w));
    return result({ type: 'activatePreset', name: presetName }, extra.length === 0 ? CLEAR : PARTIAL_PRESET);
  }
  return askedForPreset ? result({ type: 'unknown' }, ASKED_FOR_MISSING_PRESET) : UNKNOWN;
}

function parseBuiltIn(text: string, opts: VoiceParseOptions): VoiceParseResult {
  if (hasAny(text, OFF_TOPIC_SET)) return UNKNOWN;
  const other: Locale = opts.locale === 'fr' ? 'en' : 'fr';
  const first = parseInLanguage(text, TABLES[opts.locale], opts.units);
  if (first.confidence >= CLEAR) return first;
  const second = parseInLanguage(text, TABLES[other], opts.units);
  return second.confidence > first.confidence ? second : first;
}

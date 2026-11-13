import type { Locale, Units } from '../types';
import { cToF } from '../util';
import type { VoiceOutcome, VoiceReplyOptions } from './types';

/*
 * Spoken replies: one short plain sentence, no markup, read aloud by a voice assistant.
 * French uses "vous" or impersonal phrasing, a decimal comma and a non-breaking space before
 * "°C" and "%"; English uses a regular space.
 */

const NBSP = ' ';

const space = (locale: Locale): string => (locale === 'fr' ? NBSP : ' ');

/** At most one decimal, no trailing ".0", decimal comma in French. */
function decimal(value: number, locale: Locale): string {
  const rounded = Math.round(value * 10) / 10 || 0; // `|| 0` turns -0 into 0
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return locale === 'fr' ? text.replace('.', ',') : text;
}

/** "19.5 °C", "68 °F", "19,5 °C". */
function temperature(c: number, units: Units, locale: Locale): string {
  const value = units === 'F' ? String(Math.round(cToF(c))) : decimal(c, locale);
  return `${value}${space(locale)}°${units}`;
}

/** Size of a change in the user's units: a Fahrenheit degree is 9/5 of a Celsius one. */
function differenceValue(deltaC: number, units: Units): number {
  const magnitude = Math.abs(deltaC);
  return units === 'F' ? Math.max(1, Math.round((magnitude * 9) / 5)) : Math.round(magnitude * 10) / 10;
}

function englishDifference(deltaC: number, units: Units): string {
  const value = differenceValue(deltaC, units);
  if (value === 0.5) return 'half a degree';
  return value === 1 ? '1 degree' : `${decimal(value, 'en')} degrees`;
}

/** Includes the preposition so elision works: "d'un degré", "de 2 degrés". */
function frenchDifference(deltaC: number, units: Units): string {
  const value = differenceValue(deltaC, units);
  if (value === 0.5) return "d'un demi-degré";
  if (value === 1) return "d'un degré";
  return `de ${decimal(value, 'fr')} ${value < 2 ? 'degré' : 'degrés'}`;
}

function englishDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const minutePart = `${rest} ${rest === 1 ? 'minute' : 'minutes'}`;
  if (hours === 0) return minutePart;
  const hourPart = hours === 1 ? 'an hour' : `${hours} hours`;
  return rest === 0 ? hourPart : `${hourPart} and ${minutePart}`;
}

function frenchDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} ${rest === 1 ? 'minute' : 'minutes'}`;
  const hourPart = hours === 1 ? 'une heure' : `${hours} heures`;
  return rest === 0 ? hourPart : `${hourPart} ${rest}`; // "une heure 30" reads as "une heure trente"
}

/** "de" elides before a vowel: "d'une heure", "de 45 minutes". */
const frenchDe = (text: string): string => (/^[aeiouh]/.test(text) ? `d'${text}` : `de ${text}`);

function english(outcome: VoiceOutcome, units: Units): string {
  const t = (c: number): string => temperature(c, units, 'en');
  switch (outcome.type) {
    case 'held':
      if (outcome.untilMorning) return `OK, holding at ${t(outcome.targetC)} until morning.`;
      if (outcome.minutes) return `OK, holding at ${t(outcome.targetC)} for ${englishDuration(outcome.minutes)}.`;
      return `OK, holding at ${t(outcome.targetC)}.`;
    case 'adjusted':
      if (outcome.deltaC === 0) return `It stays at ${t(outcome.targetC)}.`;
      return `OK, ${outcome.deltaC > 0 ? 'raising' : 'lowering'} it by ${englishDifference(outcome.deltaC, units)} to ${t(outcome.targetC)}.`;
    case 'presetActivated':
      return `OK, switching to your ${outcome.name} preset.`;
    case 'presetNotFound':
      return "Sorry, I couldn't find a preset with that name.";
    case 'napStarted':
      return `OK, starting a nap for ${englishDuration(outcome.minutes)} at ${t(outcome.targetC)}.`;
    case 'resumed':
      return 'OK, back to your automatic schedule.';
    case 'status':
      return `It's ${t(outcome.roomTempC)} in the room${outcome.humidityPct === undefined ? '' : ` with ${Math.round(outcome.humidityPct)}% humidity`}${englishTarget(outcome.targetC, outcome.mode, t)}.`;
    case 'nightStarted':
      return `Good night, setting the room to ${t(outcome.targetC)} for the night.`;
    case 'nightEnded':
      return 'Good morning, the room is back on your usual settings.';
    case 'outOfRange':
      return `I can only set the temperature between ${t(outcome.minC)} and ${t(outcome.maxC)}.`;
    case 'notUnderstood':
      return "Sorry, I didn't catch that; you can say warmer, cooler, or a temperature.";
  }
}

type StatusMode = Extract<VoiceOutcome, { type: 'status' }>['mode'];

function englishTarget(targetC: number | null, mode: StatusMode, t: (c: number) => string): string {
  if (targetC === null) return mode === 'idle' ? ', and nothing is running right now' : '';
  switch (mode) {
    case 'auto':
      return `, and your schedule is aiming for ${t(targetC)}`;
    case 'hold':
      return `, held at ${t(targetC)}`;
    case 'preset':
      return `, and your preset is aiming for ${t(targetC)}`;
    case 'idle':
      return `, with a target of ${t(targetC)}`;
  }
}

function french(outcome: VoiceOutcome, units: Units): string {
  const t = (c: number): string => temperature(c, units, 'fr');
  switch (outcome.type) {
    case 'held':
      if (outcome.untilMorning) return `D'accord, je maintiens ${t(outcome.targetC)} jusqu'au matin.`;
      if (outcome.minutes) return `D'accord, je maintiens ${t(outcome.targetC)} pendant ${frenchDuration(outcome.minutes)}.`;
      return `D'accord, je maintiens ${t(outcome.targetC)}.`;
    case 'adjusted':
      if (outcome.deltaC === 0) return `La température reste à ${t(outcome.targetC)}.`;
      return `D'accord, je ${outcome.deltaC > 0 ? 'monte' : 'baisse'} la température ${frenchDifference(outcome.deltaC, units)}, à ${t(outcome.targetC)}.`;
    case 'presetActivated':
      return `D'accord, le préréglage ${outcome.name} est activé.`;
    case 'presetNotFound':
      return 'Aucun préréglage ne porte ce nom.';
    case 'napStarted':
      return `D'accord, je lance une sieste ${frenchDe(frenchDuration(outcome.minutes))} à ${t(outcome.targetC)}.`;
    case 'resumed':
      return "D'accord, je reprends l'horaire automatique.";
    case 'status':
      return `Il fait ${t(outcome.roomTempC)} dans la chambre${outcome.humidityPct === undefined ? '' : `, avec ${Math.round(outcome.humidityPct)}${NBSP}% d'humidité`}${frenchTarget(outcome.targetC, outcome.mode, t)}.`;
    case 'nightStarted':
      return `Bonne nuit, je règle la chambre à ${t(outcome.targetC)} pour la nuit.`;
    case 'nightEnded':
      return 'Bonjour, la chambre revient à vos réglages habituels.';
    case 'outOfRange':
      return `Je ne peux régler la température qu'entre ${t(outcome.minC)} et ${t(outcome.maxC)}.`;
    case 'notUnderstood':
      return "Pardon, je n'ai pas compris; vous pouvez dire plus chaud, plus frais ou une température.";
  }
}

function frenchTarget(targetC: number | null, mode: StatusMode, t: (c: number) => string): string {
  if (targetC === null) return mode === 'idle' ? ", et aucun réglage n'est en cours" : '';
  switch (mode) {
    case 'auto':
      return `, et votre horaire vise ${t(targetC)}`;
    case 'hold':
      return `, et la consigne est maintenue à ${t(targetC)}`;
    case 'preset':
      return `, et votre préréglage vise ${t(targetC)}`;
    case 'idle':
      return `, et la consigne est de ${t(targetC)}`;
  }
}

export function formatVoiceReply(outcome: VoiceOutcome, opts: VoiceReplyOptions): string {
  return opts.locale === 'fr' ? french(outcome, opts.units) : english(outcome, opts.units);
}

import type { Locale, Units } from '../types';

/** What the user asked for, in a form the server can act on. */
export type VoiceIntent =
  /** "Set the bedroom to 19", "mets la chambre à 19 degrés". Always Celsius here. */
  | { type: 'setTemperature'; valueC: number }
  /**
   * "Warmer", "a bit cooler", "2 degrees colder", "I'm hot", "j'ai froid".
   * `feeling` is set when the user described how they feel rather than what to do,
   * so the server can also record it as comfort feedback.
   */
  | { type: 'adjust'; deltaC: number; feeling?: 'tooHot' | 'tooCold' }
  /** "Start movie night", "active le préréglage Hiver". `name` is the matched preset's exact name. */
  | { type: 'activatePreset'; name: string }
  /** "Start a 20 minute nap", "sieste de 20 minutes". */
  | { type: 'startNap'; minutes: number }
  /** "Resume the schedule", "back to automatic", "reprends le mode automatique". */
  | { type: 'resumeAuto' }
  /** "What's the temperature?", "quelle est la température ?" */
  | { type: 'status' }
  /** "Good night", "bonne nuit": start tonight's plan now. */
  | { type: 'goodNight' }
  /** "Good morning", "I'm awake", "je suis réveillé": end the plan and hand the room back. */
  | { type: 'goodMorning' }
  | { type: 'unknown' };

export interface VoiceParseOptions {
  locale: Locale;
  /** The user's display units: decides how a bare number such as "68" is read. */
  units: Units;
  /** Names of the user's presets, matched case- and accent-insensitively. */
  presetNames?: readonly string[];
}

export interface VoiceParseResult {
  intent: VoiceIntent;
  /** 0..1. Below about 0.5 the server should ask the user to rephrase instead of acting. */
  confidence: number;
}

/** What actually happened, for the spoken or written reply. */
export type VoiceOutcome =
  | { type: 'held'; targetC: number; untilMorning: boolean; minutes?: number }
  | { type: 'adjusted'; targetC: number; deltaC: number }
  | { type: 'presetActivated'; name: string }
  | { type: 'presetNotFound' }
  | { type: 'napStarted'; minutes: number; targetC: number }
  | { type: 'resumed' }
  | { type: 'status'; roomTempC: number; targetC: number | null; mode: 'auto' | 'hold' | 'preset' | 'idle' }
  | { type: 'nightStarted'; targetC: number }
  | { type: 'nightEnded' }
  | { type: 'outOfRange'; minC: number; maxC: number }
  /** Manual control is switched off, so a request to set the temperature was not carried out. */
  | { type: 'manualControlOff' }
  /** "I'm hot" / "I'm cold" was recorded as feedback; the temperature itself was not changed by hand. */
  | { type: 'feedbackNoted' }
  | { type: 'notUnderstood' };

export interface VoiceReplyOptions {
  locale: Locale;
  units: Units;
}

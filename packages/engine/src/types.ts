/**
 * Shared domain types. All temperatures are degrees Celsius internally;
 * conversion to Fahrenheit happens only at the display edge.
 */

/** The parts of a night the engine plans separately. */
export type Phase = 'windDown' | 'onset' | 'deep' | 'rem' | 'wake';

/** Phases during which the sleeper is asleep and the core temperature matters. */
export const SLEEP_PHASES: readonly Phase[] = ['onset', 'deep', 'rem'];

export type Locale = 'en' | 'fr';
export type Units = 'C' | 'F';

export interface ComfortLimits {
  /** Lowest temperature the user allows the platform to set. */
  minC: number;
  /** Highest temperature the user allows the platform to set. */
  maxC: number;
}

/** Absolute bounds no user setting or algorithm output may cross. */
export const HARD_LIMITS: ComfortLimits = { minC: 12, maxC: 28 };
export const DEFAULT_LIMITS: ComfortLimits = { minC: 15.5, maxC: 25 };

export interface SleeperOptions {
  /** Allow small test variations (at most 1 degree) while the model is still learning. */
  explore: boolean;
  /** Opt-in: adjust for menstrual cycle phase. */
  cycleTracking: boolean;
  /** Opt-in: cooler baseline and fast response to hot flashes. */
  menopauseMode: boolean;
  /** Opt-in: adjust after hard workouts, alcohol or illness. */
  recoveryAware: boolean;
}

export const DEFAULT_OPTIONS: SleeperOptions = {
  explore: true,
  cycleTracking: false,
  menopauseMode: false,
  recoveryAware: true,
};

export type CyclePhase = 'menstrual' | 'follicular' | 'ovulatory' | 'luteal';

/** What a wearable reports for one night, normalised across vendors. */
export interface NightMetrics {
  timeInBedMin: number;
  totalSleepMin: number;
  /** Fraction of time in bed spent asleep, 0..1. */
  sleepEfficiency: number;
  deepMin?: number;
  remMin?: number;
  awakenings?: number;
  /** Fraction of the night with restless movement, 0..1. */
  restlessness?: number;
  sleepLatencyMin?: number;
  hrvMs?: number;
  restingHr?: number;
  /** Personal rolling baselines, supplied by the caller when known. */
  hrvBaselineMs?: number;
  restingHrBaseline?: number;
  /** Nightly skin temperature deviation from the personal baseline. */
  skinTempDeviationC?: number;
}

/** A reading taken during the night. Every signal is optional: use what the device offers. */
export interface LiveVitals {
  heartRate?: number;
  /** Typical sleeping heart rate for this person. */
  heartRateBaseline?: number;
  /** Movement intensity over the last few minutes, 0..1. */
  movement?: number;
  /** Skin temperature relative to the personal baseline. Few devices expose this live. */
  skinTempDeltaC?: number;
  awake?: boolean;
}

export type FeedbackKind = 'tooHot' | 'tooCold' | 'justRight';

export type HvacMode = 'heat' | 'cool' | 'auto' | 'off';

export type Rng = () => number;

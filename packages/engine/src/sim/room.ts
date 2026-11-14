/**
 * A simple thermal model of a bedroom and its heating/cooling equipment, used
 * by the demo and tests in place of a real thermostat.
 *
 * The room loses or gains heat to the outdoors, and (for bedroom-only devices)
 * to the rest of the home. Equipment switches on and off around the setpoint
 * the way a real thermostat does.
 */

import type { HvacMode, Rng } from '../types';
import { gaussian } from '../util';

export interface RoomParams {
  /** Degrees per hour the equipment adds when heating; 0 if it cannot heat. */
  heatRateCPerHour: number;
  /** Degrees per hour it removes when cooling; 0 if it cannot cool. */
  coolRateCPerHour: number;
  /** Electrical draw while heating / cooling. */
  heatKW: number;
  coolKW: number;
  /** Hours for the room to close about two-thirds of the gap to the outdoors with everything off. */
  outdoorTauHours: number;
  /**
   * For a bedroom-level device: the rest of the home stays at `houseTempC` and
   * the bedroom drifts toward it with this time constant. Omit for whole-home systems.
   */
  houseTauHours?: number;
  houseTempC?: number;
}

/** Typical equipment. Rates and wattages are round illustrative figures. */
export const ROOM_PRESETS: Record<string, RoomParams> = {
  /** Central heat pump or furnace + AC on one whole-home thermostat. */
  central: { heatRateCPerHour: 2.5, coolRateCPerHour: 2, heatKW: 3.5, coolKW: 2.5, outdoorTauHours: 30 },
  /** Electric baseboard on a line-voltage thermostat: bedroom only, heat only. */
  baseboard: { heatRateCPerHour: 3, coolRateCPerHour: 0, heatKW: 1.5, coolKW: 0, outdoorTauHours: 20, houseTauHours: 8, houseTempC: 21 },
  /** Ductless mini-split heat pump in the bedroom. */
  miniSplit: { heatRateCPerHour: 4, coolRateCPerHour: 4, heatKW: 0.9, coolKW: 0.8, outdoorTauHours: 20, houseTauHours: 8, houseTempC: 21 },
  /** Window or portable air conditioner: bedroom only, cooling only. */
  windowAc: { heatRateCPerHour: 0, coolRateCPerHour: 3, heatKW: 0, coolKW: 0.9, outdoorTauHours: 20, houseTauHours: 8, houseTempC: 23 },
};

export type Running = 'heat' | 'cool' | 'idle';

export interface RoomState {
  tempC: number;
  running: Running;
}

export interface RoomStepInput {
  setpointC: number;
  mode: HvacMode;
  outdoorC: number;
  minutes: number;
}

export interface RoomStepResult {
  state: RoomState;
  /** Electricity used during the step. */
  kWh: number;
  heatMinutes: number;
  coolMinutes: number;
}

const HEAT_ON_BELOW = 0.25;
const COOL_ON_ABOVE = 0.25;
/** In auto mode cooling waits for a wider gap so the two never chase each other. */
const AUTO_COOL_ON_ABOVE = 0.75;

/** Advance the room by `minutes`, one simulated minute at a time. */
export function stepRoom(prev: RoomState, params: RoomParams, input: RoomStepInput): RoomStepResult {
  let { tempC, running } = prev;
  let heatMinutes = 0;
  let coolMinutes = 0;
  const canHeat = (input.mode === 'heat' || input.mode === 'auto') && params.heatRateCPerHour > 0;
  const canCool = (input.mode === 'cool' || input.mode === 'auto') && params.coolRateCPerHour > 0;
  const coolOn = input.mode === 'auto' ? AUTO_COOL_ON_ABOVE : COOL_ON_ABOVE;

  for (let m = 0; m < input.minutes; m++) {
    if (running === 'heat' && (!canHeat || tempC >= input.setpointC)) running = 'idle';
    if (running === 'cool' && (!canCool || tempC <= input.setpointC)) running = 'idle';
    if (running === 'idle') {
      if (canHeat && tempC < input.setpointC - HEAT_ON_BELOW) running = 'heat';
      else if (canCool && tempC > input.setpointC + coolOn) running = 'cool';
    }

    let perHour = (input.outdoorC - tempC) / params.outdoorTauHours;
    if (params.houseTauHours && params.houseTempC !== undefined) perHour += (params.houseTempC - tempC) / params.houseTauHours;
    if (running === 'heat') {
      perHour += params.heatRateCPerHour;
      heatMinutes++;
    } else if (running === 'cool') {
      perHour -= params.coolRateCPerHour;
      coolMinutes++;
    }
    tempC += perHour / 60;
  }

  return {
    state: { tempC, running },
    kWh: (heatMinutes * params.heatKW + coolMinutes * params.coolKW) / 60,
    heatMinutes,
    coolMinutes,
  };
}

/** What a wall thermostat's sensor would report: the true temperature with a little noise. */
export function sensedTempC(state: RoomState, rng: Rng): number {
  return state.tempC + 0.05 * gaussian(rng);
}

/** The mode a thermostat would be left in for the weather: heating season, cooling season, or in between. */
export function seasonalMode(outdoorC: number, params: RoomParams): HvacMode {
  const canHeat = params.heatRateCPerHour > 0;
  const canCool = params.coolRateCPerHour > 0;
  if (canHeat && canCool) return outdoorC < 10 ? 'heat' : outdoorC > 17 ? 'cool' : 'auto';
  if (canHeat) return 'heat';
  if (canCool) return 'cool';
  return 'off';
}

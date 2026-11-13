/**
 * Demo households. Each scenario is a small cast of simulated sleepers (with a
 * hidden true preference the engine has to discover) and the devices in their
 * bedroom.
 */

import type { Equipment } from '@tempcontrol/contracts';
import {
  addDays,
  createModel,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  hashString,
  localParts,
  seededRng,
  type DailyReadings,
  type LocalizedText,
  type SleeperOptions,
} from '@tempcontrol/engine';
import { CLIMATES, DEFAULT_TRUTH, type SleeperTruth } from '@tempcontrol/engine/sim';
import { newId, type SleeperRecord, type Store } from './store';

interface ScenarioSleeper {
  name: string;
  locale: 'en' | 'fr';
  birthYear: number;
  bedtime: string;
  wakeTime: string;
  wearableBrand: string;
  options?: Partial<SleeperOptions>;
  /** Days since the last period started, for sleepers who track their cycle. */
  cycleDay?: number;
  truth: Partial<SleeperTruth>;
}

interface Scenario {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  household: string;
  climateId: string;
  tariffId: string;
  energy: boolean;
  roomName: string;
  thermostat: { brand: string; equipment: Equipment; name: string; reportsHumidity: boolean };
  sleepers: ScenarioSleeper[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'couple',
    name: { en: 'Couple in Montréal', fr: 'Couple à Montréal' },
    description: {
      en: 'Two partners who want different temperatures share one bedroom. One wears a watch that reports live, the other a ring that syncs in the morning.',
      fr: "Deux partenaires qui préfèrent des températures différentes partagent une chambre. L'un porte une montre qui transmet en direct, l'autre une bague qui se synchronise le matin.",
    },
    household: 'Montréal',
    climateId: 'montreal',
    tariffId: 'qc-flex-d',
    energy: true,
    roomName: 'Bedroom',
    thermostat: { brand: 'mysa', equipment: 'miniSplit', name: 'Mysa (mini-split)', reportsHumidity: true },
    sleepers: [
      {
        name: 'Camille',
        locale: 'fr',
        birthYear: 1991,
        bedtime: '22:30',
        wakeTime: '06:30',
        wearableBrand: 'apple-watch',
        options: { cycleTracking: true },
        cycleDay: 17,
        truth: { idealCoreC: 17.5, sensitivity: 1.2, feedbackRate: 0.5, overrideRate: 0.2 },
      },
      {
        name: 'Alex',
        locale: 'en',
        birthYear: 1988,
        bedtime: '23:15',
        wakeTime: '07:00',
        wearableBrand: 'oura',
        truth: { idealCoreC: 20.5, sensitivity: 0.9, seasonShiftC: 0.4, feedbackRate: 0.4, overrideRate: 0.15 },
      },
    ],
  },
  {
    id: 'solo',
    name: { en: 'Solo sleeper in Toronto', fr: 'Personne seule à Toronto' },
    description: {
      en: 'One sleeper, a whole-home thermostat and Ontario time-of-use prices. A good place to see the energy mode warm the morning before the on-peak price starts.',
      fr: "Une personne, un thermostat central et la tarification horaire de l'Ontario. Idéal pour voir le mode économie réchauffer le matin avant le début des heures de pointe.",
    },
    household: 'Toronto',
    climateId: 'toronto',
    tariffId: 'on-tou',
    energy: true,
    roomName: 'Bedroom',
    thermostat: { brand: 'nest', equipment: 'central', name: 'Nest thermostat', reportsHumidity: true },
    sleepers: [
      {
        name: 'Sam',
        locale: 'en',
        birthYear: 1979,
        bedtime: '23:00',
        wakeTime: '07:30',
        wearableBrand: 'garmin',
        truth: { idealCoreC: 19.5, feedbackRate: 0.35, overrideRate: 0.15 },
      },
    ],
  },
  {
    id: 'night-sweats',
    name: { en: 'Night sweats in Ottawa', fr: 'Sueurs nocturnes à Ottawa' },
    description: {
      en: 'A sleeper with frequent hot flashes, menopause mode switched on and a live watch, on a thermostat that does not report humidity.',
      fr: "Une personne aux bouffées de chaleur fréquentes : mode ménopause activé et montre en direct, avec un thermostat qui ne mesure pas l'humidité.",
    },
    household: 'Ottawa',
    climateId: 'ottawa',
    tariffId: 'on-ulo',
    energy: true,
    roomName: 'Bedroom',
    thermostat: { brand: 'ecobee', equipment: 'central', name: 'ecobee thermostat', reportsHumidity: false },
    sleepers: [
      {
        name: 'Dominique',
        locale: 'fr',
        birthYear: 1973,
        bedtime: '22:15',
        wakeTime: '06:15',
        wearableBrand: 'apple-watch',
        options: { menopauseMode: true },
        truth: { idealCoreC: 17.5, sensitivity: 1.1, hotFlashesPerNight: 2.5, feedbackRate: 0.4, overrideRate: 0.1 },
      },
    ],
  },
];

export const scenario = (id: string | undefined): Scenario => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;

/** Today's date in a time zone. */
export function todayIn(timeZone: string): string {
  return localParts(Date.now(), timeZone).date;
}

/** Replace whatever is stored with a fresh demo household. Returns its id. */
export function seedDemo(store: Store, scenarioId: string | undefined, opts: { date?: string; seed?: number } = {}): string {
  const sc = scenario(scenarioId);
  const climate = CLIMATES[sc.climateId]!;
  const date = opts.date ?? todayIn(climate.timeZone);
  const householdId = newId('home');
  const roomId = newId('room');

  store.transaction(() => {
    store.clear();
    store.saveHousehold({
      id: householdId,
      name: sc.household,
      climateId: sc.climateId,
      date,
      tariffId: sc.tariffId,
      energy: { enabled: sc.energy, toleranceC: 0.5 },
      daySetpointC: 21,
      peakEvent: null,
      seed: opts.seed ?? 7,
    });
    store.saveRoom({
      id: roomId,
      householdId,
      name: sc.roomName,
      response: {},
      climate: { tempC: 21, humidityPct: null },
      pendingHold: null,
      activePresetId: null,
      recommendation: null,
    });
    store.saveDevice({ id: newId('dev'), roomId, ...sc.thermostat });

    for (const s of sc.sleepers) {
      const sleeper: SleeperRecord = {
        id: newId('slp'),
        householdId,
        roomId,
        name: s.name,
        locale: s.locale,
        units: 'C',
        birthYear: s.birthYear,
        bedtime: s.bedtime,
        wakeTime: s.wakeTime,
        limits: DEFAULT_LIMITS,
        options: { ...DEFAULT_OPTIONS, ...s.options },
        cycle: { lastPeriodStart: s.cycleDay === undefined ? null : addDays(date, -s.cycleDay), lengthDays: 28 },
        wearableBrand: s.wearableBrand,
        model: createModel({ age: Number(date.slice(0, 4)) - s.birthYear }),
        tonight: { alcohol: false, highStrain: false, illness: false },
        travel: null,
        truth: { ...DEFAULT_TRUTH, ...s.truth },
      };
      store.saveSleeper(sleeper);
    }

    store.savePreset({ id: newId('pre'), householdId, name: s2(sc, 'Cozy 21', 'Douillet 21'), kind: 'hold', targetC: 21 });
    store.savePreset({ id: newId('pre'), householdId, name: s2(sc, 'Cool 17', 'Frais 17'), kind: 'hold', targetC: 17 });
    store.savePreset({
      id: newId('pre'),
      householdId,
      name: s2(sc, 'My own curve', 'Ma courbe'),
      kind: 'curve',
      temps: { onset: 19.5, deep: 18, rem: 18.5, wake: 21 },
    });
  });
  return householdId;
}

/** Preset names follow the language of the first sleeper in the scenario. */
const s2 = (sc: Scenario, en: string, fr: string): string => (sc.sleepers[0]!.locale === 'fr' ? fr : en);

/**
 * What a simulated wearable reports about the day: mostly ordinary days, with
 * the occasional hard training day and, rarely, signs of illness.
 */
export function simulatedDay(sleeperId: string, date: string, seed: number): DailyReadings {
  const rng = seededRng(hashString(`${seed}:day:${sleeperId}:${date}`));
  const hardDay = rng() < 0.18;
  const ill = rng() < 0.015;
  return {
    strain: hardDay ? 15 + 5 * rng() : 6 + 7 * rng(),
    skinTempDeviationC: ill ? 1 + 0.5 * rng() : 0.3 * (rng() - 0.5),
    restingHrDeltaBpm: ill ? 6 + 3 * rng() : 3 * (rng() - 0.5),
  };
}

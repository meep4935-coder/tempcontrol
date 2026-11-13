/** Turning stored records into the shapes the API promises (see @tempcontrol/contracts). */

import type {
  DeviceDto,
  HouseholdDto,
  LiveSessionDto,
  PresetDto,
  RoomDto,
  SavingsDto,
  SleeperDto,
  StateDto,
  TariffDto,
} from '@tempcontrol/contracts';
import { estimateIdeal, phaseOffset, seasonName, TARIFFS, type NightRecord, type Tariff } from '@tempcontrol/engine';
import { CLIMATES, ROOM_PRESETS, seasonalMode } from '@tempcontrol/engine/sim';
import { CATALOG, wearableBrand } from './catalog';
import { SCENARIOS } from './demo';
import { outlookFor, sleeperTonight, type Outlook } from './night';
import type { DeviceRecord, HouseholdRecord, PresetRecord, RoomRecord, SleeperRecord, Store } from './store';

const round = (v: number, digits = 2): number => Math.round(v * 10 ** digits) / 10 ** digits;

export function householdDto(h: HouseholdRecord, outlook: Outlook, reportsHumidity: boolean): HouseholdDto {
  const { climate } = outlook;
  return {
    id: h.id,
    name: h.name,
    climateId: climate.id,
    city: climate.name,
    region: climate.region,
    timeZone: climate.timeZone,
    latitude: climate.latitude,
    date: h.date,
    season: seasonName(h.date, climate.latitude),
    seasonIndex: round(outlook.seasonIndex),
    outlook: { outdoorC: round(outlook.outdoorC, 1), humidityPct: reportsHumidity ? Math.round(outlook.humidityPct) : null },
    tariffId: h.tariffId,
    energy: h.energy,
    daySetpointC: h.daySetpointC,
    peakEvent: h.peakEvent,
  };
}

export function sleeperDto(s: SleeperRecord, h: HouseholdRecord, outlook: Outlook): SleeperDto {
  const season = outlook.seasonIndex;
  const tonight = sleeperTonight(s, h, outlook.climate.timeZone);
  const estimate = estimateIdeal(s.model, season);
  return {
    id: s.id,
    name: s.name,
    roomId: s.roomId,
    locale: s.locale,
    units: s.units,
    birthYear: s.birthYear,
    bedtime: s.bedtime,
    wakeTime: s.wakeTime,
    limits: s.limits,
    options: s.options,
    cycle: s.cycle,
    wearable: wearableBrand(s.wearableBrand),
    estimate: {
      ...estimate,
      coreC: round(estimate.coreC),
      sdC: round(estimate.sdC),
      confidence: round(estimate.confidence, 3),
      sensitivity: round(estimate.sensitivity),
      seasonShiftC: round(estimate.seasonShiftC),
    },
    phaseOffsets: {
      onset: round(phaseOffset(s.model, 'onset', season)),
      rem: round(phaseOffset(s.model, 'rem', season)),
      wake: round(phaseOffset(s.model, 'wake', season)),
    },
    tonight: s.tonight,
    context: { cyclePhase: s.options.cycleTracking ? tonight.cyclePhase : null, recovery: tonight.recovery },
    travel: s.travel,
    demo: { trueIdealC: round(s.truth.idealCoreC + s.truth.seasonShiftC * season), hotFlashes: s.truth.hotFlashesPerNight > 0 },
  };
}

export const deviceDto = (d: DeviceRecord): DeviceDto => ({ ...d });

export const presetDto = ({ householdId: _householdId, ...p }: PresetRecord): PresetDto => p;

export function roomDto(store: Store, room: RoomRecord, h: HouseholdRecord, outlook: Outlook): RoomDto {
  const devices = store.devices(room.id);
  const thermostat = devices[0];
  const equipment = ROOM_PRESETS[thermostat?.equipment ?? 'central']!;
  return {
    id: room.id,
    name: room.name,
    sleeperIds: store
      .sleepers(h.id)
      .filter((s) => s.roomId === room.id)
      .map((s) => s.id),
    devices: devices.map(deviceDto),
    climate: {
      tempC: room.climate.tempC,
      humidityPct: thermostat?.reportsHumidity ? room.climate.humidityPct : null,
      mode: thermostat ? seasonalMode(outlook.outdoorC, equipment) : 'off',
    },
    response: room.response,
    hold: room.pendingHold,
    activePresetId: room.activePresetId,
  };
}

export const tariffDto = (t: Tariff): TariffDto => ({
  id: t.id,
  region: t.region,
  utility: t.utility,
  name: t.name,
  rates: Object.entries(t.rates).map(([key, r]) => ({ key, label: r.label, centsPerKWh: r.centsPerKWh, level: r.level })),
  hasPeakEvents: Boolean(t.peakEventRate),
  source: t.source,
});

/** Energy and money saved so far across the household, against the thermostat left at its daytime setting. */
export function totalSavings(store: Store): SavingsDto {
  const h = store.household();
  const nights = h ? store.rooms(h.id).flatMap((room) => store.nightSummaries(room.id, 2000)) : [];
  const sum = (pick: (n: (typeof nights)[number]) => number): number => round(nights.reduce((total, n) => total + pick(n), 0));
  const usedKWh = sum((n) => n.kWh);
  const baselineKWh = sum((n) => n.baselineKWh);
  const costCents = sum((n) => n.costCents);
  const baselineCostCents = sum((n) => n.baselineCostCents);
  return {
    nights: nights.length,
    savedKWh: round(baselineKWh - usedKWh),
    savedCents: round(baselineCostCents - costCents),
    usedKWh,
    baselineKWh,
    costCents,
    baselineCostCents,
  };
}

export function stateDto(store: Store, live: LiveSessionDto | null): StateDto {
  const h = store.household();
  if (!h) throw new Error('No household has been set up.');
  const outlook = outlookFor(h);
  const rooms = store.rooms(h.id);
  const reportsHumidity = rooms.some((r) => store.devices(r.id)[0]?.reportsHumidity);
  return {
    household: householdDto(h, outlook, reportsHumidity),
    sleepers: store.sleepers(h.id).map((s) => sleeperDto(s, h, outlook)),
    rooms: rooms.map((r) => roomDto(store, r, h, outlook)),
    presets: store.presets(h.id).map(presetDto),
    tariffs: TARIFFS.map(tariffDto),
    climates: Object.values(CLIMATES).map((c) => ({ id: c.id, name: c.name, region: c.region })),
    catalog: CATALOG,
    live,
    savings: totalSavings(store),
    scenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description })),
  };
}

/** A sleeper's recent nights in the form the insight builder wants. */
export function nightRecords(store: Store, sleeper: SleeperRecord, limit = 60): NightRecord[] {
  return store.nightSummaries(sleeper.roomId, limit).flatMap((night) => {
    const mine = night.sleepers.find((x) => x.sleeperId === sleeper.id);
    if (!mine) return [];
    const detail = store.night(night.id);
    const manual = (detail?.events ?? []).filter((e) => e.kind === 'manual');
    const overrideDeltaC = manual.reduce((sum, e) => (e.kind === 'manual' ? sum + (e.targetC - night.coreTargetC) : sum), 0);
    return [
      {
        date: night.date,
        seasonIndex: night.seasonIndex,
        experiencedCoreC: mine.experiencedCoreC,
        thermalQuality: mine.thermalQuality,
        overallQuality: mine.quality,
        humidityPct: night.humidityPct ?? undefined,
        modifiers: mine.modifiers,
        overrides: manual.length,
        overrideDeltaC: manual.length > 0 ? overrideDeltaC : undefined,
        feedback: mine.feedback ?? undefined,
        liveAdjustments: night.liveAdjustments,
        trackingErrorC: night.trackingErrorC,
        energyKWh: night.kWh,
        baselineKWh: night.baselineKWh,
        costCents: night.costCents,
        baselineCostCents: night.baselineCostCents,
      },
    ];
  });
}

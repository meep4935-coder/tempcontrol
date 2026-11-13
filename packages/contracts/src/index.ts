/**
 * The API contract: the shape of everything the server sends and accepts.
 * Types only; no runtime code. The web dashboard and any future mobile app
 * build against this file.
 *
 * Conventions:
 *  - temperatures are degrees Celsius (convert at the display edge);
 *  - instants are epoch milliseconds (`...Ms`, `t`);
 *  - calendar dates are "YYYY-MM-DD" and clock times "HH:MM", both in the
 *    household's time zone.
 */

import type {
  ComfortLimits,
  CyclePhase,
  EnergyChange,
  FeedbackKind,
  HvacMode,
  IdealEstimate,
  Insight,
  JetLagNight,
  LiveReason,
  Locale,
  LocalizedText,
  Modifier,
  NightMetrics,
  Phase,
  PlanSegment,
  PricePeriod,
  RateLevel,
  RecoverySignals,
  RoomResponse,
  RoomSegment,
  SeasonName,
  SleeperOptions,
  Units,
  VoiceIntent,
  VoiceOutcome,
} from '@tempcontrol/engine';

export type {
  ComfortLimits,
  CyclePhase,
  EnergyChange,
  FeedbackKind,
  HvacMode,
  IdealEstimate,
  Insight,
  JetLagNight,
  LiveReason,
  Locale,
  LocalizedText,
  Modifier,
  NightMetrics,
  Phase,
  PlanSegment,
  PricePeriod,
  RateLevel,
  RecoverySignals,
  RoomResponse,
  RoomSegment,
  SeasonName,
  SleeperOptions,
  Units,
  VoiceIntent,
  VoiceOutcome,
};

/* ------------------------------------------------------------------ catalog */

/** How a wearable's data would reach the platform in production. */
export type WearableConnection = 'healthkit' | 'health-connect' | 'cloud-api';

export interface WearableBrand {
  id: string;
  name: string;
  maker: string;
  /**
   * 'live': readings can arrive during the night (needs a companion watch app).
   * 'morning': data arrives once the device syncs after waking.
   */
  delivery: 'live' | 'morning';
  connection: WearableConnection;
}

/** What the room's smart control actually drives. */
export type Equipment = 'central' | 'baseboard' | 'miniSplit' | 'windowAc';

export interface ClimateBrand {
  id: string;
  name: string;
  /** Equipment this brand's thermostats or controllers typically drive. */
  equipment: Equipment[];
  /** 'home': one thermostat for the whole home. 'room': controls a single room. */
  scope: 'home' | 'room';
}

export interface Catalog {
  wearables: WearableBrand[];
  climate: ClimateBrand[];
}

/* ---------------------------------------------------------------- household */

export interface HouseholdDto {
  id: string;
  name: string;
  /** Simulated location (see `ClimateOption`). */
  climateId: string;
  city: string;
  region: string;
  timeZone: string;
  latitude: number;
  /** Demo clock: the evening on which the next night starts. */
  date: string;
  season: SeasonName;
  /** +1 midwinter .. -1 midsummer, as the engine sees tonight. */
  seasonIndex: number;
  /** Tonight's forecast used for planning. */
  /** Humidity is null unless the room's thermostat reports it. */
  outlook: { outdoorC: number; humidityPct: number | null };
  tariffId: string;
  energy: { enabled: boolean; toleranceC: number };
  /** Usual daytime thermostat setting: where the room starts each evening and the baseline for savings. */
  daySetpointC: number;
  /** A utility peak event declared for the coming night's morning or evening, if any. */
  peakEvent: 'morning' | 'evening' | null;
}

export interface ClimateOption {
  id: string;
  name: string;
  region: string;
}

export interface TariffDto {
  id: string;
  region: string;
  utility: LocalizedText;
  name: LocalizedText;
  rates: { key: string; label: LocalizedText; centsPerKWh: number; level: RateLevel }[];
  hasPeakEvents: boolean;
  source: { url: string; verifiedOn: string; note?: string };
}

/* ------------------------------------------------------------------ sleeper */

export interface SleeperDto {
  id: string;
  name: string;
  roomId: string;
  locale: Locale;
  units: Units;
  birthYear: number | null;
  bedtime: string;
  wakeTime: string;
  limits: ComfortLimits;
  options: SleeperOptions;
  cycle: { lastPeriodStart: string | null; lengthDays: number };
  wearable: WearableBrand;
  /** What the model currently believes, for tonight's season. */
  estimate: IdealEstimate;
  /** Learned offsets from the core temperature, in degrees (wake includes the seasonal boost). */
  phaseOffsets: { onset: number; rem: number; wake: number };
  /** Flags the user can set for tonight; cleared after the night. */
  tonight: { alcohol: boolean; highStrain: boolean; illness: boolean };
  /** What tonight's plan will take into account for this sleeper. */
  context: { cyclePhase: CyclePhase | null; recovery: RecoverySignals };
  travel: { shiftHours: number; arrivalDate: string; prepareNights: number } | null;
  /**
   * Demo only: the simulated person's hidden true preference, shown so the
   * viewer can watch the estimate approach it. A real user has no such field.
   */
  demo: { trueIdealC: number; hotFlashes: boolean } | null;
}

export interface SleeperPatch {
  name?: string;
  locale?: Locale;
  units?: Units;
  birthYear?: number | null;
  bedtime?: string;
  wakeTime?: string;
  limits?: ComfortLimits;
  options?: Partial<SleeperOptions>;
  cycle?: { lastPeriodStart: string | null; lengthDays?: number };
  tonight?: Partial<SleeperDto['tonight']>;
  /** Catalog id of a wearable brand. */
  wearableBrand?: string;
}

/* --------------------------------------------------------------------- room */

/**
 * The room's one climate device: a smart thermostat or smart AC control.
 * The platform assumes nothing else in the room (no fans, no humidifiers).
 */
export interface DeviceDto {
  id: string;
  roomId: string;
  /** Catalog id of the brand. */
  brand: string;
  name: string;
  equipment: Equipment;
  /** Whether this thermostat reports room humidity. Without it, humidity plays no part anywhere. */
  reportsHumidity: boolean;
}

export interface NewDevice {
  brand: string;
  name?: string;
  equipment?: Equipment;
  reportsHumidity?: boolean;
}

export interface HoldDto {
  targetC: number;
  source: 'app' | 'voice' | 'device' | 'preset';
  /** Minutes the hold lasts once it starts; null means until morning. */
  minutes: number | null;
  sleeperId?: string;
  presetName?: string;
}

export interface RoomDto {
  id: string;
  name: string;
  sleeperIds: string[];
  /** At most one: the room's thermostat. */
  devices: DeviceDto[];
  /** Last known conditions. Humidity is null unless the thermostat reports it. */
  climate: { tempC: number; humidityPct: number | null; mode: HvacMode };
  response: RoomResponse;
  /** A manual temperature waiting to take effect (or in effect during a live night). */
  hold: HoldDto | null;
  /**
   * The preset the room runs on, night after night, instead of the automatic
   * schedule. Null means automatic (the recommended setting).
   */
  activePresetId: string | null;
}

export interface PresetDto {
  id: string;
  name: string;
  /** 'hold': one fixed temperature. 'curve': a temperature per part of the night. */
  kind: 'hold' | 'curve';
  targetC?: number;
  temps?: { onset: number; deep: number; rem: number; wake: number };
}

export type NewPreset = Omit<PresetDto, 'id'>;

/* --------------------------------------------------------------------- plan */

export interface SleeperPlanDto {
  sleeperId: string;
  bedtimeMs: number;
  wakeMs: number;
  idealC: number;
  idealSdC: number;
  confidence: number;
  /** Deliberate half-degree test variation tonight; 0 when not exploring. */
  explorationC: number;
  /** Tonight's adjustments and why (humidity, cycle, recovery...). */
  modifiers: Modifier[];
  /** What this sleeper's own plan asks for, before blending with a partner. */
  segments: PlanSegment[];
}

export interface PlanDto {
  roomId: string;
  date: string;
  kind: 'night' | 'nap';
  startMs: number;
  endMs: number;
  /** The schedule the thermostat will follow. Each segment lists every sleeper's contribution. */
  segments: RoomSegment[];
  sleepers: SleeperPlanDto[];
  /** Difference between partners' ideal temperatures; 0 for one sleeper. */
  gapC: number;
  limits: ComfortLimits;
  context: { outdoorC: number; humidityPct: number | null; seasonIndex: number; season: SeasonName; mode: HvacMode };
  energy: {
    enabled: boolean;
    direction: 'heat' | 'cool' | 'none';
    toleranceC: number;
    /** Price of electricity across the night. */
    periods: PricePeriod[];
    /** How the plan was reshaped around prices; empty when it was not. */
    changes: EnergyChange[];
  };
  /** The manual temperature that will override this plan for tonight, if one is set. */
  hold: HoldDto | null;
  /** Name of the preset this plan follows instead of the automatic schedule, if any. */
  presetName: string | null;
}

/* ------------------------------------------------------------------- nights */

export interface TickDto {
  t: number;
  roomTempC: number;
  /** Setpoint the thermostat was following; null when the platform was not in control. */
  setpointC: number | null;
  /** What the plan alone asked for. */
  plannedC: number | null;
  source: 'plan' | 'hold' | 'idle';
  phase: Phase | null;
  liveOffsetC: number;
  outdoorC: number;
  /** Null unless the thermostat reports humidity. */
  humidityPct: number | null;
  running: 'heat' | 'cool' | 'idle';
  kWh: number;
  /** Live readings, only for sleepers whose wearable reports during the night. */
  vitals: Record<string, { heartRate?: number; movement?: number; skinTempDeltaC?: number }>;
}

export type EventDto =
  /** The live controller nudged the room (or began / ended a hot-flash response). */
  | { t: number; kind: 'live'; reason: LiveReason; deltaC: number; offsetC: number; sleeperId?: string }
  /** Someone set the temperature by hand. */
  | { t: number; kind: 'manual'; source: HoldDto['source']; targetC: number; sleeperId?: string; presetName?: string }
  /** A manual temperature ended and the plan resumed. */
  | { t: number; kind: 'resume' }
  /** Someone said how they felt (voice or app) during the night. */
  | { t: number; kind: 'feeling'; feeling: FeedbackKind; sleeperId: string }
  /** The plan was shifted around electricity prices. */
  | { t: number; kind: 'energy'; change: EnergyChange['kind']; deltaC: number; peakEvent: boolean }
  /** The night was ended early ("good morning"). */
  | { t: number; kind: 'wake' };

export interface SleeperNightDto {
  sleeperId: string;
  /** 0..100 headline score; null if the wearable reported nothing. */
  quality: number | null;
  /** 0..100 score weighted toward what temperature affects; what the model learns from. */
  thermalQuality: number | null;
  /** Deep-sleep-equivalent temperature this sleeper experienced. */
  experiencedCoreC: number | null;
  /** The model's estimate after learning from this night. */
  estimateC: number;
  sdC: number;
  confidence: number;
  feedback: FeedbackKind | null;
  metrics: NightMetrics | null;
  modifiers: Modifier['id'][];
  /** Whether this night's sleep outcome was used for learning (not on ill or alcohol nights). */
  outcomeUsed: boolean;
}

export interface NightSummaryDto {
  id: string;
  roomId: string;
  date: string;
  kind: 'night' | 'nap';
  startMs: number;
  endMs: number;
  outdoorC: number;
  /** Null unless the thermostat reports humidity. */
  humidityPct: number | null;
  seasonIndex: number;
  /** Deep-sleep target of the room plan. */
  coreTargetC: number;
  /** Average room temperature while anyone was asleep. */
  avgRoomTempC: number;
  /** Average of (room - setpoint) while asleep; positive means the room ran warmer than asked. */
  trackingErrorC: number;
  kWh: number;
  /** Energy the room would have used left at the daytime setting all night. */
  baselineKWh: number;
  costCents: number;
  baselineCostCents: number;
  liveAdjustments: number;
  manualChanges: number;
  sleepers: SleeperNightDto[];
}

export interface NightDetailDto extends NightSummaryDto {
  plan: PlanDto;
  /** One entry every five simulated minutes. */
  trace: TickDto[];
  events: EventDto[];
}

/* --------------------------------------------------------------------- live */

export interface LiveSessionDto {
  id: string;
  roomId: string;
  date: string;
  status: 'running' | 'finished';
  /** The session's simulated clock. */
  clockMs: number;
  startMs: number;
  endMs: number;
  /** Ticks produced so far. */
  ticks: number;
  /** Real seconds a whole night takes to play. */
  secondsPerNight: number;
  /** Set once the night has finished and been saved. */
  nightId: string | null;
}

export interface LiveUpdateDto {
  session: LiveSessionDto | null;
  /** Present whenever a session exists. */
  plan: PlanDto | null;
  /** Ticks after the `since` cursor. */
  ticks: TickDto[];
  /** Every event so far this session. */
  events: EventDto[];
  /** The manual temperature in force right now, if any. */
  hold: HoldDto | null;
}

/* -------------------------------------------------------------------- state */

export interface StateDto {
  household: HouseholdDto;
  sleepers: SleeperDto[];
  rooms: RoomDto[];
  presets: PresetDto[];
  tariffs: TariffDto[];
  climates: ClimateOption[];
  catalog: Catalog;
  live: LiveSessionDto | null;
  /** Energy and money saved so far, against the thermostat left at its daytime setting every night. */
  savings: SavingsDto;
  /** Names of the built-in demo scenarios accepted by POST /api/sim/reset. */
  scenarios: { id: string; name: LocalizedText; description: LocalizedText }[];
}

export interface SavingsDto {
  /** Nights counted. */
  nights: number;
  /** Positive means less was used than the baseline; negative means more. */
  savedKWh: number;
  savedCents: number;
  usedKWh: number;
  baselineKWh: number;
  costCents: number;
  baselineCostCents: number;
}

/* ----------------------------------------------------------- recommendation */

/** One sleeper's part of the morning recommendation: what their data suggest. */
export interface SleeperFindingDto {
  sleeperId: string;
  /** The ideal deep-sleep temperature the data point to, and how sure that is. */
  idealC: number;
  sdC: number;
  confidence: number;
  nights: number;
  /** Last night, if there was one. */
  lastNight: { experiencedCoreC: number | null; quality: number | null; thermalQuality: number | null } | null;
  /** Supporting observations, most relevant first. Render with `describeInsight`. */
  insights: Insight[];
}

export interface ScheduleStepDto {
  phase: Phase;
  startMs: number;
  endMs: number;
  targetC: number;
}

/**
 * The morning recommendation: "your data suggest X, so we recommend Y".
 * The recommended setting is always the platform's automatic schedule. The
 * user either applies it or carries on with their preset.
 */
export interface RecommendationDto {
  roomId: string;
  /** The coming night this recommendation is for. */
  date: string;
  /** The night it is based on; null before the first night. */
  basedOnNightId: string | null;
  /** What the room is running on now. */
  mode: 'auto' | 'preset';
  presetName: string | null;
  findings: SleeperFindingDto[];
  /** The automatic schedule for tonight. */
  recommended: ScheduleStepDto[];
  /** What tonight would be on the current preset; null when already automatic. */
  current: ScheduleStepDto[] | null;
  /** Recommended deep-sleep temperature minus the preset's; 0 when already automatic. */
  deepDifferenceC: number;
  /**
   * 'pending': not answered yet for this date. 'applied': the user chose the
   * recommended setting. 'kept': the user chose to stay on their preset.
   */
  status: 'pending' | 'applied' | 'kept';
}

export interface RecommendationAnswer {
  action: 'apply' | 'keep';
}

export interface HouseholdPatch {
  climateId?: string;
  tariffId?: string;
  energy?: Partial<HouseholdDto['energy']>;
  daySetpointC?: number;
  peakEvent?: HouseholdDto['peakEvent'];
}

/* ------------------------------------------------------------------ actions */

export interface HoldRequest {
  targetC: number;
  /** Omit or null for "until morning". */
  minutes?: number | null;
  sleeperId?: string;
}

export interface AdvanceRequest {
  /** 1..120 */
  nights: number;
}

export interface AdvanceResponse {
  nights: NightSummaryDto[];
  state: StateDto;
}

export interface LiveStartRequest {
  roomId: string;
  /** Real seconds for the whole night; default 90. */
  secondsPerNight?: number;
}

export interface FeedbackRequest {
  nightId: string;
  sleeperId: string;
  kind: FeedbackKind;
}

export interface VoiceRequest {
  text: string;
  sleeperId: string;
}

export interface VoiceResponse {
  intent: VoiceIntent;
  confidence: number;
  outcome: VoiceOutcome;
  /** Sentence to speak or show, in the sleeper's language and units. */
  reply: string;
}

export interface NapRequest {
  sleeperId: string;
  minutes: number;
}

export interface JetLagRequest {
  shiftHours: number;
  arrivalDate: string;
  prepareNights?: number;
}

export interface AssistantRequest {
  sleeperId: string;
  message: string;
}

/**
 * POST /api/assistant answers with plain JSON. The assistant is the platform's
 * own: it runs on the server, uses no outside AI service, and answers only
 * about sleep temperature and this sleeper's data, in the sleeper's language.
 */
export interface AssistantReplyDto {
  /** What the question was understood to be about ("unknown" when it was not understood). */
  topic: string;
  text: string;
  /** Questions the user might ask next, in the sleeper's language. */
  followUps: string[];
}

export interface ApiError {
  error: string;
  message: string;
}

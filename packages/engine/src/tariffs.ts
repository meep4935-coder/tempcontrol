/**
 * Residential electricity price schedules for Canadian utilities.
 *
 * IMPORTANT: these are residential ENERGY (commodity) prices as of each tariff's
 * `source.verifiedOn` date. Delivery, regulatory and fixed charges, taxes and
 * rebates are NOT included unless a note says so. Prices change at least once a
 * year (Ontario RPP prices on 1 November and sometimes 1 May; Hydro-Quebec on
 * 1 April; BC Hydro on 1 April). Every figure here must be re-verified against
 * the utility or regulator before launch and kept current afterwards, ideally
 * from an API or a scheduled review, not by hand when someone remembers.
 *
 * Most figures were checked through search-result excerpts of the cited pages,
 * because the utility sites could not be fetched directly from the environment
 * where this file was written. Each `source.note` says what is and is not
 * confirmed.
 *
 * Statutory holidays: Ontario time-of-use and ultra-low overnight plans bill
 * statutory holidays like weekends (off-peak / weekend off-peak). No holiday
 * calendar is hard-coded here; callers pass holiday dates to `rateKeyAt` /
 * `pricePeriods`, which treat them as `days: 'weekend'`.
 */

import type { Tariff } from './energy';

const WINTER_ON = [11, 12, 1, 2, 3, 4];
const SUMMER_ON = [5, 6, 7, 8, 9, 10];
/** Hydro-Quebec's winter period for peak events: 1 December to 31 March. */
const WINTER_QC = [12, 1, 2, 3];
/** Hours during which Hydro-Quebec can call peak events (06:00-10:00 and 16:00-20:00). */
const QC_EVENT_WINDOWS = [
  { months: WINTER_QC, fromHour: 6, toHour: 10 },
  { months: WINTER_QC, fromHour: 16, toHour: 20 },
];

const OEB_NOTE_COMMON =
  'Regulated Price Plan commodity price only. Excludes delivery, regulatory charges, HST and the Ontario Electricity Rebate (15.7% of the pre-tax bill from 1 Nov 2026, down from 23.5%). ' +
  'Prices in force 1 Nov 2026 to 31 Oct 2027 (subject to OEB review). Statutory holidays are billed like weekends.';

/** Rate D first-tier energy price, Hydro-Quebec, effective 1 April 2026. */
const QC_D_TIER1 = 7.065;
/** Winter Credit Option credit for Rate D, per kWh curtailed during an event, effective 1 April 2026. */
const QC_WINTER_CREDIT = 58.49;

export const TARIFFS: readonly Tariff[] = [
  {
    id: 'on-tou',
    region: 'ON',
    utility: {
      en: 'Ontario Regulated Price Plan (all local utilities)',
      fr: "Grille tarifaire réglementée de l'Ontario (tous les distributeurs locaux)",
    },
    name: { en: 'Time-of-Use', fr: "Prix selon l'heure de consommation" },
    rates: {
      offPeak: { label: { en: 'Off-peak', fr: 'Heures creuses' }, centsPerKWh: 9.1, level: 'low' },
      midPeak: { label: { en: 'Mid-peak', fr: 'Période intermédiaire' }, centsPerKWh: 14.6, level: 'mid' },
      onPeak: { label: { en: 'On-peak', fr: 'Heures de pointe' }, centsPerKWh: 18.9, level: 'high' },
    },
    rules: [
      { days: 'weekend', fromHour: 0, toHour: 24, rate: 'offPeak' },
      // Winter (1 Nov - 30 Apr) weekdays.
      { months: WINTER_ON, days: 'weekday', fromHour: 7, toHour: 11, rate: 'onPeak' },
      { months: WINTER_ON, days: 'weekday', fromHour: 11, toHour: 17, rate: 'midPeak' },
      { months: WINTER_ON, days: 'weekday', fromHour: 17, toHour: 19, rate: 'onPeak' },
      // Summer (1 May - 31 Oct) weekdays.
      { months: SUMMER_ON, days: 'weekday', fromHour: 7, toHour: 11, rate: 'midPeak' },
      { months: SUMMER_ON, days: 'weekday', fromHour: 11, toHour: 17, rate: 'onPeak' },
      { months: SUMMER_ON, days: 'weekday', fromHour: 17, toHour: 19, rate: 'midPeak' },
    ],
    // Weekdays 19:00-07:00 all year.
    fallbackRate: 'offPeak',
    source: {
      url: 'https://www.oeb.ca/newsroom/2026/ontario-energy-board-announces-changes-electricity-prices-households-small-businesses',
      verifiedOn: '2026-11-13',
      note:
        OEB_NOTE_COMMON +
        ' 9.1 / 14.6 / 18.9 c/kWh (previous term 9.8 / 15.7 / 20.3) confirmed from search excerpts of the OEB announcement and OEB historical-rates page, cross-checked with Hydro One and news reports; the OEB page itself could not be fetched. ' +
        'Winter weekday windows confirmed in the OEB excerpt; summer windows (on-peak 11-17, mid-peak 7-11 and 17-19) are the long-standing OEB schedule and were not re-read from a primary page this time.',
    },
  },
  {
    id: 'on-ulo',
    region: 'ON',
    utility: {
      en: 'Ontario Regulated Price Plan (participating local utilities)',
      fr: "Grille tarifaire réglementée de l'Ontario (distributeurs locaux participants)",
    },
    name: { en: 'Ultra-Low Overnight', fr: 'Tarif de nuit ultra-bas' },
    rates: {
      ultraLow: { label: { en: 'Ultra-low overnight', fr: 'Tarif de nuit ultra-bas' }, centsPerKWh: 3.7, level: 'low' },
      weekendOffPeak: {
        label: { en: 'Weekend off-peak', fr: 'Heures creuses de fin de semaine' },
        centsPerKWh: 9.1,
        level: 'low',
      },
      midPeak: { label: { en: 'Mid-peak', fr: 'Période intermédiaire' }, centsPerKWh: 14.6, level: 'mid' },
      onPeak: { label: { en: 'On-peak', fr: 'Heures de pointe' }, centsPerKWh: 37.7, level: 'high' },
    },
    rules: [
      { fromHour: 23, toHour: 7, rate: 'ultraLow' }, // every day, all year
      { days: 'weekend', fromHour: 7, toHour: 23, rate: 'weekendOffPeak' },
      { days: 'weekday', fromHour: 16, toHour: 21, rate: 'onPeak' },
      { days: 'weekday', fromHour: 7, toHour: 16, rate: 'midPeak' },
      { days: 'weekday', fromHour: 21, toHour: 23, rate: 'midPeak' },
    ],
    fallbackRate: 'midPeak',
    source: {
      url: 'https://www.oeb.ca/newsroom/2026/ontario-energy-board-announces-changes-electricity-prices-households-small-businesses',
      verifiedOn: '2026-11-13',
      note:
        OEB_NOTE_COMMON +
        ' 3.7 / 9.1 / 14.6 / 37.7 c/kWh (previous term 3.9 / 9.8 / 15.7 / 39.1) confirmed from search excerpts of the OEB historical-rates table, cross-checked with London Hydro and CP24; not read from a fetched primary page. ' +
        'Windows (same all year): ultra-low 23-7 every day; weekend/holiday off-peak 7-23; weekday mid-peak 7-16 and 21-23; weekday on-peak 16-21 (per OEB ULO report and Hydro Ottawa excerpts). Not every Ontario utility offers ULO.',
    },
  },
  {
    id: 'on-tiered',
    region: 'ON',
    utility: {
      en: 'Ontario Regulated Price Plan (all local utilities)',
      fr: "Grille tarifaire réglementée de l'Ontario (tous les distributeurs locaux)",
    },
    name: { en: 'Tiered', fr: 'Prix par paliers' },
    rates: {
      tier1: { label: { en: 'Tier 1', fr: 'Palier 1' }, centsPerKWh: 11.2, level: 'mid' },
    },
    rules: [],
    fallbackRate: 'tier1',
    source: {
      url: 'https://www.oeb.ca/consumer-information-and-protection/electricity-rates',
      verifiedOn: '2026-11-13',
      note:
        OEB_NOTE_COMMON +
        ' Price does not vary by hour. Encoded as the Tier 1 price, 11.2 c/kWh, which applies to the first 1,000 kWh per month for residential customers in winter (1 Nov - 30 Apr) and the first 600 kWh per month in summer (1 May - 31 Oct); ' +
        'use above the threshold costs 13.2 c/kWh (Tier 2), which is not modelled. Figures confirmed from search excerpts of OEB pages, Toronto Hydro and Entegrus; not read from a fetched primary page.',
    },
  },
  {
    id: 'qc-d',
    region: 'QC',
    utility: { en: 'Hydro-Québec', fr: 'Hydro-Québec' },
    name: { en: 'Rate D', fr: 'Tarif D' },
    rates: {
      base: {
        label: { en: 'Base price (first tier)', fr: 'Prix de base (première tranche)' },
        centsPerKWh: QC_D_TIER1,
        level: 'low',
      },
    },
    rules: [],
    fallbackRate: 'base',
    source: {
      url: 'https://www.hydroquebec.com/data/documents-donnees/pdf/electricity-rates.pdf',
      verifiedOn: '2026-11-13',
      note:
        'Energy price only, effective 1 April 2026 (next change expected 1 April 2027). Excludes the daily system access charge, GST and QST. ' +
        'Rate D is tiered by daily consumption, not by hour: 7.065 c/kWh applies to energy up to 40 kWh per day (times the days in the billing period); energy above that is billed at a higher second-tier price, not modelled. ' +
        'The 7.065 c figure (up 2.3% from 6.905 c) was confirmed from search excerpts of the official Hydro-Quebec rate PDF (EN and FR) and the 2026 rates chart; the PDF itself could not be fetched. ' +
        'The second-tier price is UNVERIFIED (third-party sites say 11.142 c/kWh; one says about 10.80 c).',
    },
  },
  {
    id: 'qc-flex-d',
    region: 'QC',
    utility: { en: 'Hydro-Québec', fr: 'Hydro-Québec' },
    name: { en: 'Rate Flex D', fr: 'Tarif Flex D' },
    rates: {
      winter: {
        label: { en: 'Winter, outside events (first tier)', fr: 'Hiver, hors événement (première tranche)' },
        centsPerKWh: 4.886,
        level: 'low',
      },
      base: {
        label: { en: 'Base price, rest of year (first tier)', fr: "Prix de base, reste de l'année (première tranche)" },
        centsPerKWh: QC_D_TIER1,
        level: 'mid',
      },
      peakEvent: {
        label: { en: 'Peak event', fr: 'Événement de pointe' },
        centsPerKWh: 46.463,
        level: 'critical',
      },
    },
    rules: [{ months: WINTER_QC, fromHour: 0, toHour: 24, rate: 'winter' }],
    fallbackRate: 'base',
    peakEventRate: 'peakEvent',
    peakEventWindows: QC_EVENT_WINDOWS,
    source: {
      url: 'https://www.hydroquebec.com/data/documents-donnees/pdf/electricity-rates.pdf',
      verifiedOn: '2026-11-13',
      note:
        'Energy price only, effective 1 April 2026. Excludes the daily system access charge, GST and QST. ' +
        'Winter period 1 Dec - 31 Mar: outside events 4.886 c/kWh for the first 40 kWh per day (9.103 c/kWh above that, not modelled); during declared peak events 46.463 c/kWh for all energy. ' +
        'Rest of the year Rate D prices apply (encoded as the Rate D first tier, 7.065 c). Events are announced the day before, can be called 06:00-10:00 and 16:00-20:00, ' +
        'at most 2 per day, up to 30 events / 120 hours per winter. ' +
        'Prices 4.886 / 9.103 / 46.463 were confirmed only from third-party guides (Atlas Quebec, STM Electrique, Callmepower) that cite the 1 April 2026 Hydro-Quebec rate document; not read from the primary PDF. ' +
        'Event windows: third-party sources and an excerpt of an older Hydro-Quebec dynamic-pricing page say 6-10 and 16-20; some older material says the morning window is 6-9. Re-check against the official rate document.',
    },
  },
  {
    id: 'qc-winter-credit',
    region: 'QC',
    utility: { en: 'Hydro-Québec', fr: 'Hydro-Québec' },
    name: { en: 'Rate D with Winter Credit Option', fr: 'Tarif D avec option de crédit hivernal' },
    rates: {
      base: {
        label: { en: 'Base price (first tier)', fr: 'Prix de base (première tranche)' },
        centsPerKWh: QC_D_TIER1,
        level: 'low',
      },
      peakEvent: {
        label: { en: 'Peak event (value of a kWh avoided)', fr: "Événement de pointe (valeur d'un kWh évité)" },
        // Rate D price plus the credit for each kWh curtailed: what avoiding one kWh during an event is worth.
        centsPerKWh: Math.round((QC_D_TIER1 + QC_WINTER_CREDIT) * 1000) / 1000,
        level: 'critical',
      },
    },
    rules: [],
    fallbackRate: 'base',
    peakEventRate: 'peakEvent',
    peakEventWindows: QC_EVENT_WINDOWS,
    source: {
      url: 'https://www.hydroquebec.com/data/documents-donnees/pdf/electricity-rates.pdf',
      verifiedOn: '2026-11-13',
      note:
        'Rate D energy price (7.065 c/kWh first tier, excludes access charge and taxes) plus a credit of 58.490 c per kWh curtailed during declared peak events (1 Dec - 31 Mar), effective 1 April 2026. ' +
        'There is no higher price during events, only a credit. MODELLING CHOICE: the peak-event rate is Rate D plus the credit (65.555 c/kWh), the effective value of a kWh avoided during an event; it is not a price the customer is billed. ' +
        'The 58.490 c credit was confirmed from a search excerpt of the official 1 April 2026 rate PDF and is consistent with 56.786 c in 2025 (+3%); one third-party guide also shows 60.186 c, unexplained. ' +
        'The option is closed to new enrolment (customers enrolled on 31 March 2026 keep it under an acquired right). Event windows as for Flex D (06:00-10:00 and 16:00-20:00), not confirmed from a primary page for this option.',
    },
  },
  {
    id: 'bc-tod',
    region: 'BC',
    utility: { en: 'BC Hydro', fr: 'BC Hydro' },
    name: { en: 'Optional time-of-day pricing', fr: "Tarification optionnelle selon l'heure de la journée" },
    rates: {
      overnight: {
        label: { en: 'Overnight discount', fr: 'Rabais de nuit' },
        centsPerKWh: 6.87,
        level: 'low',
      },
      base: { label: { en: 'Base rate', fr: 'Tarif de base' }, centsPerKWh: 11.87, level: 'mid' },
      onPeak: {
        label: { en: 'On-peak surcharge', fr: 'Supplément en heures de pointe' },
        centsPerKWh: 16.87,
        level: 'high',
      },
    },
    rules: [
      { fromHour: 23, toHour: 7, rate: 'overnight' },
      { fromHour: 16, toHour: 21, rate: 'onPeak' },
    ],
    fallbackRate: 'base',
    source: {
      url: 'https://www.bchydro.com/news/conservation/2026/thinking-about-time-of-day-pricing.html',
      verifiedOn: '2026-11-13',
      note:
        'Optional add-on to the residential tiered (or flat) rate: 5 c/kWh discount 23:00-07:00 and 5 c/kWh surcharge 16:00-21:00, base price at other hours; confirmed from search excerpts of BC Hydro pages, applied every day. ' +
        'Energy charge only; excludes the basic charge, riders, GST and PST. ' +
        'The BASE PRICE IS UNVERIFIED: 11.87 c/kWh is the Step 1 (tiered) energy charge most often cited, but sources disagree (11.72, 10.97, 12.63 for the flat rate) and none confirmed the 1 April 2026 figure from BC Hydro or the BCUC. ' +
        'Step 2 (14.08 c, above about 22.19 kWh/day) is not modelled. Only the +/-5 c differential should be relied on until the base is re-verified.',
    },
  },
];

const BY_ID = new Map(TARIFFS.map((t) => [t.id, t]));

export function getTariff(id: string): Tariff | undefined {
  return BY_ID.get(id);
}

/** Tariffs offered in a province or territory (e.g. "ON", "QC"); case-insensitive. */
export function tariffsForRegion(region: string): Tariff[] {
  const r = region.trim().toUpperCase();
  return TARIFFS.filter((t) => t.region === r);
}

/** A generic single-price tariff for users whose utility is not listed. */
export function flatTariff(centsPerKWh: number): Tariff {
  if (!Number.isFinite(centsPerKWh) || centsPerKWh < 0) {
    throw new RangeError(`flatTariff: invalid price ${centsPerKWh}`);
  }
  return {
    id: 'flat',
    region: 'CA',
    utility: { en: 'Other utility', fr: 'Autre distributeur' },
    name: { en: 'Flat rate', fr: 'Tarif unique' },
    rates: { flat: { label: { en: 'Flat rate', fr: 'Tarif unique' }, centsPerKWh, level: 'mid' } },
    rules: [],
    fallbackRate: 'flat',
    source: {
      url: '',
      verifiedOn: new Date().toISOString().slice(0, 10),
      note: 'Price entered by the user; not verified.',
    },
  };
}

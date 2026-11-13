/**
 * Insights as sentences, in English and French. Used wherever an insight has
 * to be read rather than drawn: the assistant's replies, notifications, and
 * as a ready-made fallback for any screen.
 */

import type { Insight } from './insights';
import type { Locale, Units } from './types';
import { cToF } from './util';

export interface TextOptions {
  locale: Locale;
  units: Units;
}

/** A temperature for display: "18.5 °C" / "18,5 °C" / "65 °F". */
export function formatTemp(tempC: number, { locale, units }: TextOptions): string {
  const space = locale === 'fr' ? '\u00a0' : ' ';
  if (units === 'F') return `${Math.round(cToF(tempC))}${space}°F`;
  const rounded = Math.round(tempC * 2) / 2;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${locale === 'fr' ? text.replace('.', ',') : text}${space}°C`;
}

/** A temperature difference for display: "0.5 °C" / "1 °F". Never negative. */
export function formatDelta(deltaC: number, { locale, units }: TextOptions): string {
  const space = locale === 'fr' ? '\u00a0' : ' ';
  if (units === 'F') return `${Math.max(1, Math.round((Math.abs(deltaC) * 9) / 5))}${space}°F`;
  const text = String(Math.round(Math.abs(deltaC) * 10) / 10);
  return `${locale === 'fr' ? text.replace('.', ',') : text}${space}°C`;
}

const number = (v: number, locale: Locale): string => {
  const text = String(Math.round(v * 10) / 10);
  return locale === 'fr' ? text.replace('.', ',') : text;
};

const dollars = (cents: number, locale: Locale): string => {
  const amount = (Math.abs(cents) / 100).toFixed(2);
  return locale === 'fr' ? `${amount.replace('.', ',')}\u00a0$` : `$${amount}`;
};

export function describeInsight(insight: Insight, opts: TextOptions): string {
  const fr = opts.locale === 'fr';
  const temp = (c: number): string => formatTemp(c, opts);
  const delta = (c: number): string => formatDelta(c, opts);
  const n = (v: number): string => number(v, opts.locale);
  const percent = (fraction: number): string => `${Math.round(fraction * 100)}${fr ? '\u00a0' : ''}%`;

  switch (insight.id) {
    case 'learning':
      return fr
        ? `Calibrage en cours : ${insight.nights} nuit${insight.nights === 1 ? '' : 's'} analysée${insight.nights === 1 ? '' : 's'}, personnalisation à ${percent(insight.confidence)}. Pendant cette période, la température varie d'un demi-degré d'une nuit à l'autre pour repérer ce qui vous convient le mieux.`
        : `Still calibrating: ${insight.nights} night${insight.nights === 1 ? '' : 's'} analysed, ${percent(insight.confidence)} personalised. During this period the temperature varies by half a degree from night to night to find what suits you best.`;
    case 'ideal':
      return fr
        ? `Votre température idéale de sommeil profond est estimée à ${temp(insight.coreC)} (probablement entre ${temp(insight.lowC)} et ${temp(insight.highC)}).`
        : `Your ideal deep-sleep temperature is estimated at ${temp(insight.coreC)} (most likely between ${temp(insight.lowC)} and ${temp(insight.highC)}).`;
    case 'bestBand':
      return fr
        ? `Vos nuits entre ${temp(insight.lowC)} et ${temp(insight.highC)} ont obtenu ${n(insight.gain)} points de plus que les autres (${insight.nightsIn} nuits contre ${insight.nightsOut}).`
        : `Your nights between ${temp(insight.lowC)} and ${temp(insight.highC)} scored ${n(insight.gain)} points higher than the rest (${insight.nightsIn} nights against ${insight.nightsOut}).`;
    case 'seasonShift':
      return insight.shiftC > 0
        ? fr
          ? `En hiver, vous dormez mieux dans une chambre plus chaude d'environ ${delta(insight.shiftC)} que le reste de l'année.`
          : `In winter you sleep better about ${delta(insight.shiftC)} warmer than during the rest of the year.`
        : fr
          ? `En hiver, vous dormez mieux dans une chambre plus fraîche d'environ ${delta(insight.shiftC)} que le reste de l'année.`
          : `In winter you sleep better about ${delta(insight.shiftC)} cooler than during the rest of the year.`;
    case 'humidNights':
      return fr
        ? `Les ${insight.nights} nuits humides (environ ${insight.averagePct}\u00a0% d'humidité) ont obtenu ${n(insight.drop)} points de moins. Ces nuits-là, le plan garde la chambre un peu plus fraîche.`
        : `The ${insight.nights} humid nights (around ${insight.averagePct}% humidity) scored ${n(insight.drop)} points lower. On those nights the plan keeps the room a little cooler.`;
    case 'overrides':
      return insight.direction === 'warmer'
        ? fr
          ? `Vous avez augmenté la température ${insight.count} nuits récemment. Le plan en tient compte et se réchauffe.`
          : `You turned the temperature up on ${insight.count} recent nights. The plan has taken that on board and is running warmer.`
        : fr
          ? `Vous avez baissé la température ${insight.count} nuits récemment. Le plan en tient compte et se rafraîchit.`
          : `You turned the temperature down on ${insight.count} recent nights. The plan has taken that on board and is running cooler.`;
    case 'trend':
      return insight.delta > 0
        ? fr
          ? `Votre sommeil s'est amélioré de ${n(insight.delta)} points sur les ${insight.nights} dernières nuits par rapport aux précédentes.`
          : `Your sleep has improved by ${n(insight.delta)} points over the last ${insight.nights} nights compared with the ones before.`
        : fr
          ? `Votre sommeil a reculé de ${n(Math.abs(insight.delta))} points sur les ${insight.nights} dernières nuits par rapport aux précédentes.`
          : `Your sleep has dropped by ${n(Math.abs(insight.delta))} points over the last ${insight.nights} nights compared with the ones before.`;
    case 'cannotReach':
      return insight.direction === 'cooler'
        ? fr
          ? `Sur ${insight.nights} nuits récentes, la chambre est restée environ ${delta(insight.shortfallC)} au-dessus de la température demandée. Le climatiseur peine peut-être à suivre, ou il n'est pas en mode refroidissement.`
          : `On ${insight.nights} recent nights the room stayed about ${delta(insight.shortfallC)} above the temperature asked for. The air conditioning may be struggling to keep up, or may not be in cooling mode.`
        : fr
          ? `Sur ${insight.nights} nuits récentes, la chambre est restée environ ${delta(insight.shortfallC)} sous la température demandée. Le chauffage peine peut-être à suivre.`
          : `On ${insight.nights} recent nights the room stayed about ${delta(insight.shortfallC)} below the temperature asked for. The heating may be struggling to keep up.`;
    case 'liveAdjustments':
      return fr
        ? `La chambre a été ajustée ${insight.count} fois en pleine nuit au cours des ${insight.nights} dernières nuits, en réaction aux signaux de votre montre.`
        : `The room was adjusted ${insight.count} times mid-night over the last ${insight.nights} nights in response to what your watch reported.`;
    case 'energy':
      return insight.savedKWh >= 0
        ? fr
          ? `Sur ${insight.nights} nuits, la chambre a consommé environ ${n(insight.savedKWh)}\u00a0kWh de moins qu'avec le thermostat laissé à son réglage de jour, soit environ ${dollars(insight.savedCents, 'fr')}.`
          : `Over ${insight.nights} nights the room used about ${n(insight.savedKWh)} kWh less than with the thermostat left at its daytime setting, about ${dollars(insight.savedCents, 'en')}.`
        : fr
          ? `Sur ${insight.nights} nuits, la chambre a consommé environ ${n(-insight.savedKWh)}\u00a0kWh de plus qu'avec le thermostat laissé à son réglage de jour (${dollars(insight.savedCents, 'fr')}) : les températures qui conviennent à votre sommeil ont demandé un peu plus d'énergie sur cette période.`
          : `Over ${insight.nights} nights the room used about ${n(-insight.savedKWh)} kWh more than with the thermostat left at its daytime setting (${dollars(insight.savedCents, 'en')}): the temperatures that suit your sleep took a little more energy over this period.`;
  }
}

/**
 * The devices the platform is designed to work with: a wearable per sleeper
 * and one smart thermostat or smart AC control per bedroom. Nothing else is assumed.
 *
 * In this build every one of them is simulated: picking "Nest" or "Oura"
 * creates a simulated device with that brand's characteristics. Real
 * connections plug in behind the interfaces in `environment.ts`.
 */

import type { Catalog, ClimateBrand, WearableBrand } from '@tempcontrol/contracts';

export const WEARABLES: WearableBrand[] = [
  // Watches can run a companion app that reports through the night.
  { id: 'apple-watch', name: 'Apple Watch', maker: 'Apple', delivery: 'live', connection: 'healthkit' },
  { id: 'galaxy-watch', name: 'Galaxy Watch', maker: 'Samsung', delivery: 'live', connection: 'health-connect' },
  { id: 'pixel-watch', name: 'Pixel Watch', maker: 'Google', delivery: 'live', connection: 'health-connect' },
  // Rings and bands upload after the night, once they sync.
  { id: 'oura', name: 'Oura Ring', maker: 'Oura', delivery: 'morning', connection: 'cloud-api' },
  { id: 'whoop', name: 'WHOOP', maker: 'WHOOP', delivery: 'morning', connection: 'cloud-api' },
  { id: 'garmin', name: 'Garmin', maker: 'Garmin', delivery: 'morning', connection: 'cloud-api' },
  { id: 'fitbit', name: 'Fitbit', maker: 'Google', delivery: 'morning', connection: 'cloud-api' },
  { id: 'polar', name: 'Polar', maker: 'Polar', delivery: 'morning', connection: 'cloud-api' },
  { id: 'withings', name: 'Withings', maker: 'Withings', delivery: 'morning', connection: 'cloud-api' },
  { id: 'amazfit', name: 'Amazfit', maker: 'Zepp Health', delivery: 'morning', connection: 'cloud-api' },
];

const home = (id: string, name: string): ClimateBrand => ({ id, name, equipment: ['central'], scope: 'home' });
const room = (id: string, name: string, equipment: ClimateBrand['equipment']): ClimateBrand => ({ id, name, equipment, scope: 'room' });

export const CLIMATE_BRANDS: ClimateBrand[] = [
  // Whole-home thermostats.
  home('nest', 'Nest'),
  home('ecobee', 'ecobee'),
  home('honeywell-home', 'Honeywell Home'),
  home('sensi', 'Sensi'),
  home('trane', 'Trane'),
  home('lux', 'Lux'),
  home('radio-thermostat', 'Radio Thermostat'),
  home('centralite', 'Centralite'),
  home('remotec', 'Remotec'),
  home('alarm-com', 'Alarm.com'),
  home('gocontrol', 'GoControl'),
  // Room-level heating and cooling: line-voltage baseboard thermostats, mini-split and window-unit controllers.
  room('mysa', 'Mysa', ['baseboard', 'miniSplit', 'windowAc']),
  room('sinope', 'Sinopé', ['baseboard']),
  room('stelpro', 'Stelpro', ['baseboard']),
  room('sensibo', 'Sensibo', ['miniSplit', 'windowAc']),
  room('cielo', 'Cielo Breez', ['miniSplit', 'windowAc']),
  room('aqara', 'Aqara', ['miniSplit', 'windowAc']),
  room('eve', 'Eve', ['baseboard']),
  room('meross', 'Meross', ['baseboard', 'windowAc']),
  room('midea', 'Midea', ['windowAc']),
];

export const CATALOG: Catalog = { wearables: WEARABLES, climate: CLIMATE_BRANDS };

export const wearableBrand = (id: string): WearableBrand => WEARABLES.find((w) => w.id === id) ?? WEARABLES[0]!;

export const climateBrand = (id: string): ClimateBrand | undefined => CLIMATE_BRANDS.find((c) => c.id === id);

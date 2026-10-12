// A map's light at a point and a time of day, as the client blends it: each
// area light in full inside its inner radius, fading out to its outer one,
// and the map's default light making up the rest. Pure, so it can be tested
// without three.js. The lights come from /assets/models/light/<mapId>.json
// (scripts/scene/lights.mjs).

import type { Point3 } from './spell-events';

// Keys of a colour through the day: [time in half-minutes from midnight,
// 0xRRGGBB].
export type LightKeys = Array<[number, number]>;

export interface MapLight {
  id: number;
  defaultLight: boolean;
  // Server coordinates; null for the default light.
  position: Point3 | null;
  // Yards.
  inner: number;
  outer: number;
  direct: LightKeys;
  ambient: LightKeys;
}

// A light on a building or prop (a torch's, a brazier's): server
// coordinates, colour, intensity, and the yards its light fades out between.
export interface ObjectLight {
  position: Point3;
  color: number;
  intensity: number;
  start: number;
  end: number;
}

// An interior WMO group's part in lighting units on its floor: the
// building's ambient (0xRRGGBB) the client adds to the floor colour,
// whether the group is lit by the outdoor light instead, and its transition
// faces (doorways, cave mouths): by render batch, the batch's triangles
// that blend towards the outdoor light, or null.
export interface InteriorGroup {
  ambient?: number;
  outdoor?: boolean;
  transitions?: Array<number[] | null>;
}

export interface MapLights {
  mapId: number;
  lights: MapLight[];
  objects?: ObjectLight[];
  // By WMO group ID; groups with nothing to say are left out.
  interiors?: Record<number, InteriorGroup>;
  // The map's zone's ambient multiplier for characters (AreaTable), if set.
  ambientMultiplier?: number;
  // The time of day the map is always lit at (half-minutes), if the client
  // fixes it (Ulduar, two arenas); else the clock's.
  timeOfDay?: number;
}

export type Rgb = [number, number, number];

// The direct (sun) and ambient colours at a point, 0 to 1 (sRGB).
export interface LightColors {
  direct: Rgb;
  ambient: Rgb;
}

export const HALF_MINUTES_PER_DAY = 2880;

// The map's light as the client draws it on the ground is brighter and less
// orange than the plain sum of its colours: matched to the user's client
// screenshot of Arathi Basin against ours at 17:33 (docs/profile/
// *-reference.png; the client's ground is about 1.3x ours in red, 1.5x in
// green, 1.6x in blue), the ambient counts this much and the sun this much
// (with the client's sun, 21 degrees up then; sunDirection).
export const CLIENT_AMBIENT_GAIN = 1.65;
export const CLIENT_DIRECT_GAIN = 2.79;

// The time of day in the client's units (half-minutes from midnight).
export function timeOfDay(date: Date): number {
  return (date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60) * 2;
}

const toRgb = (color: number): Rgb => [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];

// A band's colour at a time: between the keys either side, wrapping past
// midnight; the one colour of a single key; black with none.
export function keyColor(keys: LightKeys, time: number): Rgb {
  if (!keys.length) return [0, 0, 0];
  if (keys.length === 1) return toRgb(keys[0][1]);
  const t = ((time % HALF_MINUTES_PER_DAY) + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY;
  let next = keys.findIndex(([at]) => at > t);
  if (next < 0) next = 0;
  const previous = (next - 1 + keys.length) % keys.length;
  const [fromAt, fromColor] = keys[previous];
  const [toAt, toColor] = keys[next];
  const span = (toAt - fromAt + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY || HALF_MINUTES_PER_DAY;
  const along = ((t - fromAt + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY) / span;
  const from = toRgb(fromColor);
  const to = toRgb(toColor);
  return [0, 1, 2].map((channel) => from[channel] + (to[channel] - from[channel]) * along) as Rgb;
}

// How much an area light counts at a point: 1 inside its inner radius,
// falling to 0 at its outer one.
export function lightWeight(light: MapLight, point: Point3): number {
  if (!light.position) return 0;
  const distance = Math.hypot(point[0] - light.position[0], point[1] - light.position[1], point[2] - light.position[2]);
  if (distance <= light.inner) return 1;
  if (distance >= light.outer || light.outer <= light.inner) return 0;
  return 1 - (distance - light.inner) / (light.outer - light.inner);
}

// The `count` object lights nearest a point, within `reach` yards of it.
export function nearestObjectLights(objects: readonly ObjectLight[], point: Point3, count: number, reach: number): ObjectLight[] {
  return objects
    .map((light) => ({ light, distance: Math.hypot(light.position[0] - point[0], light.position[1] - point[1], light.position[2] - point[2]) }))
    .filter(({ distance }) => distance <= reach)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, count)
    .map(({ light }) => light);
}

// The map's light at a point and time: the area lights by weight (scaled
// down if they add to more than one), the default light for the rest.
export function lightAt(map: MapLights, point: Point3, time: number): LightColors {
  const direct: Rgb = [0, 0, 0];
  const ambient: Rgb = [0, 0, 0];
  const weighted = map.lights.filter((light) => !light.defaultLight)
    .map((light) => ({ light, weight: lightWeight(light, point) }))
    .filter(({ weight }) => weight > 0);
  const total = weighted.reduce((sum, { weight }) => sum + weight, 0);
  const scale = total > 1 ? 1 / total : 1;
  const add = (light: MapLight, weight: number) => {
    const d = keyColor(light.direct, time);
    const a = keyColor(light.ambient, time);
    for (let channel = 0; channel < 3; channel += 1) {
      direct[channel] += d[channel] * weight;
      ambient[channel] += a[channel] * weight;
    }
  };
  for (const { light, weight } of weighted) add(light, weight * scale);
  const rest = 1 - Math.min(1, total);
  const fallback = map.lights.find((light) => light.defaultLight);
  if (rest > 0 && fallback) add(fallback, rest);
  return { direct, ambient };
}

// The way the sun's light travels at a time (server coordinates, unit
// length), as the client turns it through the day (Wow.exe FUN_007eea90, its
// sky's light direction): from a fixed bearing, 225 degrees round from +x,
// its angle from straight up 127 degrees at midnight and noon and 110 at six,
// linear between. So the light is highest (37 degrees up) at noon and
// midnight and lowest (20 degrees) at six in the morning and evening.
export const SUN_BEARING = (225 * Math.PI) / 180;
const SUN_POLAR_HIGH = (127 * Math.PI) / 180;
const SUN_POLAR_LOW = (110 * Math.PI) / 180;

export function sunDirection(time: number): Point3 {
  const day = ((time % HALF_MINUTES_PER_DAY) + HALF_MINUTES_PER_DAY) % HALF_MINUTES_PER_DAY / HALF_MINUTES_PER_DAY;
  // 0 at midnight and noon, 1 at six.
  const towardsSix = 1 - Math.abs(((day * 4) % 2) - 1);
  const polar = SUN_POLAR_HIGH + (SUN_POLAR_LOW - SUN_POLAR_HIGH) * towardsSix;
  return [Math.cos(SUN_BEARING) * Math.sin(polar), Math.sin(SUN_BEARING) * Math.sin(polar), Math.cos(polar)];
}

// Indoors the client lights a unit by the building's baked light on the floor
// under it, not by the map's sun and sky (Wow.exe: a ray from 1.5 yards above
// the unit down into its WMO group, the floor's vertex colour at the hit; its
// direct light that colour brightened, hue kept, until its brightest channel
// is at least 168/255, its ambient the colour dimmed until its brightest
// channel is at most 96/255), shining from a fixed direction.
export const INDOOR_DIRECT_FLOOR = 168 / 255;
export const INDOOR_AMBIENT_CEILING = 96 / 255;
// The way indoor light travels (server coordinates): mostly down.
export const INDOOR_LIGHT_DIRECTION: Point3 = [-0.3082, -0.3082, -0.9];

// The colour the client lights a unit indoors by, from the floor's vertex
// colour under it (Wow.exe FUN_007c7fe0): doubled, plus the building's
// ambient if it adds one, each channel at most 1.
export function floorLight(vertex: Rgb, ambient = 0): Rgb {
  const added = toRgb(ambient);
  return [0, 1, 2].map((channel) => Math.min(1, vertex[channel] * 2 + added[channel])) as Rgb;
}

// Characters' ambient is scaled by 1 + 2 x the zone's multiplier, each
// channel at most 1 (Wow.exe FUN_007831a0, FUN_007c1730; the console
// setting characterAmbient).
export function characterAmbientScale(multiplier = 0): number {
  return 1 + 2 * multiplier;
}

export function scaleAmbient(ambient: Rgb, scale: number): Rgb {
  return ambient.map((value) => Math.min(1, value * scale)) as Rgb;
}

// On a transition face the client mixes a unit's indoor light towards the
// outdoor light by the floor colour's alpha (Wow.exe FUN_007c1c40); its
// light direction too, in the unit's shader.
export function blendLight(indoor: LightColors, outdoor: LightColors, share: number): LightColors {
  const mix = (from: Rgb, to: Rgb): Rgb => [0, 1, 2].map((channel) => from[channel] + (to[channel] - from[channel]) * share) as Rgb;
  return { direct: mix(indoor.direct, outdoor.direct), ambient: mix(indoor.ambient, outdoor.ambient) };
}

export function indoorLight(floor: Rgb): LightColors {
  const brightest = Math.max(floor[0], floor[1], floor[2]) || 1 / 255;
  const scale = (factor: number): Rgb => [floor[0] * factor, floor[1] * factor, floor[2] * factor];
  return {
    direct: brightest < INDOOR_DIRECT_FLOOR ? scale(INDOOR_DIRECT_FLOOR / brightest) : [...floor],
    ambient: brightest > INDOOR_AMBIENT_CEILING ? scale(INDOOR_AMBIENT_CEILING / brightest) : [...floor],
  };
}

// How the client lights a building's render batch (Wow.exe FUN_007ac9f0,
// the older render path, and FUN_007a9380, the newer "unified" one, header
// flag 0x2): 'own' by the batch's own vertex colours (the newer path adds
// the building's ambient to them), 'lit' by the map's light on them,
// 'transition' a mix of the two by the vertex alpha, 'unlit' by the vertex
// colours alone. A group's batches are its transition ones, then its
// interior ones, then its exterior ones.
export type BuildingBatchLight = 'own' | 'lit' | 'transition' | 'unlit';

export const WMO_GROUP_EXTERIOR_FLAGS = 0x8 | 0x40;
export const WMO_MATERIAL_UNLIT = 0x1;
export const WMO_MATERIAL_WINDOW = 0x20;

export function buildingBatchLight(
  batch: number, [transition, interior]: readonly number[], unified: boolean, groupFlags: number, materialFlags: number,
): BuildingBatchLight {
  if (batch < transition) return 'transition';
  if (!unified) return batch < transition + interior ? 'unlit' : 'lit';
  if (groupFlags & WMO_GROUP_EXTERIOR_FLAGS) return materialFlags & WMO_MATERIAL_UNLIT ? 'unlit' : 'lit';
  // Windows take the sky's second light, drawn here as its first.
  return materialFlags & WMO_MATERIAL_WINDOW ? 'lit' : 'own';
}

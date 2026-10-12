// A map's light, as the client lights the world: Light.dbc's lights for the
// map (a default one, and ones covering an area that fade out towards their
// edge), each with its direct (sun) and ambient colours through the day from
// LightIntBand; and the lights of the objects on it (buildings' MOLT lights,
// braziers' and bonfires' model lights), placed in server coordinates.
// Served on demand as /assets/models/light/<mapId>.json.

import { findChunk, readChunks } from './chunks.mjs';
import { readDbc } from './dbc.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt } from './placement.mjs';
import {
  groupFileName, readDoodadDefinitions, readGroupHeader, selectDoodadIndices, WMO_GROUP_FLAG_EXTERIOR,
} from './wmo.mjs';

// Light.dbc: map, position, falloff start and end (the inner and outer
// radius), and the clear-weather LightParams.
const LIGHT_MAP = 1;
const LIGHT_POSITION = 2;
const LIGHT_INNER = 5;
const LIGHT_OUTER = 6;
const LIGHT_PARAMS = 7;
// The light used when a map has none of its own (Eastern Kingdoms' default).
const FALLBACK_LIGHT = 1;
// Light.dbc positions and radii are in client units: 36 to the yard, from a
// corner of the world.
const LIGHT_UNITS = 36;
const WORLD_CORNER = 17066.666;
// LightIntBand: 18 bands per LightParams; each up to 16 keys of a time
// (half-minutes from midnight) and a BGRA colour.
const BANDS_PER_PARAMS = 18;
const BAND_DIRECT = 0;
const BAND_AMBIENT = 1;
const BAND_COUNT = 1;
const BAND_TIMES = 2;
const BAND_COLOURS = 18;
const MAX_KEYS = 16;

// Map.dbc: the map's directory under World\maps, and the time of day the
// map is always lit at (minutes from midnight; -1 for the clock). Only
// Ulduar and two arenas set one.
const MAP_DIRECTORY = 1;
const MAP_TIME_OF_DAY_OVERRIDE = 62;
// MOLT, a WMO's lights (48 bytes each): type (0 omni, 1 spot), BGRA colour,
// position, intensity, and the distances its light fades out between.
const MOLT_SIZE = 48;
const MOLT_TYPE = 0;
const MOLT_COLOR = 4;
const MOLT_POSITION = 8;
const MOLT_INTENSITY = 20;
const MOLT_START = 40;
const MOLT_END = 44;
const MOLT_POINT_TYPES = new Set([0, 1]);
// An M2's lights (header 0x108, 156 bytes each): type (1 point), position,
// then tracks; each track is a u16 interpolation, an i16 global sequence,
// and M2Arrays of per-sequence time and key arrays. The first key of the
// first sequence is used: diffuse colour and intensity, and the fade-out
// distances.
const M2_LIGHTS = 0x108;
const M2_LIGHT_SIZE = 156;
const M2_LIGHT_POINT = 1;
const M2_LIGHT_POSITION = 4;
const M2_LIGHT_DIFFUSE_COLOR = 56;
const M2_LIGHT_DIFFUSE_INTENSITY = 76;
const M2_LIGHT_START = 96;
const M2_LIGHT_END = 116;
const M2_TRACK_KEYS = 12;
// MOHD, a WMO's header: its ambient colour (BGRA) and flags. With flag 0x2
// the client adds the ambient to the floor colour it lights units by.
const MOHD_AMBIENT = 0x1c;
const MOHD_FLAGS = 0x3c;
const MOHD_FLAG_ADD_AMBIENT = 0x2;
// A group lit by the outdoor light although it is not exterior.
const WMO_GROUP_FLAG_EXTERIOR_LIT = 0x40;
// A group's chunks after its MOGP header: MOPY, a flags byte and a material
// per triangle (flag 0x1 a transition face, where a doorway or cave mouth
// blends indoor light into outdoor), and MOBA, its render batches (24 bytes:
// first index at 0x0c, index count at 0x10), in the order the scene's
// primitives are.
const MOGP_HEADER_SIZE = 0x44;
const MOPY_FLAG_TRANSITION = 0x1;
const MOBA_SIZE = 24;
const MOBA_START_INDEX = 0x0c;
const MOBA_INDEX_COUNT = 0x10;
// AreaTable: parent area, and the ambient multiplier characters' light is
// scaled by (Wow.exe FUN_007831a0).
const AREA_MAP = 1;
const AREA_PARENT = 2;
const AREA_AMBIENT_MULTIPLIER = 34;

// A light's position in server coordinates, from Light.dbc's.
export function lightPosition([x, y, z]) {
  return [WORLD_CORNER - z / LIGHT_UNITS, WORLD_CORNER - x / LIGHT_UNITS, y / LIGHT_UNITS];
}

// A band's keys: [time, 0xRRGGBB] pairs.
function bandKeys(band) {
  if (!band) return [];
  const count = Math.min(MAX_KEYS, band.uint(BAND_COUNT));
  return Array.from({ length: count }, (_, index) => [band.uint(BAND_TIMES + index), band.uint(BAND_COLOURS + index) & 0xffffff]);
}

// A point turned by a placement's quaternion, scaled, and moved to its
// position.
export function placePoint({ position, rotation: [x, y, z, w], scale }, [px, py, pz]) {
  const [vx, vy, vz] = [px * scale, py * scale, pz * scale];
  // v + 2w(q × v) + 2 q × (q × v)
  const [cx, cy, cz] = [y * vz - z * vy, z * vx - x * vz, x * vy - y * vx];
  const [dx, dy, dz] = [y * cz - z * cy, z * cx - x * cz, x * cy - y * cx];
  return [position[0] + vx + 2 * (w * cx + dx), position[1] + vy + 2 * (w * cy + dy), position[2] + vz + 2 * (w * cz + dz)];
}

const toColor = (rgb) => rgb.reduce((color, channel) => (color << 8) | Math.round(Math.min(1, Math.max(0, channel)) * 255), 0);

// A WMO's point lights, in its own space.
export function readWmoLights(rootChunks) {
  const molt = findChunk(rootChunks, 'MOLT');
  const lights = [];
  for (let at = 0; molt && at + MOLT_SIZE <= molt.length; at += MOLT_SIZE) {
    if (!MOLT_POINT_TYPES.has(molt[at + MOLT_TYPE])) continue;
    lights.push({
      position: [0, 1, 2].map((axis) => molt.readFloatLE(at + MOLT_POSITION + axis * 4)),
      color: molt.readUInt32LE(at + MOLT_COLOR) & 0xffffff,
      intensity: molt.readFloatLE(at + MOLT_INTENSITY),
      start: molt.readFloatLE(at + MOLT_START),
      end: molt.readFloatLE(at + MOLT_END),
    });
  }
  return lights;
}

// An M2's point lights, in its own space.
export function readM2Lights(buffer) {
  if (!buffer || buffer.length < M2_LIGHTS + 8) return [];
  const count = buffer.readUInt32LE(M2_LIGHTS);
  const offset = buffer.readUInt32LE(M2_LIGHTS + 4);
  // The track's first key, `width` floats.
  const firstKey = (track, width) => {
    if (!buffer.readUInt32LE(track + M2_TRACK_KEYS)) return null;
    const keys = buffer.readUInt32LE(track + M2_TRACK_KEYS + 4);
    if (!buffer.readUInt32LE(keys)) return null;
    const at = buffer.readUInt32LE(keys + 4);
    return Array.from({ length: width }, (_, index) => buffer.readFloatLE(at + index * 4));
  };
  const lights = [];
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * M2_LIGHT_SIZE;
    if (at + M2_LIGHT_SIZE > buffer.length || buffer.readUInt16LE(at) !== M2_LIGHT_POINT) continue;
    const color = firstKey(at + M2_LIGHT_DIFFUSE_COLOR, 3);
    const intensity = firstKey(at + M2_LIGHT_DIFFUSE_INTENSITY, 1)?.[0] ?? 0;
    const end = firstKey(at + M2_LIGHT_END, 1)?.[0] ?? 0;
    if (!color || intensity <= 0 || end <= 0) continue;
    lights.push({
      position: [0, 1, 2].map((axis) => buffer.readFloatLE(at + M2_LIGHT_POSITION + axis * 4)),
      color: toColor(color),
      intensity,
      start: firstKey(at + M2_LIGHT_START, 1)?.[0] ?? 0,
      end,
    });
  }
  return lights;
}

// The buildings and loose props a map places.
function mapPlacements(readFile, directory) {
  const mapPath = `World\\maps\\${directory}\\${directory}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) return { wmos: [], doodads: [] };
  const wdt = readWdt(wdtBuffer);
  if (wdt.wmoOnly) return { wmos: wdt.wmo ? [wdt.wmo] : [], doodads: [] };
  const tiles = wdt.tiles.map(({ x, y }) => readFile(`${mapPath}_${x}_${y}.adt`)).filter(Boolean).map(readAdtPlacements);
  return {
    wmos: dedupeByUniqueId(tiles.flatMap((tile) => tile.wmos)),
    doodads: dedupeByUniqueId(tiles.flatMap((tile) => tile.doodads)),
  };
}

// A group's transition faces, by render batch: each batch's triangles
// (counted from its first index) that have the transition flag, or null for
// none. Empty when the group has none.
export function transitionTriangles(groupBuffer) {
  const mogp = findChunk(readChunks(groupBuffer), 'MOGP');
  if (!mogp || mogp.length < MOGP_HEADER_SIZE) return [];
  const chunks = readChunks(mogp, MOGP_HEADER_SIZE);
  const mopy = findChunk(chunks, 'MOPY');
  const moba = findChunk(chunks, 'MOBA');
  if (!mopy || !moba) return [];
  const batches = [];
  let any = false;
  for (let at = 0; at + MOBA_SIZE <= moba.length; at += MOBA_SIZE) {
    const first = moba.readUInt32LE(at + MOBA_START_INDEX) / 3;
    const count = moba.readUInt16LE(at + MOBA_INDEX_COUNT) / 3;
    const triangles = [];
    for (let triangle = 0; triangle < count; triangle += 1) {
      const flags = mopy[(first + triangle) * 2];
      if (flags !== undefined && flags & MOPY_FLAG_TRANSITION) triangles.push(triangle);
    }
    any ||= triangles.length > 0;
    batches.push(triangles.length ? triangles : null);
  }
  return any ? batches : [];
}

// What the renderer needs to light units in a map's interior WMO groups as
// the client does, by group ID (the stream's wmoGroupId): `ambient`
// (0xRRGGBB), the building's ambient the client adds to the floor colour;
// `outdoor`, a group lit by the outdoor light although not exterior;
// `transitions`, its transition faces (transitionTriangles). Groups with
// none of these are left out.
export function interiorGroups(readFile, wmoNames) {
  const interiors = {};
  for (const name of new Set(wmoNames)) {
    const rootBuffer = readFile(name);
    const mohd = rootBuffer && findChunk(readChunks(rootBuffer), 'MOHD');
    if (!mohd) continue;
    const groupCount = mohd.readUInt32LE(4);
    const ambient = mohd.readUInt16LE(MOHD_FLAGS) & MOHD_FLAG_ADD_AMBIENT ? mohd.readUInt32LE(MOHD_AMBIENT) & 0xffffff : 0;
    for (let index = 0; index < groupCount; index += 1) {
      const groupBuffer = readFile(groupFileName(name, index));
      if (!groupBuffer) continue;
      const { flags, groupId } = readGroupHeader(groupBuffer);
      if (flags & WMO_GROUP_FLAG_EXTERIOR) continue;
      const transitions = transitionTriangles(groupBuffer);
      const entry = {
        ...(ambient ? { ambient } : {}),
        ...(flags & WMO_GROUP_FLAG_EXTERIOR_LIT ? { outdoor: true } : {}),
        ...(transitions.length ? { transitions } : {}),
      };
      if (Object.keys(entry).length) interiors[groupId] = entry;
    }
  }
  return interiors;
}

// The lights of the buildings and props on a map, in server coordinates:
// each building's own, its doodad sets' models', and the map's loose props'.
export function objectLights(readFile, { wmos, doodads }) {
  const m2Lights = new Map();
  const modelLights = (name) => {
    if (!m2Lights.has(name)) m2Lights.set(name, readM2Lights(readFile(name)));
    return m2Lights.get(name);
  };
  const placed = [];
  const add = (lights, ...placements) => {
    for (const light of lights) {
      const position = placements.reduceRight((point, placement) => placePoint(placement, point), light.position);
      const scale = placements.reduce((product, placement) => product * placement.scale, 1);
      placed.push({ ...light, position, start: light.start * scale, end: light.end * scale });
    }
  };
  for (const wmo of wmos) {
    const rootBuffer = readFile(wmo.name);
    if (!rootBuffer) continue;
    const rootChunks = readChunks(rootBuffer);
    add(readWmoLights(rootChunks), wmo);
    const { sets, definitions } = readDoodadDefinitions(rootChunks);
    for (const index of selectDoodadIndices(sets, wmo.doodadSet)) {
      const definition = definitions[index];
      if (definition) add(modelLights(definition.name), wmo, definition);
    }
  }
  for (const doodad of doodads) add(modelLights(doodad.name), doodad);
  return placed.map(({ position, color, intensity, start, end }) => ({
    position: position.map((value) => Math.round(value * 100) / 100), color, intensity, start, end,
  }));
}

// The ambient multiplier of a map's zone: its top-level area's (the one
// with no parent, the lowest ID if several), 0 if none. The client takes
// the player's own area, falling back to the parent's unless the area has
// its own flag set, so in a dungeon it is the zone's.
export function zoneAmbientMultiplier(areas, mapId) {
  let zone = null;
  for (const record of areas.records()) {
    if (record.uint(AREA_MAP) !== mapId || record.uint(AREA_PARENT) !== 0) continue;
    if (!zone || record.uint(0) < zone.uint(0)) zone = record;
  }
  return zone ? Math.round(zone.float(AREA_AMBIENT_MULTIPLIER) * 1000) / 1000 : 0;
}

// The map's lights, with their direct and ambient keys: `defaultLight` set on
// the one that covers the whole map (at the origin, no radius), else on the
// fallback light; and its objects' lights. Positions are in server
// coordinates and distances in yards.
export function mapLights(readFile, mapId) {
  const table = (name) => {
    const buffer = readFile(`DBFilesClient\\${name}.dbc`);
    return buffer ? readDbc(buffer) : null;
  };
  const lights = table('Light');
  const bands = table('LightIntBand')?.byId();
  if (!lights || !bands) return null;
  const describe = (record, defaultLight) => {
    const params = record.uint(LIGHT_PARAMS);
    const band = (index) => bands.get(params * BANDS_PER_PARAMS - (BANDS_PER_PARAMS - 1) + index);
    const position = [0, 1, 2].map((axis) => record.float(LIGHT_POSITION + axis));
    return {
      id: record.uint(0),
      defaultLight,
      position: defaultLight ? null : lightPosition(position),
      inner: record.float(LIGHT_INNER) / LIGHT_UNITS,
      outer: record.float(LIGHT_OUTER) / LIGHT_UNITS,
      direct: bandKeys(band(BAND_DIRECT)),
      ambient: bandKeys(band(BAND_AMBIENT)),
    };
  };
  const own = [...lights.records()].filter((record) => record.uint(LIGHT_MAP) === mapId);
  const isDefault = (record) => [0, 1, 2].every((axis) => record.float(LIGHT_POSITION + axis) === 0);
  const described = own.map((record) => describe(record, isDefault(record)));
  if (!described.some((light) => light.defaultLight)) {
    const fallback = [...lights.records()].find((record) => record.uint(0) === FALLBACK_LIGHT);
    if (fallback) described.push(describe(fallback, true));
  }
  const map = table('Map')?.byId().get(mapId);
  const directory = map?.string(MAP_DIRECTORY);
  const placements = directory ? mapPlacements(readFile, directory) : { wmos: [], doodads: [] };
  const objects = objectLights(readFile, placements);
  const interiors = interiorGroups(readFile, placements.wmos.map((wmo) => wmo.name));
  const areas = table('AreaTable');
  const ambientMultiplier = areas ? zoneAmbientMultiplier(areas, mapId) : 0;
  const fixedTime = map ? map.int(MAP_TIME_OF_DAY_OVERRIDE) : -1;
  return described.length
    ? {
      mapId, lights: described, objects, interiors,
      ...(ambientMultiplier > 0 ? { ambientMultiplier } : {}),
      ...(fixedTime >= 0 ? { timeOfDay: fixedTime * 2 } : {}),
    }
    : null;
}

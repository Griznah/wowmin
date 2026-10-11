// Reads liquids (water, ocean, magma, slime) for 3D scenes: WMO group liquid
// grids (MLIQ), and terrain liquids (MH2O in Wrath tiles, per-chunk MCLQ in
// older ones), and builds their surfaces. Layouts and the liquid type rules
// follow wowdev.wiki's WMO and ADT pages. LiquidType.dbc names each type's animated
// texture ("XTextures\lava\lava.%d.blp", frames 1-30).

import { findChunk, readChunks, readFloats } from './chunks.mjs';

// A liquid tile is an eighth of a terrain chunk.
export const LIQUID_UNIT = 1600 / 3 / 16 / 8;
const MOGP_HEADER_SIZE = 0x44;
const MOGP_GROUP_LIQUID = 0x34;
const MLIQ_HEADER_SIZE = 0x1E;
const MLIQ_VERTEX_SIZE = 8;
// A tile whose low 4 bits are all set has no liquid.
const TILE_NO_LIQUID = 0x0F;
export const WMO_ROOT_FLAG_LIQUID_TYPE_DBC_ID = 0x4;
const WMO_GROUP_FLAG_OCEAN = 0x80000;
const WMO_GROUP_FLAG_INTERIOR = 0x2000;
const GREEN_LAVA = 15;

// LiquidType IDs for the four basic kinds in a WMO: water (ocean when the
// group says so), ocean, magma, slime.
function toWmoLiquid(value, groupFlags) {
  switch (value & 3) {
    case 0: return groupFlags & WMO_GROUP_FLAG_OCEAN ? 14 : 13;
    case 1: return 14;
    case 2: return 19;
    default: return 20;
  }
}

// The LiquidType ID a WMO group's liquid uses, from its MOGP groupLiquid,
// the root's flags, and (for old green-lava groups) the first tile's legacy
// type. Interior water uses the interior kind.
export function wmoLiquidType(groupLiquid, rootFlags, groupFlags, firstTileType = 0) {
  let type;
  if (rootFlags & WMO_ROOT_FLAG_LIQUID_TYPE_DBC_ID) {
    type = groupLiquid < 21 ? toWmoLiquid(groupLiquid - 1, groupFlags) : groupLiquid;
  } else if (groupLiquid === GREEN_LAVA) {
    // Old tiles name their kind in the same low two bits (4 river water,
    // 6 magma, ...).
    type = toWmoLiquid(firstTileType, groupFlags);
  } else {
    type = groupLiquid < 20 ? toWmoLiquid(groupLiquid, groupFlags) : groupLiquid + 1;
  }
  return type === 13 && groupFlags & WMO_GROUP_FLAG_INTERIOR ? 17 : type;
}

// A WMO group's liquid grid, or null if it has none: vertex and tile counts,
// the corner it starts from (group space), each vertex's height, and each
// tile's flags.
export function readWmoLiquid(groupBuffer) {
  const mogp = findChunk(readChunks(groupBuffer), 'MOGP');
  if (!mogp || mogp.length < MOGP_HEADER_SIZE) return null;
  const mliq = findChunk(readChunks(mogp, MOGP_HEADER_SIZE), 'MLIQ');
  if (!mliq || mliq.length < MLIQ_HEADER_SIZE) return null;
  const xVerts = mliq.readUInt32LE(0x00);
  const yVerts = mliq.readUInt32LE(0x04);
  const xTiles = mliq.readUInt32LE(0x08);
  const yTiles = mliq.readUInt32LE(0x0C);
  const corner = readFloats(mliq, 0x10, 3);
  const vertexStart = MLIQ_HEADER_SIZE;
  const tileStart = vertexStart + xVerts * yVerts * MLIQ_VERTEX_SIZE;
  if (!xTiles || !yTiles || tileStart + xTiles * yTiles > mliq.length) return null;
  const heights = new Float32Array(xVerts * yVerts);
  for (let index = 0; index < heights.length; index += 1) {
    heights[index] = mliq.readFloatLE(vertexStart + index * MLIQ_VERTEX_SIZE + 4);
  }
  return {
    xVerts, yVerts, xTiles, yTiles, corner, heights,
    tiles: Uint8Array.from(mliq.subarray(tileStart, tileStart + xTiles * yTiles)),
    groupLiquid: mogp.readUInt32LE(MOGP_GROUP_LIQUID),
  };
}

// The first tile's legacy liquid type (low 4 bits), for old green-lava groups.
export function firstTileType(liquid) {
  for (const tile of liquid.tiles) if ((tile & 0x0F) !== TILE_NO_LIQUID) return tile & 0x0F;
  return 0;
}

// Collects liquid grids into one surface: triangles for their wet tiles, with
// UVs that repeat the liquid texture every `repeat` yards of the world.
export class LiquidSurface {
  constructor(repeat = LIQUID_UNIT * 2) {
    this.repeat = repeat;
    this.positions = [];
    this.uvs = [];
    this.indices = [];
  }

  // A grid of xTiles × yTiles tiles: `heights` per vertex ((xTiles + 1) per
  // row), `wet(x, y)` per tile, and `place(x, y)` the horizontal position
  // of vertex (x, y).
  add({ xTiles, yTiles, heights, wet, place }) {
    // Neighbouring wet tiles share their corners.
    const shared = new Map();
    const vertex = (x, y) => {
      const key = y * (xTiles + 1) + x;
      if (shared.has(key)) return shared.get(key);
      const [px, py] = place(x, y);
      this.positions.push(px, py, heights[key]);
      this.uvs.push(px / this.repeat, py / this.repeat);
      shared.set(key, this.positions.length / 3 - 1);
      return shared.get(key);
    };
    for (let y = 0; y < yTiles; y += 1) {
      for (let x = 0; x < xTiles; x += 1) {
        if (!wet(x, y)) continue;
        const a = vertex(x, y);
        const b = vertex(x + 1, y);
        const c = vertex(x + 1, y + 1);
        const d = vertex(x, y + 1);
        this.indices.push(a, b, c, a, c, d);
      }
    }
    return this;
  }

  // Positions, UVs, and indices; null when no tile held liquid.
  finish() {
    if (!this.indices.length) return null;
    return { positions: Float32Array.from(this.positions), uvs: Float32Array.from(this.uvs), indices: Uint32Array.from(this.indices) };
  }
}

// A WMO group's liquid surface in the group's own space (vertex (x, y) at
// corner + (x, y) × LIQUID_UNIT). Null when no tile has any.
export function liquidSurface({ xVerts, xTiles, yTiles, corner, heights, tiles }, repeat = LIQUID_UNIT * 2) {
  // Vertex rows can be wider than the tiles need.
  const rowHeights = xVerts === xTiles + 1 ? heights : Float32Array.from({ length: (xTiles + 1) * (yTiles + 1) },
    (_, index) => heights[Math.floor(index / (xTiles + 1)) * xVerts + (index % (xTiles + 1))]);
  return new LiquidSurface(repeat).add({
    xTiles, yTiles, heights: rowHeights,
    wet: (x, y) => (tiles[y * xTiles + x] & 0x0F) !== TILE_NO_LIQUID,
    place: (x, y) => [corner[0] + x * LIQUID_UNIT, corner[1] + y * LIQUID_UNIT],
  }).finish();
}

// LiquidType.dbc: kind (0 water, 1 ocean, 2 magma, 3 slime) and texture.
const LIQUID_KINDS = ['water', 'ocean', 'magma', 'slime'];
const LIQUID_TYPE_KIND = 3;
const LIQUID_TYPE_TEXTURE = 15;
const MAX_LIQUID_FRAMES = 30;

// A liquid type's kind and its animation frame files, or null if unknown.
export function liquidTypeInfo(liquidTypes, typeId, readFile) {
  const record = liquidTypes.get(typeId);
  if (!record) return null;
  const pattern = record.string(LIQUID_TYPE_TEXTURE);
  const frames = [];
  for (let frame = 1; pattern && frame <= MAX_LIQUID_FRAMES; frame += 1) {
    const name = pattern.replace('%d', String(frame));
    if (!readFile(name)) break;
    frames.push(name);
  }
  return { kind: LIQUID_KINDS[record.uint(LIQUID_TYPE_KIND)] ?? 'water', frames };
}

// Water's colour. The client paints water and ocean in the colours of the
// map's light (the liquid textures are dark ripples, mostly alpha). Light.dbc:
// map at field 1, position at 2-4, the clear-weather LightParams at 7.
// LightIntBand: 18 bands per LightParams (ID params × 18 − 17 + band), each
// with up to 16 times (half-minutes, 1440 is noon) and BGRA colours.
const LIGHT_MAP = 1;
const LIGHT_POSITION = 2;
const LIGHT_PARAMS = 7;
const DEFAULT_LIGHT = 1;
const BANDS_PER_PARAMS = 18;
const BAND_OCEAN_CLOSE = 14;
const BAND_RIVER_CLOSE = 16;
const NOON = 1440;

function bandColourAt(band, time) {
  const count = Math.min(16, band.uint(1));
  if (!count) return null;
  const rgb = (index) => {
    const value = band.uint(18 + index);
    return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF].map((channel) => channel / 255);
  };
  let index = 0;
  while (index < count - 1 && band.uint(2 + index + 1) <= time) index += 1;
  if (index === count - 1) return rgb(index);
  const from = band.uint(2 + index);
  const to = band.uint(2 + index + 1);
  const t = to > from ? Math.min(1, Math.max(0, (time - from) / (to - from))) : 0;
  const a = rgb(index);
  const b = rgb(index + 1);
  return a.map((value, channel) => value + (b[channel] - value) * t);
}

// The map's water and ocean colours at noon (sRGB, 0-1): the map's own light
// (its global one at the origin if it has several), else the default light.
// Close and far colours are averaged.
export function mapLiquidColours(lights, bandsById, mapId) {
  let light = null;
  for (const record of lights.records()) {
    if (record.uint(LIGHT_MAP) !== mapId) continue;
    const atOrigin = [0, 1, 2].every((axis) => record.float(LIGHT_POSITION + axis) === 0);
    if (!light || atOrigin) light = record;
    if (atOrigin) break;
  }
  light ??= [...lights.records()].find((record) => record.uint(0) === DEFAULT_LIGHT) ?? null;
  if (!light) return null;
  const params = light.uint(LIGHT_PARAMS);
  const colour = (closeBand) => {
    const close = bandsById.get(params * BANDS_PER_PARAMS - 17 + closeBand);
    const far = bandsById.get(params * BANDS_PER_PARAMS - 17 + closeBand + 1);
    const a = close && bandColourAt(close, NOON);
    const b = far && bandColourAt(far, NOON);
    if (!a || !b) return a ?? b ?? null;
    return a.map((value, channel) => (value + b[channel]) / 2);
  };
  return { water: colour(BAND_RIVER_CLOSE), ocean: colour(BAND_OCEAN_CLOSE) };
}

// Terrain liquids. A chunk's liquid is an 8 × 8 grid of tiles, columns
// running east (server −Y) and rows south (server −X) from the chunk's
// corner, like its ground.
const MCNK_HEADER_SIZE = 128;
const MCNK_FLAGS = 0x00;
const MCNK_MCVT_OFFSET = 0x14;
const MCNK_MCLQ_OFFSET = 0x60;
const MCNK_MCLQ_SIZE = 0x64;
const MCNK_POSITION = 0x68;
const CHUNK_TILES = 8;
// MCLQ: one layer per kind the chunk's flags name (river, ocean, magma,
// slime), each heights and tile flags for 9 × 9 vertices and 8 × 8 tiles,
// then flow data. As LiquidType IDs.
const MCLQ_KINDS = [[0x04, 1], [0x08, 2], [0x10, 3], [0x20, 4]];
const MCLQ_VERTEX_SIZE = 8;
const MCLQ_LAYER_SIZE = 8 + 81 * MCLQ_VERTEX_SIZE + 64 + 4 + 80;
// MH2O: per chunk (offset, layer count, attributes), each layer 24 bytes.
const MH2O_CHUNK_SIZE = 12;
const MH2O_LAYER_SIZE = 24;
// MH2O vertex formats without heights (a flat surface at the layer's height).
const MH2O_DEPTH_ONLY = 2;

// A chunk's lowest ground height under each of its tiles (8 × 8), from its
// heights (MCVT: 9 × 9 outer and 8 × 8 centre, relative to its corner).
function tileGround(mcnk) {
  const ground = new Float32Array(64).fill(-Infinity);
  const offset = mcnk.readUInt32LE(MCNK_MCVT_OFFSET);
  if (!offset || offset + 145 * 4 > mcnk.length) return ground;
  const base = mcnk.readFloatLE(MCNK_POSITION + 8);
  const height = (index) => base + mcnk.readFloatLE(offset + index * 4);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      ground[row * 8 + column] = Math.min(
        height(row * 17 + column), height(row * 17 + column + 1),
        height((row + 1) * 17 + column), height((row + 1) * 17 + column + 1),
        height(row * 17 + 9 + column),
      );
    }
  }
  return ground;
}

// A chunk's MCLQ layers as grids over the whole chunk.
function readMclq(mcnk) {
  const flags = mcnk.readUInt32LE(MCNK_FLAGS);
  const offset = mcnk.readUInt32LE(MCNK_MCLQ_OFFSET);
  if (mcnk.readUInt32LE(MCNK_MCLQ_SIZE) <= 8 || !offset) return [];
  const layers = [];
  let start = offset;
  for (const [flag, typeId] of MCLQ_KINDS) {
    if (!(flags & flag)) continue;
    if (start + MCLQ_LAYER_SIZE > mcnk.length) break;
    const heights = Float32Array.from({ length: 81 }, (_, index) => mcnk.readFloatLE(start + 8 + index * MCLQ_VERTEX_SIZE + 4));
    const tiles = mcnk.subarray(start + 8 + 81 * MCLQ_VERTEX_SIZE, start + 8 + 81 * MCLQ_VERTEX_SIZE + 64);
    layers.push({ typeId, x0: 0, y0: 0, xTiles: 8, yTiles: 8, heights, wet: (x, y) => (tiles[y * 8 + x] & 0x0F) !== TILE_NO_LIQUID });
    start += MCLQ_LAYER_SIZE;
  }
  return layers;
}

// Chunk `index`'s MH2O layers as grids over their part of the chunk.
function readMh2o(mh2o, index) {
  const header = index * MH2O_CHUNK_SIZE;
  if (header + MH2O_CHUNK_SIZE > mh2o.length) return [];
  const offset = mh2o.readUInt32LE(header);
  const count = mh2o.readUInt32LE(header + 4);
  const layers = [];
  for (let layer = 0; layer < count && offset; layer += 1) {
    const base = offset + layer * MH2O_LAYER_SIZE;
    if (base + MH2O_LAYER_SIZE > mh2o.length) break;
    const typeId = mh2o.readUInt16LE(base);
    const format = mh2o.readUInt16LE(base + 2);
    const minHeight = mh2o.readFloatLE(base + 4);
    const [x0, y0, xTiles, yTiles] = [mh2o[base + 12], mh2o[base + 13], mh2o[base + 14], mh2o[base + 15]];
    const maskOffset = mh2o.readUInt32LE(base + 16);
    const vertexOffset = mh2o.readUInt32LE(base + 20);
    if (!xTiles || !yTiles || x0 + xTiles > CHUNK_TILES || y0 + yTiles > CHUNK_TILES) continue;
    const vertexCount = (xTiles + 1) * (yTiles + 1);
    const hasHeights = vertexOffset && format !== MH2O_DEPTH_ONLY && vertexOffset + vertexCount * 4 <= mh2o.length;
    const heights = Float32Array.from({ length: vertexCount }, (_, vertex) => (hasHeights ? mh2o.readFloatLE(vertexOffset + vertex * 4) : minHeight));
    // One bit per tile, row by row, low bit first; no mask means all.
    const wet = maskOffset
      ? (x, y) => {
        const bit = y * xTiles + x;
        const byte = maskOffset + (bit >> 3);
        return byte < mh2o.length && Boolean(mh2o[byte] & (1 << (bit & 7)));
      }
      : () => true;
    layers.push({ typeId, x0, y0, xTiles, yTiles, heights, wet });
  }
  return layers;
}

// One ADT tile's liquid surfaces by LiquidType ID, for chunks overlapping
// `area` (see terrain.mjs's chunkInArea). Tiles lying wholly under the
// ground are left out (Utgarde Keep has a sea far below its mountain).
export function adtLiquidSurfaces(adtBuffer, { inArea = () => true, repeat = LIQUID_UNIT * 2 } = {}) {
  const chunks = readChunks(adtBuffer);
  const mh2o = findChunk(chunks, 'MH2O');
  const surfaces = new Map();
  chunks.filter((chunk) => chunk.id === 'MCNK').forEach(({ data: mcnk }, index) => {
    if (mcnk.length < MCNK_HEADER_SIZE) return;
    const position = readFloats(mcnk, MCNK_POSITION, 3);
    if (!inArea(position)) return;
    const layers = mh2o?.length ? readMh2o(mh2o, index) : readMclq(mcnk);
    if (!layers.length) return;
    const ground = tileGround(mcnk);
    for (const layer of layers) {
      const { x0, y0, xTiles, heights } = layer;
      const top = (x, y) => Math.max(heights[y * (xTiles + 1) + x], heights[y * (xTiles + 1) + x + 1],
        heights[(y + 1) * (xTiles + 1) + x], heights[(y + 1) * (xTiles + 1) + x + 1]);
      if (!surfaces.has(layer.typeId)) surfaces.set(layer.typeId, new LiquidSurface(repeat));
      surfaces.get(layer.typeId).add({
        ...layer,
        wet: (x, y) => layer.wet(x, y) && top(x, y) >= ground[(y0 + y) * 8 + x0 + x],
        place: (x, y) => [position[0] - (y0 + y) * LIQUID_UNIT, position[1] - (x0 + x) * LIQUID_UNIT],
      });
    }
  });
  const finished = new Map();
  for (const [typeId, surface] of surfaces) {
    const result = surface.finish();
    if (result) finished.set(typeId, result);
  }
  return finished;
}

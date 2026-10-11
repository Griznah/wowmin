// Builds <mapId>.glb for one instance map: every placed WMO with its groups
// and doodad set, and the doodads placed directly on ADT tiles and the ADT
// terrain within the area players use. Node transforms keep server world coordinates
// under a single Z-up to Y-up root, so the renderer can place telemetry
// directly.

import fs from 'node:fs';
import path from 'node:path';

import { Document, NodeIO, TextureInfo } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

import { loadM2, M2_MATERIAL_FLAG_TWO_SIDED, M2_TEXTURE_FLAG_WRAP_S, M2_TEXTURE_FLAG_WRAP_T } from './m2.mjs';
import { findChunk, readChunks } from './chunks.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt } from './placement.mjs';
import { PNG } from 'pngjs';

import { ATLAS_SIZE, buildTerrainTile, chunkInArea, playArea, pointInArea, WDT_FLAG_BIG_ALPHA } from './terrain.mjs';
import { readDbc } from './dbc.mjs';
import { adtLiquidSurfaces, firstTileType, liquidSurface, liquidTypeInfo, mapLiquidColours, wmoLiquidType } from './liquids.mjs';
import { encodeTexture } from './textures.mjs';
import {
  loadWmo,
  selectDoodadIndices,
  WMO_GROUP_FLAG_EXTERIOR,
  WMO_MATERIAL_FLAG_CLAMP_S,
  WMO_MATERIAL_FLAG_CLAMP_T,
  WMO_MATERIAL_FLAG_UNCULLED,
} from './wmo.mjs';

// -90° about X: (x, y, z) Z-up becomes (x, z, -y) Y-up.
const Z_UP_TO_Y_UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const DUNGEON_MAP_CHUNK_NO_MIN_Z = -9999;
// Ground textures are tileable and small; the renderer resamples them into
// one texture array.
const TERRAIN_TEXTURE_MAX = 256;
const LIQUID_TEXTURE_MAX = 128;

const WMO_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'mod', 'mod2x'];
const M2_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'add', 'mod', 'mod2x'];

export function rotateByQuaternion([x, y, z], [qx, qy, qz, qw]) {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

export function transformBoundingBox([minX, minY, minZ, maxX, maxY, maxZ], { position, rotation, scale = 1 }) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        const [rx, ry, rz] = rotateByQuaternion([x * scale, y * scale, z * scale], rotation);
        const world = [rx + position[0], ry + position[1], rz + position[2]];
        bounds.minX = Math.min(bounds.minX, world[0]); bounds.maxX = Math.max(bounds.maxX, world[0]);
        bounds.minY = Math.min(bounds.minY, world[1]); bounds.maxY = Math.max(bounds.maxY, world[1]);
        bounds.minZ = Math.min(bounds.minZ, world[2]); bounds.maxZ = Math.max(bounds.maxZ, world[2]);
      }
    }
  }
  return bounds;
}

// The scene as GLB with its geometry meshopt-compressed (EXT_meshopt_compression,
// which three.js decodes). Filter mode: lossless, except normals are stored
// as 8-bit octahedral vectors. Textures are already compressed images.
async function writeCompressed(document) {
  await MeshoptEncoder.ready;
  // The encoder takes whole triangles only; a few client meshes end in a
  // partial one (Ruins of Ahn'Qiraj), which draws nothing anyway.
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const count = indices?.getCount() ?? 0;
      if (indices && count % 3) indices.setArray(indices.getArray().slice(0, count - (count % 3)));
    }
  }
  document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  return new NodeIO().registerExtensions([EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
    .writeBinary(document);
}

// The box players can reach: the buildings in the play area (`area`, a list
// of boxes; empty for all of them), the map's graveyards and start points
// (`points`, [x, y, z]), and any building within SAFE_POINT_REACH yards of
// one (a battleground's start platforms, outside its world map). Players
// don't get beyond the outermost buildings, above the tallest roof, or below
// the lowest foundation, so the viewer leaves out what lies beyond (the
// mountains around a battleground and the flat ground past them). Null when
// there is nothing to go by.
const SAFE_POINT_REACH = 100;

export function buildingReach(groups, area, points = []) {
  const inArea = (group) => !area.length || area.some((box) =>
    group.minX <= box.maxX && group.maxX >= box.minX && group.minY <= box.maxY && group.maxY >= box.minY);
  const nearPoint = (group) => points.some(([x, y]) => Math.hypot(
    Math.max(group.minX - x, 0, x - group.maxX), Math.max(group.minY - y, 0, y - group.maxY)) <= SAFE_POINT_REACH);
  const boxes = [
    ...groups.filter((group) => inArea(group) || nearPoint(group)),
    ...points.map(([x, y, z]) => ({ minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z })),
  ];
  if (!boxes.length) return null;
  const low = (key) => Math.min(...boxes.map((box) => box[key]));
  const high = (key) => Math.max(...boxes.map((box) => box[key]));
  return { minX: low('minX'), maxX: high('maxX'), minY: low('minY'), maxY: high('maxY'), minZ: low('minZ'), maxZ: high('maxZ') };
}

// The map's graveyards and start points (WorldSafeLocs.dbc: map, x, y, z),
// places players are sure to reach.
export function safePoints(readFile, mapId) {
  const buffer = readFile('DBFilesClient\\WorldSafeLocs.dbc');
  if (!buffer) return [];
  const points = [];
  for (const record of readDbc(buffer).records()) {
    if (record.uint(1) === mapId) points.push([record.float(2), record.float(3), record.float(4)]);
  }
  return points;
}

// A floor's height range is the union of its WMO groups' ranges. Groups shared
// between floors (DungeonMapChunk rows with a real minZ) split at that height.
export function computeFloorHeights(floors, groups) {
  const groupRange = (wmoGroupId) => {
    const matches = groups.filter((group) => group.wmoGroupId === wmoGroupId);
    return matches.length
      ? { minZ: Math.min(...matches.map((group) => group.minZ)), maxZ: Math.max(...matches.map((group) => group.maxZ)) }
      : null;
  };
  const splits = (wmoGroupId) => floors.flatMap((floor) => floor.chunks)
    .filter((chunk) => chunk.wmoGroupId === wmoGroupId && chunk.minZ > DUNGEON_MAP_CHUNK_NO_MIN_Z)
    .map((chunk) => chunk.minZ);

  return floors.map((floor) => {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const chunk of floor.chunks) {
      const range = groupRange(chunk.wmoGroupId);
      if (!range) continue;
      const lower = chunk.minZ > DUNGEON_MAP_CHUNK_NO_MIN_Z ? Math.max(chunk.minZ, range.minZ) : range.minZ;
      const upper = Math.min(range.maxZ, ...splits(chunk.wmoGroupId).filter((split) => split > lower));
      minZ = Math.min(minZ, lower);
      maxZ = Math.max(maxZ, upper);
    }
    return Number.isFinite(minZ) ? { id: floor.id, minZ, maxZ } : null;
  }).filter(Boolean);
}

function bgraToRgba(colors) {
  const rgba = new Uint8Array(colors.length);
  for (let index = 0; index < colors.length; index += 4) {
    rgba[index] = colors[index + 2];
    rgba[index + 1] = colors[index + 1];
    rgba[index + 2] = colors[index];
    rgba[index + 3] = 255;
  }
  return rgba;
}

class SceneBuilder {
  constructor({ mapId, readFile, textureMax }) {
    this.mapId = mapId;
    this.readFile = readFile;
    this.textureMax = textureMax;
    this.document = new Document();
    this.buffer = this.document.createBuffer();
    this.textures = new Map();
    this.models = new Map();
    this.missing = new Set();
  }

  // A liquid type's material, named liquid-<id>, with its animation frames
  // as materials liquid-frame-<n>, shared by types with the same texture
  // (extras list them, and water's colour); null if unknown.
  liquidMaterial(typeId) {
    this.liquidMaterials ??= new Map();
    if (this.liquidMaterials.has(typeId)) return this.liquidMaterials.get(typeId);
    this.liquidTypes ??= (() => {
      const buffer = this.readFile('DBFilesClient\\LiquidType.dbc');
      return buffer ? readDbc(buffer).byId() : new Map();
    })();
    const info = liquidTypeInfo(this.liquidTypes, typeId, this.readFile);
    let material = null;
    if (info?.frames.length) {
      this.liquidFrames ??= new Map();
      const frames = info.frames.flatMap((name) => {
        const key = name.toLowerCase();
        if (!this.liquidFrames.has(key)) {
          let frameName = null;
          try {
            const encoded = encodeTexture(this.readFile(name), LIQUID_TEXTURE_MAX);
            const image = this.document.createTexture(path.win32.basename(name)).setImage(encoded.data).setMimeType(encoded.mimeType);
            frameName = `liquid-frame-${this.liquidFrames.size}`;
            this.document.createMaterial(frameName).setBaseColorTexture(image);
          } catch {
            // An unreadable frame is skipped.
          }
          this.liquidFrames.set(key, frameName);
        }
        const frameName = this.liquidFrames.get(key);
        return frameName ? [frameName] : [];
      });
      if (frames.length) {
        const color = info.kind === 'water' || info.kind === 'ocean' ? this.liquidColours()?.[info.kind] : null;
        material = this.document.createMaterial(`liquid-${typeId}`).setDoubleSided(true)
          .setExtras({ wowLiquid: { id: typeId, kind: info.kind, frames, ...(color && { color }) } });
      }
    }
    this.liquidMaterials.set(typeId, material);
    return material;
  }

  // The map's water and ocean colours, from its light; null if unknown.
  liquidColours() {
    if (this.waterColours === undefined) {
      const lights = this.readFile('DBFilesClient\\Light.dbc');
      const bands = this.readFile('DBFilesClient\\LightIntBand.dbc');
      this.waterColours = lights && bands ? mapLiquidColours(readDbc(lights), readDbc(bands).byId(), this.mapId) : null;
    }
    return this.waterColours;
  }

  accessor(type, array, normalized = false) {
    return this.document.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(this.buffer);
  }

  indexAccessor(source, start, count) {
    const slice = source.subarray(start, start + count);
    const max = slice.reduce((highest, value) => Math.max(highest, value), 0);
    return this.accessor('SCALAR', max > 0xFFFF ? Uint32Array.from(slice) : Uint16Array.from(slice));
  }

  texture(name) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (this.textures.has(key)) return this.textures.get(key);
    let texture = null;
    const blp = this.readFile(name);
    if (blp) {
      try {
        const encoded = encodeTexture(blp, this.textureMax);
        texture = this.document.createTexture(path.basename(name)).setImage(encoded.data).setMimeType(encoded.mimeType);
      } catch (error) {
        console.warn(`  ! Could not decode ${name}: ${error instanceof Error ? error.message : error}`);
      }
    } else {
      this.missing.add(name);
    }
    this.textures.set(key, texture);
    return texture;
  }

  material(name, { texture, blend, doubleSided, wrapS, wrapT, tint = [1, 1, 1], opacity = 1 }) {
    const material = this.document.createMaterial(name)
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setBaseColorFactor([...tint, opacity])
      .setDoubleSided(doubleSided)
      .setExtras({ wowBlend: blend });
    if (blend === 'alphaKey') material.setAlphaMode('MASK').setAlphaCutoff(0.5);
    else if (blend !== 'opaque' || opacity < 1) material.setAlphaMode('BLEND');
    const image = this.texture(texture);
    if (image) {
      material.setBaseColorTexture(image);
      material.getBaseColorTextureInfo()
        .setWrapS(wrapS ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE)
        .setWrapT(wrapT ? TextureInfo.WrapMode.REPEAT : TextureInfo.WrapMode.CLAMP_TO_EDGE);
    }
    return material;
  }

  wmoMeshes(wmo, rootName) {
    const materials = wmo.materials.map((material, index) => this.material(`${path.basename(rootName)}#${index}`, {
      texture: material.texture,
      blend: WMO_BLEND[material.blendMode] ?? 'opaque',
      doubleSided: Boolean(material.flags & WMO_MATERIAL_FLAG_UNCULLED),
      wrapS: !(material.flags & WMO_MATERIAL_FLAG_CLAMP_S),
      wrapT: !(material.flags & WMO_MATERIAL_FLAG_CLAMP_T),
    }));
    return wmo.groups.map((group) => {
      if (!group.batches.length) return null;
      const mesh = this.document.createMesh(`${path.basename(rootName)}_${group.index}`);
      const position = this.accessor('VEC3', group.positions);
      const normal = this.accessor('VEC3', group.normals);
      const uv = this.accessor('VEC2', group.uvs);
      const color = group.colors ? this.accessor('VEC4', bgraToRgba(group.colors), true) : null;
      for (const batch of group.batches) {
        const primitive = this.document.createPrimitive()
          .setAttribute('POSITION', position)
          .setAttribute('NORMAL', normal)
          .setAttribute('TEXCOORD_0', uv)
          .setIndices(this.indexAccessor(group.indices, batch.indexStart, batch.indexCount))
          .setMaterial(materials[batch.materialIndex] ?? null);
        if (color) primitive.setAttribute('COLOR_0', color);
        mesh.addPrimitive(primitive);
      }
      return mesh;
    });
  }

  m2Mesh(modelName) {
    const key = modelName.toLowerCase();
    if (this.models.has(key)) return this.models.get(key);
    let mesh = null;
    const model = loadM2(modelName, this.readFile);
    if (model) {
      mesh = this.document.createMesh(path.basename(modelName));
      const position = this.accessor('VEC3', model.positions);
      const normal = this.accessor('VEC3', model.normals);
      const uv = this.accessor('VEC2', model.uvs);
      const materials = new Map();
      for (const batch of model.batches) {
        if (batch.opacity <= 0) continue;
        const materialKey = [batch.texture, batch.blend, batch.materialFlags, batch.textureFlags, ...batch.tint, batch.opacity].join('|');
        if (!materials.has(materialKey)) {
          materials.set(materialKey, this.material(`${path.basename(modelName)}#${materials.size}`, {
            texture: batch.texture,
            blend: M2_BLEND[batch.blend] ?? 'opaque',
            doubleSided: Boolean(batch.materialFlags & M2_MATERIAL_FLAG_TWO_SIDED),
            wrapS: Boolean(batch.textureFlags & M2_TEXTURE_FLAG_WRAP_S),
            wrapT: Boolean(batch.textureFlags & M2_TEXTURE_FLAG_WRAP_T),
            tint: batch.tint,
            opacity: batch.opacity,
          }));
        }
        mesh.addPrimitive(this.document.createPrimitive()
          .setAttribute('POSITION', position)
          .setAttribute('NORMAL', normal)
          .setAttribute('TEXCOORD_0', uv)
          .setIndices(this.indexAccessor(model.indices, batch.indexStart, batch.indexCount))
          .setMaterial(materials.get(materialKey)));
      }
    } else {
      this.missing.add(modelName);
    }
    this.models.set(key, mesh);
    return mesh;
  }
}

export async function exportMapScene({
  mapId, internalName, readFile, outputDir, textureMax = 512, floors = [], worldMapBounds = null,
}) {
  const mapPath = `World\\maps\\${internalName}\\${internalName}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) throw new Error(`Missing ${mapPath}.wdt`);
  const wdt = readWdt(wdtBuffer);

  let wmoPlacements = wdt.wmo ? [wdt.wmo] : [];
  let doodadPlacements = [];
  if (!wdt.wmoOnly) {
    const tiles = wdt.tiles.map(({ x, y }) => readFile(`${mapPath}_${x}_${y}.adt`)).filter(Boolean).map(readAdtPlacements);
    wmoPlacements = dedupeByUniqueId(tiles.flatMap((tile) => tile.wmos));
    doodadPlacements = dedupeByUniqueId(tiles.flatMap((tile) => tile.doodads));
  }
  if (!wmoPlacements.length && !doodadPlacements.length) throw new Error(`${internalName} places no buildings or doodads.`);

  const builder = new SceneBuilder({ mapId, readFile, textureMax });
  const { document } = builder;
  const root = document.createNode('wow-world').setRotation(Z_UP_TO_Y_UP);
  document.createScene(`map-${mapId}`).addChild(root);

  const groups = [];
  const skippedWmos = [];
  let doodadCount = 0;
  let liquidCount = 0;
  for (const placement of wmoPlacements) {
    let wmo;
    try {
      wmo = loadWmo(placement.name, readFile);
    } catch (error) {
      skippedWmos.push(`${placement.name} (${error instanceof Error ? error.message : error})`);
      continue;
    }
    const wmoNode = document.createNode(path.basename(placement.name))
      .setTranslation(placement.position)
      .setRotation(placement.rotation)
      .setScale([placement.scale, placement.scale, placement.scale]);
    root.addChild(wmoNode);

    const meshes = builder.wmoMeshes(wmo, placement.name);
    const doodadGroups = new Map();
    wmo.groups.forEach((group, index) => {
      const bounds = transformBoundingBox(group.boundingBox, placement);
      const exterior = Boolean(group.flags & WMO_GROUP_FLAG_EXTERIOR);
      for (const doodadIndex of group.doodadRefs) doodadGroups.set(doodadIndex, group.groupId);
      if (!meshes[index]) return;
      groups.push({ wmoGroupId: group.groupId, exterior, ...bounds });
      wmoNode.addChild(document.createNode(`group-${group.index}`)
        .setMesh(meshes[index])
        .setExtras({ kind: 'wmoGroup', wmoGroupId: group.groupId, exterior, minZ: bounds.minZ, maxZ: bounds.maxZ }));
    });

    // Each group's liquid, in the group's space under the building.
    wmo.groups.forEach((group) => {
      if (!group.liquid) return;
      const surface = liquidSurface(group.liquid);
      const typeId = wmoLiquidType(group.liquid.groupLiquid, wmo.rootFlags, group.flags, firstTileType(group.liquid));
      const material = surface && builder.liquidMaterial(typeId);
      if (!material) return;
      const mesh = document.createMesh(`liquid-${group.groupId}`).addPrimitive(document.createPrimitive()
        .setAttribute('POSITION', builder.accessor('VEC3', surface.positions))
        .setAttribute('TEXCOORD_0', builder.accessor('VEC2', surface.uvs))
        .setIndices(builder.accessor('SCALAR', surface.indices))
        .setMaterial(material));
      wmoNode.addChild(document.createNode(`liquid-${group.index}`).setMesh(mesh)
        .setExtras({ kind: 'liquid', wmoGroupId: group.groupId }));
      liquidCount += 1;
    });

    for (const doodadIndex of selectDoodadIndices(wmo.sets, placement.doodadSet)) {
      const definition = wmo.definitions[doodadIndex];
      const mesh = definition && builder.m2Mesh(definition.name);
      if (!mesh) continue;
      wmoNode.addChild(document.createNode(`doodad-${doodadIndex}`)
        .setMesh(mesh)
        .setTranslation(definition.position)
        .setRotation(definition.rotation)
        .setScale([definition.scale, definition.scale, definition.scale])
        .setExtras({ kind: 'doodad', wmoGroupId: doodadGroups.get(doodadIndex) ?? null }));
      doodadCount += 1;
    }
  }

  // The area players use: each dungeon map floor, the world map bounds, or
  // the buildings' area (see playArea). Loose props and the ground are
  // cropped to it; with nothing to go by, props are all kept.
  const area = wdt.wmoOnly ? [] : playArea(floors, worldMapBounds, undefined, groups);
  const looseDoodads = area.length
    ? doodadPlacements.filter((placement) => pointInArea(placement.position, area))
    : doodadPlacements;
  for (const placement of looseDoodads) {
    const mesh = builder.m2Mesh(placement.name);
    if (!mesh) continue;
    root.addChild(document.createNode(`doodad-${placement.uniqueId}`)
      .setMesh(mesh)
      .setTranslation(placement.position)
      .setRotation(placement.rotation)
      .setScale([placement.scale, placement.scale, placement.scale])
      .setExtras({ kind: 'doodad', wmoGroupId: null }));
    doodadCount += 1;
  }

  // Terrain, cropped to the area players use (placeholder tiles are skipped).
  // A map with no floors, world map bounds, or buildings to go by gets none.
  const terrain = { tiles: 0, chunks: 0, bounds: null };
  if (area.length) {
    const bigAlpha = Boolean(findChunk(readChunks(wdtBuffer), 'MPHD').readUInt32LE(0) & WDT_FLAG_BIG_ALPHA);
    const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
    const accessor = (type, array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    // Each ground texture once, as a material named for its layer index.
    const layerNames = [];
    const layerIndex = new Map();
    const textureIndex = (name) => {
      const key = name.toLowerCase();
      if (layerIndex.has(key)) return layerIndex.get(key);
      const blp = readFile(name);
      let index = -1;
      if (blp) {
        try {
          const encoded = encodeTexture(blp, TERRAIN_TEXTURE_MAX);
          const image = document.createTexture(path.win32.basename(name)).setImage(encoded.data).setMimeType(encoded.mimeType);
          index = layerNames.length;
          layerNames.push(`terrain-layer-${index}`);
          document.createMaterial(`terrain-layer-${index}`).setBaseColorTexture(image);
        } catch (error) {
          console.warn(`  ! Ground texture ${name} unreadable: ${error instanceof Error ? error.message : error}`);
        }
      }
      layerIndex.set(key, index);
      return index;
    };
    for (const { x, y } of wdt.tiles) {
      const adt = readFile(`${mapPath}_${x}_${y}.adt`);
      if (!adt) continue;
      // The tile's liquids, one mesh per liquid type.
      try {
        for (const [typeId, surface] of adtLiquidSurfaces(adt, { inArea: (position) => chunkInArea(position, area) })) {
          const liquidMaterial = builder.liquidMaterial(typeId);
          if (!liquidMaterial) continue;
          const liquidMesh = document.createMesh(`liquid-${x}-${y}-${typeId}`).addPrimitive(document.createPrimitive()
            .setAttribute('POSITION', accessor('VEC3', surface.positions))
            .setAttribute('TEXCOORD_0', accessor('VEC2', surface.uvs))
            .setIndices(accessor('SCALAR', surface.indices))
            .setMaterial(liquidMaterial));
          root.addChild(document.createNode(`liquid-${x}-${y}-${typeId}`).setMesh(liquidMesh).setExtras({ kind: 'liquid', tile: [x, y] }));
          liquidCount += 1;
        }
      } catch (error) {
        console.warn(`  ! Liquids in tile ${x},${y} unreadable: ${error instanceof Error ? error.message : error}`);
      }
      let tile;
      try {
        tile = buildTerrainTile(adt, { bigAlpha, area, textureIndex });
      } catch (error) {
        console.warn(`  ! Terrain tile ${x},${y} unreadable: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      if (!tile) continue;
      // The tile's layer alphas and shadow, lossless.
      const atlas = document.createTexture(`terrain-alpha-${x}-${y}`).setMimeType('image/png')
        .setImage(PNG.sync.write({ width: ATLAS_SIZE, height: ATLAS_SIZE, data: Buffer.from(tile.atlas.buffer) }));
      document.createMaterial(`terrain-alpha-${x}-${y}`).setBaseColorTexture(atlas);
      const material = document.createMaterial(`terrain-${x}-${y}`).setMetallicFactor(0).setRoughnessFactor(1)
        .setExtras({ wowTerrain: true, alpha: `terrain-alpha-${x}-${y}`, origin: tile.origin });
      const mesh = document.createMesh(`terrain-${x}-${y}`).addPrimitive(document.createPrimitive()
        .setAttribute('POSITION', accessor('VEC3', tile.positions))
        .setAttribute('NORMAL', accessor('VEC3', tile.normals))
        .setAttribute('COLOR_0', accessor('VEC3', tile.colors).setNormalized(true))
        .setAttribute('_LAYERS', accessor('VEC4', tile.layers))
        .setAttribute('_CELL', accessor('VEC2', tile.cells))
        .setIndices(accessor('SCALAR', tile.indices))
        .setMaterial(material));
      root.addChild(document.createNode(`terrain-${x}-${y}`).setMesh(mesh)
        .setExtras({ kind: 'terrain', tile: [x, y], minZ: tile.bounds.minZ, maxZ: tile.bounds.maxZ }));
      terrain.tiles += 1;
      terrain.chunks += tile.chunkCount;
      const b = tile.bounds;
      terrain.bounds = terrain.bounds ? {
        minX: Math.min(terrain.bounds.minX, b.minX), maxX: Math.max(terrain.bounds.maxX, b.maxX),
        minY: Math.min(terrain.bounds.minY, b.minY), maxY: Math.max(terrain.bounds.maxY, b.maxY),
        minZ: Math.min(terrain.bounds.minZ, b.minZ), maxZ: Math.max(terrain.bounds.maxZ, b.maxZ),
      } : b;
    }
    if (terrain.tiles) root.setExtras({ ...root.getExtras(), wowTerrainLayers: layerNames });
  }

  if (!groups.length && !doodadCount && !terrain.tiles) throw new Error(`${internalName} produced no drawable geometry.`);

  const file = `${mapId}.glb`;
  const glb = await writeCompressed(document);
  fs.writeFileSync(path.join(outputDir, file), glb);

  // Scenes with only loose doodads have no group bounds; pad their positions.
  const boundsSources = groups.length ? groups : looseDoodads.map(({ position: [x, y, z] }) => ({
    minX: x - 50, maxX: x + 50, minY: y - 50, maxY: y + 50, minZ: z - 50, maxZ: z + 50,
  }));
  const bounds = boundsSources.reduce((total, group) => ({
    minX: Math.min(total.minX, group.minX), maxX: Math.max(total.maxX, group.maxX),
    minY: Math.min(total.minY, group.minY), maxY: Math.max(total.maxY, group.maxY),
    minZ: Math.min(total.minZ, group.minZ), maxZ: Math.max(total.maxZ, group.maxZ),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });

  return {
    scene: {
      file,
      bounds,
      groups: groups.map(({ wmoGroupId, exterior, minZ, maxZ }) => ({ wmoGroupId, exterior, minZ, maxZ })),
      floors: computeFloorHeights(floors, groups),
      buildingReach: buildingReach(groups, area, safePoints(readFile, mapId)),
      ...(terrain.tiles ? { terrain: { tiles: terrain.tiles, chunks: terrain.chunks, bounds: terrain.bounds } } : {}),
    },
    stats: {
      liquidCount,
      terrainTiles: terrain.tiles,
      terrainChunks: terrain.chunks,
      bytes: glb.byteLength,
      wmoCount: wmoPlacements.length,
      groupCount: groups.length,
      doodadCount,
      modelCount: [...builder.models.values()].filter(Boolean).length,
      textureCount: [...builder.textures.values()].filter(Boolean).length,
      missing: [...builder.missing],
      skippedWmos,
    },
  };
}

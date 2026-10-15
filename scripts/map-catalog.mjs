// What the client's DBC files say about each map: its name and type
// (Map.dbc), the directories its art is filed under and its world-map bounds
// (WorldMapArea.dbc), and its dungeon floors (DungeonMap.dbc and
// DungeonMapChunk.dbc). The 2D map extraction and the 3D scene export both
// read it; neither reads the other's output.

const CLIENT_MAP_DIRECTORY_ALIASES = new Map([
  [389, ['Ragefire']],
]);

export function getClientMapDirectoryAliases(mapId) {
  return CLIENT_MAP_DIRECTORY_ALIASES.get(mapId) ?? [];
}

export const CONTINENTS = [
  {
    mapId: 0,
    label: 'Eastern Kingdoms',
    candidates: ['Azeroth', 'EasternKingdoms'],
  },
  {
    mapId: 1,
    label: 'Kalimdor',
    candidates: ['Kalimdor'],
  },
  {
    mapId: 530,
    label: 'Outland',
    candidates: ['Expansion01', 'Outland'],
  },
  {
    mapId: 571,
    label: 'Northrend',
    candidates: ['Northrend'],
  },
];

function readDbcString(buffer, stringBlockOffset, stringOffset) {
  if (stringOffset === 0) return '';
  const start = stringBlockOffset + stringOffset;
  let end = start;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', start, end);
}

export function parseMapDbc(buffer, requestedMapIds, allInstances = false) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'WDBC') {
    throw new Error('DBFilesClient/Map.dbc has an unsupported header.');
  }
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  if (fieldCount < 6 || recordSize < 24) {
    throw new Error(`DBFilesClient/Map.dbc has an unexpected layout (${fieldCount} fields, ${recordSize}-byte records).`);
  }
  const stringBlockOffset = 20 + recordCount * recordSize;
  const requested = new Set(requestedMapIds);
  const entries = [];
  const mapTypeLabels = ['world', 'instance', 'raid', 'battleground', 'arena'];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 20 + index * recordSize;
    const mapId = buffer.readUInt32LE(offset);
    const mapType = buffer.readUInt32LE(offset + 8);
    if (!(allInstances ? mapType >= 1 && mapType <= 4 : requested.has(mapId))) continue;
    const internalName = readDbcString(buffer, stringBlockOffset, buffer.readUInt32LE(offset + 4));
    const displayName = readDbcString(buffer, stringBlockOffset, buffer.readUInt32LE(offset + 20));
    entries.push({
      mapId,
      mapType,
      mapTypeLabel: mapTypeLabels[mapType] ?? `type-${mapType}`,
      label: displayName || internalName || `Map ${mapId}`,
      internalName,
      candidates: [internalName],
    });
  }
  return entries;
}

export function parseWorldMapAreaDbc(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'WDBC') return new Map();
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  if (fieldCount < 8 || recordSize < 32) return new Map();

  const boundsByMap = new Map();
  const stringBlockOffset = 20 + recordCount * recordSize;
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 20 + index * recordSize;
    const mapId = buffer.readUInt32LE(offset + 4);
    const y1 = buffer.readFloatLE(offset + 16);
    const y2 = buffer.readFloatLE(offset + 20);
    const x1 = buffer.readFloatLE(offset + 24);
    const x2 = buffer.readFloatLE(offset + 28);
    const directory = readDbcString(buffer, stringBlockOffset, buffer.readUInt32LE(offset + 12));
    const area = boundsByMap.get(mapId) ?? { bounds: null, directories: [] };
    boundsByMap.set(mapId, area);
    // Keep the directory even without bounds: a dungeon's art folder can sit
    // on a record whose bounds are zero, its floors placed by DungeonMap.dbc.
    if (directory && !area.directories.includes(directory)) area.directories.push(directory);
    if (![x1, x2, y1, y2].every(Number.isFinite) || x1 === x2 || y1 === y2) continue;
    // Don't let a sub-area overwrite the full-map projection (N adds many
    // microdungeon WorldMapArea entries).
    if (area.bounds && buffer.readUInt32LE(offset + 8) !== 0) continue;
    area.bounds = {
      minX: Math.min(x1, x2),
      maxX: Math.max(x1, x2),
      minY: Math.min(y1, y2),
      maxY: Math.max(y1, y2),
    };
  }
  return boundsByMap;
}

export function parseDungeonMapDbc(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'WDBC') return new Map();
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  if (fieldCount !== 8 || recordSize !== 32) return new Map();

  const floorsByMap = new Map();
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 20 + index * recordSize;
    const id = buffer.readUInt32LE(offset);
    const mapId = buffer.readUInt32LE(offset + 4);
    const floorIndex = buffer.readUInt32LE(offset + 8);
    const clientMinX = buffer.readFloatLE(offset + 12);
    const clientMaxX = buffer.readFloatLE(offset + 16);
    const clientMinY = buffer.readFloatLE(offset + 20);
    const clientMaxY = buffer.readFloatLE(offset + 24);
    if (![clientMinX, clientMaxX, clientMinY, clientMaxY].every(Number.isFinite)) continue;
    if (!floorsByMap.has(mapId)) floorsByMap.set(mapId, []);
    floorsByMap.get(mapId).push({
      id,
      floorIndex,
      bounds: {
        minX: Math.min(clientMinY, clientMaxY),
        maxX: Math.max(clientMinY, clientMaxY),
        minY: Math.min(clientMinX, clientMaxX),
        maxY: Math.max(clientMinX, clientMaxX),
      },
      chunks: [],
    });
  }
  for (const floors of floorsByMap.values()) floors.sort((left, right) => left.floorIndex - right.floorIndex);
  return floorsByMap;
}

export function parseDungeonMapChunkDbc(buffer, floorsByMap) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'WDBC') return;
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  if (fieldCount !== 5 || recordSize !== 20) return;

  const floorsById = new Map();
  for (const floors of floorsByMap.values()) {
    for (const floor of floors) floorsById.set(floor.id, floor);
  }
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 20 + index * recordSize;
    const mapId = buffer.readUInt32LE(offset + 4);
    const wmoGroupId = buffer.readUInt32LE(offset + 8);
    const dungeonMapId = buffer.readUInt32LE(offset + 12);
    const minZ = buffer.readFloatLE(offset + 16);
    const floor = floorsById.get(dungeonMapId);
    if (!floor || !floorsByMap.has(mapId) || !Number.isFinite(minZ)) continue;
    floor.chunks.push({ wmoGroupId, minZ });
  }
  for (const floors of floorsByMap.values()) {
    for (const floor of floors) floor.chunks.sort((left, right) => left.minZ - right.minZ);
  }
}

const MAP_TABLES = {
  map: 'DBFilesClient\\Map.dbc',
  worldMapArea: 'DBFilesClient\\WorldMapArea.dbc',
  dungeonMap: 'DBFilesClient\\DungeonMap.dbc',
  dungeonMapChunk: 'DBFilesClient\\DungeonMapChunk.dbc',
};

// The four tables as raw buffers (null where the client lacks one).
export function readMapTables(readFile) {
  return Object.fromEntries(Object.entries(MAP_TABLES).map(([key, fileName]) => [key, readFile(fileName)]));
}

// The requested maps (or every instance) from Map.dbc, continents keeping
// their known minimap directories.
export function resolveMapTargets(tables, requestedMapIds, allInstances = false) {
  if (!tables.map) throw new Error('Could not extract DBFilesClient/Map.dbc from the client.');
  const targets = parseMapDbc(tables.map, requestedMapIds, allInstances).map((target) => {
    const continent = target.mapType === 0 ? CONTINENTS.find((entry) => entry.mapId === target.mapId) : null;
    return continent ? { ...target, ...continent } : target;
  });
  const resolvedIds = new Set(targets.map((target) => target.mapId));
  const missing = requestedMapIds.filter((mapId) => !resolvedIds.has(mapId));
  if (missing.length > 0) throw new Error(`Map ID(s) not found in Map.dbc: ${missing.join(', ')}`);
  return targets;
}

// Adds what the other tables know to each target: directory aliases and
// WorldMapArea directories to `candidates`, `worldMapBounds`, and `floors`.
export function describeMaps(targets, tables, { aliases = true } = {}) {
  let described = targets;
  if (aliases) {
    described = described.map((target) => ({
      ...target,
      candidates: [...new Set([...getClientMapDirectoryAliases(target.mapId), ...target.candidates])],
    }));
  }
  if (tables.worldMapArea) {
    const boundsByMap = parseWorldMapAreaDbc(tables.worldMapArea);
    described = described.map((target) => {
      // A continent spans many WorldMapArea zones. Keep the terrain atlas,
      // rather than accidentally choosing one zone's parchment and bounds.
      if (target.mapType === 0 && CONTINENTS.some((entry) => entry.mapId === target.mapId)) return target;
      const area = boundsByMap.get(target.mapId);
      return {
        ...target,
        worldMapBounds: area?.bounds ?? null,
        candidates: [...new Set([...(area?.directories ?? []), ...target.candidates])],
      };
    });
  }
  if (tables.dungeonMap) {
    const floorsByMap = parseDungeonMapDbc(tables.dungeonMap);
    if (tables.dungeonMapChunk) parseDungeonMapChunkDbc(tables.dungeonMapChunk, floorsByMap);
    described = described.map((target) => ({ ...target, floors: floorsByMap.get(target.mapId) ?? [] }));
  }
  return described;
}

// One record per requested map (or every instance), in Map.dbc order.
export function buildMapCatalog(readFile, { mapIds = [], allInstances = false } = {}) {
  const tables = readMapTables(readFile);
  return describeMaps(resolveMapTargets(tables, mapIds, allInstances), tables);
}

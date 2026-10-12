const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const catalog = import(pathToFileURL(path.join(__dirname, 'map-catalog.mjs')).href);

test('resolves client artwork aliases missing from WorldMapArea', async () => {
  const { getClientMapDirectoryAliases } = await catalog;
  assert.deepEqual(getClientMapDirectoryAliases(389), ['Ragefire']);
  assert.deepEqual(getClientMapDirectoryAliases(33), []);
});

// A WDBC table: `write(buffer, offset, string)` fills each record, `string`
// returning the offset of a string it adds to the string block.
function dbc(fieldCount, recordSize, records) {
  const strings = ['\0'];
  let stringBytes = 1;
  const string = (value) => {
    const offset = stringBytes;
    strings.push(`${value}\0`);
    stringBytes += Buffer.byteLength(`${value}\0`);
    return offset;
  };
  const body = Buffer.alloc(records.length * recordSize);
  records.forEach((write, index) => write(body, index * recordSize, string));
  const block = Buffer.from(strings.join(''));
  const header = Buffer.alloc(20);
  header.write('WDBC');
  header.writeUInt32LE(records.length, 4);
  header.writeUInt32LE(fieldCount, 8);
  header.writeUInt32LE(recordSize, 12);
  header.writeUInt32LE(block.length, 16);
  return Buffer.concat([header, body, block]);
}

const mapRecord = (mapId, internalName, mapType, displayName) => (buffer, offset, string) => {
  buffer.writeUInt32LE(mapId, offset);
  buffer.writeUInt32LE(string(internalName), offset + 4);
  buffer.writeUInt32LE(mapType, offset + 8);
  buffer.writeUInt32LE(string(displayName), offset + 20);
};
const areaRecord = (mapId, areaId, directory, [y1, y2, x1, x2]) => (buffer, offset, string) => {
  buffer.writeUInt32LE(mapId, offset + 4);
  buffer.writeUInt32LE(areaId, offset + 8);
  buffer.writeUInt32LE(string(directory), offset + 12);
  [y1, y2, x1, x2].forEach((value, index) => buffer.writeFloatLE(value, offset + 16 + index * 4));
};
const floorRecord = (id, mapId, floorIndex, [minX, maxX, minY, maxY]) => (buffer, offset) => {
  buffer.writeUInt32LE(id, offset);
  buffer.writeUInt32LE(mapId, offset + 4);
  buffer.writeUInt32LE(floorIndex, offset + 8);
  [minX, maxX, minY, maxY].forEach((value, index) => buffer.writeFloatLE(value, offset + 12 + index * 4));
};
const chunkRecord = (mapId, wmoGroupId, floorId, minZ) => (buffer, offset) => {
  buffer.writeUInt32LE(mapId, offset + 4);
  buffer.writeUInt32LE(wmoGroupId, offset + 8);
  buffer.writeUInt32LE(floorId, offset + 12);
  buffer.writeFloatLE(minZ, offset + 16);
};

test('WorldMapArea resolves patched artwork directory without sub-area bounds replacement', async () => {
  const { parseWorldMapAreaDbc } = await catalog;
  const area = parseWorldMapAreaDbc(dbc(11, 44, [
    areaRecord(33, 209, 'ShadowfangKeep', [400, 100, 300, 50]),
    areaRecord(33, 209, 'OtherFloor', [1400, 1100, 1300, 1050]),
  ])).get(33);
  assert.deepEqual(area.directories, ['ShadowfangKeep', 'OtherFloor']);
  assert.deepEqual(area.bounds, { minX: 50, maxX: 300, minY: 100, maxY: 400 });
});

const CLIENT_TABLES = {
  'DBFilesClient\\Map.dbc': dbc(6, 24, [
    mapRecord(0, 'Azeroth', 0, 'Eastern Kingdoms'),
    mapRecord(109, 'SunkenTemple', 1, 'Sunken Temple'),
    mapRecord(489, 'PVPZone03', 3, 'Warsong Gulch'),
  ]),
  'DBFilesClient\\WorldMapArea.dbc': dbc(11, 44, [
    areaRecord(0, 0, 'Azeroth', [100, -100, 200, -200]),
    areaRecord(109, 1477, 'TheTempleOfAtalHakkar', [0, 0, 0, 0]),
    areaRecord(489, 3277, 'WarsongGulch', [1803, 641, 2041, 896]),
  ]),
  'DBFilesClient\\DungeonMap.dbc': dbc(8, 32, [
    floorRecord(7, 109, 2, [-200, -100, 300, 400]),
    floorRecord(6, 109, 1, [-150, -50, 250, 350]),
  ]),
  'DBFilesClient\\DungeonMapChunk.dbc': dbc(5, 20, [
    chunkRecord(109, 5206, 7, -91),
  ]),
};
const readClientTable = (fileName) => CLIENT_TABLES[fileName] ?? null;

test('the map catalogue describes every instance from the client tables', async () => {
  const { buildMapCatalog } = await catalog;
  const [temple, gulch, ...rest] = buildMapCatalog(readClientTable, { allInstances: true });
  assert.equal(rest.length, 0);
  assert.deepEqual(temple, {
    mapId: 109,
    mapType: 1,
    mapTypeLabel: 'instance',
    label: 'Sunken Temple',
    internalName: 'SunkenTemple',
    candidates: ['TheTempleOfAtalHakkar', 'SunkenTemple'],
    worldMapBounds: null,
    floors: [
      { id: 6, floorIndex: 1, bounds: { minX: 250, maxX: 350, minY: -150, maxY: -50 }, chunks: [] },
      { id: 7, floorIndex: 2, bounds: { minX: 300, maxX: 400, minY: -200, maxY: -100 }, chunks: [{ wmoGroupId: 5206, minZ: -91 }] },
    ],
  });
  assert.deepEqual(gulch.worldMapBounds, { minX: 896, maxX: 2041, minY: 641, maxY: 1803 });
  assert.deepEqual(gulch.candidates, ['WarsongGulch', 'PVPZone03']);
  assert.deepEqual(gulch.floors, []);
});

test('the map catalogue keeps a continent on its own minimap directories', async () => {
  const { buildMapCatalog } = await catalog;
  const [continent] = buildMapCatalog(readClientTable, { mapIds: [0] });
  assert.equal(continent.label, 'Eastern Kingdoms');
  assert.deepEqual(continent.candidates, ['Azeroth', 'EasternKingdoms']);
  assert.equal(continent.worldMapBounds, undefined);
});

test('the map catalogue rejects map IDs the client does not have', async () => {
  const { buildMapCatalog } = await catalog;
  assert.throws(() => buildMapCatalog(readClientTable, { mapIds: [109, 9999] }), /Map ID\(s\) not found in Map\.dbc: 9999/);
  assert.throws(() => buildMapCatalog(() => null, { mapIds: [109] }), /Could not extract DBFilesClient\/Map\.dbc/);
});

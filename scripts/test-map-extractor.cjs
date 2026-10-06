const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const extractor = import(pathToFileURL(path.join(__dirname, 'extract-map-assets.mjs')).href);

test('lettered locale patches override numbered patches in order', async () => {
  const { archivePriority } = await extractor;
  const names = ['patch-enUS-N.MPQ', 'patch-3.MPQ', 'locale-enUS.MPQ', 'patch-enUS-M.MPQ'];
  assert.deepEqual(names.sort((a, b) => archivePriority(a) - archivePriority(b)),
    ['locale-enUS.MPQ', 'patch-3.MPQ', 'patch-enUS-M.MPQ', 'patch-enUS-N.MPQ']);
});

test('cleans audited map-530 padding without removing real edge water', async () => {
  const { cleanMap530Placeholder } = await extractor;
  const image = {
    width: 2, height: 1,
    sourceHash: 'e485773cb19adf5400e575ee95367358eb5d9bf40b9017643d28b59664e2e847',
    data: Buffer.from([247, 245, 248, 255, 57, 97, 107, 255]),
  };
  assert.equal(cleanMap530Placeholder(image, 530), 1);
  assert.deepEqual([...image.data], [0, 0, 0, 255, 57, 97, 107, 255]);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
});

test('does not filter bright artwork from other maps or unknown source textures', async () => {
  const { cleanMap530Placeholder } = await extractor;
  const bytes = [247, 245, 248, 255];
  for (const [mapId, sourceHash] of [
    [571, 'e485773cb19adf5400e575ee95367358eb5d9bf40b9017643d28b59664e2e847'],
    [530, 'replacement-texture-from-a-different-client'],
  ]) {
    const image = { data: Buffer.from(bytes), sourceHash };
    assert.equal(cleanMap530Placeholder(image, mapId), 0);
    assert.deepEqual([...image.data], bytes);
  }
});

test('cleans audited opaque grey padding before JPEG encoding', async () => {
  const { cleanMap530Placeholder } = await extractor;
  const image = {
    sourceHash: '87f8863a2dea243d8e17dc650f0cd169a66f16e6d466bff60562a3236dba9347',
    data: Buffer.from([68, 67, 68, 255]),
  };
  assert.equal(cleanMap530Placeholder(image, 530), 1);
  assert.deepEqual([...image.data], [0, 0, 0, 255]);
});

test('WorldMapArea resolves patched artwork directory without sub-area bounds replacement', async () => {
  const { parseWorldMapAreaDbc } = await extractor;
  const strings = Buffer.from('\0ShadowfangKeep\0OtherFloor\0');
  const buffer = Buffer.alloc(20 + 2 * 44 + strings.length);
  buffer.write('WDBC');
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(11, 8);
  buffer.writeUInt32LE(44, 12);
  buffer.writeUInt32LE(strings.length, 16);
  strings.copy(buffer, 108);
  for (let index = 0; index < 2; index += 1) {
    const offset = 20 + index * 44;
    buffer.writeUInt32LE(33, offset + 4);
    buffer.writeUInt32LE(209, offset + 8);
    buffer.writeUInt32LE(index === 0 ? 1 : 16, offset + 12);
    [400, 100, 300, 50].forEach((value, component) =>
      buffer.writeFloatLE(value + index * 1000, offset + 16 + component * 4));
  }
  const area = parseWorldMapAreaDbc(buffer).get(33);
  assert.deepEqual(area.directories, ['ShadowfangKeep', 'OtherFloor']);
  assert.deepEqual(area.bounds, { minX: 50, maxX: 300, minY: 100, maxY: 400 });
});

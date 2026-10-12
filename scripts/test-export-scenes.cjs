const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const exporter = import(pathToFileURL(path.join(__dirname, 'export-scenes.mjs')).href);

test('scene export options need a source and maps', async () => {
  const { parseSceneArgs } = await exporter;
  const options = parseSceneArgs(['--source', '/wow', '--map', '489', '-m', '574', '--scene-texture-max', '256']);
  assert.deepEqual(options.mapIds, [489, 574]);
  assert.equal(options.textureMax, 256);
  assert.equal(options.source, path.resolve('/wow'));
  assert.equal(options.output, path.resolve('assets/instances'));
  assert.equal(parseSceneArgs(['--source', '/wow', '--all-instances']).allInstances, true);
  assert.throws(() => parseSceneArgs(['--map', '489']), /--source/);
  assert.throws(() => parseSceneArgs(['--source', '/wow']), /--map <id> or --all-instances/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--map', '1', '--all-instances']), /mutually exclusive/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--map', 'x']), /non-negative integers/);
  assert.throws(() => parseSceneArgs(['--source', '/wow', '--scenes']), /Unknown argument/);
});

test('a scene manifest names its map and carries the scene', async () => {
  const { sceneManifest, SCENE_SCHEMA_VERSION } = await exporter;
  const manifest = sceneManifest(
    { mapId: 109, label: 'Sunken Temple', mapType: 1, mapTypeLabel: 'instance', floors: [] },
    { file: '109.glb', bounds: { minX: 0 }, groups: [], floors: [] },
  );
  assert.deepEqual(manifest, {
    schemaVersion: SCENE_SCHEMA_VERSION, mapId: 109, label: 'Sunken Temple', mapType: 1, mapTypeLabel: 'instance',
    file: '109.glb', bounds: { minX: 0 }, groups: [], floors: [],
  });
});

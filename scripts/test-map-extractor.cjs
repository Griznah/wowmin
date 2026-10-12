const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const extractor = import(pathToFileURL(path.join(__dirname, 'extract-map-assets.mjs')).href);
const npmOptionNames = [
  'source', 'output', 'map', 'map_dir', 'workspace', 'quality', 'all_instances', 'keep_workspace',
];

function withNpmConfig(config, callback) {
  const previous = new Map();
  for (const name of npmOptionNames) {
    const key = `npm_config_${name}`;
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [name, value] of Object.entries(config)) process.env[`npm_config_${name}`] = value;
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parses extractor options passed after the npm argument separator', async () => {
  const { parseArgs } = await extractor;
  const options = withNpmConfig({}, () => parseArgs([
    '--source', '/tmp/wow-client', '--all-instances', '--quality', '100',
  ]));
  assert.equal(options.source, path.resolve('/tmp/wow-client'));
  assert.equal(options.allInstances, true);
  assert.equal(options.quality, 100);
  assert.equal(options.output, path.resolve('assets/instances'));
});

test('parses equals-style npm config options and raw boolean true', async () => {
  const { parseArgs } = await extractor;
  const options = withNpmConfig({
    source: '/tmp/wow-client', all_instances: 'true', quality: '100', keep_workspace: 'true',
  }, () => parseArgs([]));
  assert.equal(options.source, path.resolve('/tmp/wow-client'));
  assert.equal(options.allInstances, true);
  assert.equal(options.keepWorkspace, true);
  assert.equal(options.quality, 100);
  assert.equal(options.output, path.resolve('assets/instances'));
});

test('rejects spaced npm shorthand before positional values are misread', async () => {
  const { parseArgs } = await extractor;
  assert.throws(
    () => withNpmConfig({ source: 'true', all_instances: 'true', quality: 'true' },
      () => parseArgs(['/tmp/wow-client', '100'])),
    /npm consumed --source, --quality without their values.*standalone --/,
  );
});

test('points npm config scene options at the scene command', async () => {
  const { parseArgs } = await extractor;
  assert.throws(() => withNpmConfig({ source: '/tmp/wow-client', all_instances: 'true', scenes: 'true' }, () => parseArgs([])),
    /extract:scenes/);
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

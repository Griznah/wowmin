const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const extractor = import(pathToFileURL(path.join(__dirname, 'extract-player-icons.mjs')).href);

const rendererOutput = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../renderer/scripts/utils/player-icons.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const moduleValue = { exports: {} };
new Function('module', 'exports', 'require', rendererOutput)(moduleValue, moduleValue.exports, require);
const { getPlayerStateIndicators, getRacePortraitManifestKey, getResponsivePlayerIconScale } = moduleValue.exports;

test('crops class atlas coordinates without mixing adjacent icons', async () => {
  const { cropImage } = await extractor;
  const data = Buffer.alloc(4 * 2 * 4);
  for (let pixel = 0; pixel < 8; pixel += 1) {
    data[pixel * 4] = pixel;
    data[pixel * 4 + 3] = 255;
  }
  const cropped = cropImage({ width: 4, height: 2, data }, 0.25, 0.75, 0, 1);
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.deepEqual([cropped.data[0], cropped.data[4], cropped.data[8], cropped.data[12]], [1, 2, 5, 6]);
});

test('stacks at most three player states in documented priority order', () => {
  const states = getPlayerStateIndicators({
    alive: false,
    inCombat: true,
    onTaxi: true,
    mounted: true,
    sapped: true,
    stunned: true,
    spiritForm: true,
    waitingForResurrect: true,
  });
  assert.deepEqual(states.map((state) => state.key), ['spirit', 'resurrect', 'sap']);
});

test('uses male extracted portraits when legacy telemetry has no gender', () => {
  assert.equal(getRacePortraitManifestKey(1, undefined), '1:0');
  assert.equal(getRacePortraitManifestKey(1, 0), '1:0');
  assert.equal(getRacePortraitManifestKey(1, 1), '1:1');
});

test('scales canvas icons with zoom while keeping configurable bounds', () => {
  assert.equal(getResponsivePlayerIconScale(1.25, 1), 1.25);
  assert.equal(getResponsivePlayerIconScale(1.25, 4), 2.5);
  assert.equal(getResponsivePlayerIconScale(1.25, 16), 2.5);
  assert.equal(getResponsivePlayerIconScale(10, 1), 2.5);
});

test('uses death over movement and taxi over mounted in compact state stacks', () => {
  const states = getPlayerStateIndicators({
    alive: false,
    inCombat: false,
    onTaxi: true,
    mounted: true,
    sapped: false,
    stunned: false,
    spiritForm: false,
    waitingForResurrect: false,
  });
  assert.deepEqual(states.map((state) => state.key), ['death', 'taxi']);
});

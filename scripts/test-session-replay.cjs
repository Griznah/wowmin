const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../renderer/scripts/utils/session-replay.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const context = { module: { exports: {} } };
context.exports = context.module.exports;
vm.runInNewContext(output, context);
const { calculateSessionTotalsAt, formatSessionReplayTime, isSessionRouteDiscontinuity } = context.module.exports;

const record = {
  events: [
    { elapsedMs: 1000, type: 'kill', amount: 1 },
    { elapsedMs: 2000, type: 'loot', amount: 3 },
    { elapsedMs: 3000, type: 'death', amount: 1 },
    { elapsedMs: 4000, type: 'flag-capture', amount: 1 },
  ],
};

test('formats replay positions with stable minute and hour fields', () => {
  assert.equal(formatSessionReplayTime(65000), '1:05');
  assert.equal(formatSessionReplayTime(3661000), '1:01:01');
});

test('breaks replay routes across death, release, and teleport jumps', () => {
  assert.equal(isSessionRouteDiscontinuity(
    { x: 100, y: 100, alive: true },
    { x: 101, y: 101, alive: false },
  ), true);
  assert.equal(isSessionRouteDiscontinuity(
    { x: 100, y: 100, alive: false },
    { x: 175, y: 100, alive: false },
  ), true);
  assert.equal(isSessionRouteDiscontinuity(
    { x: 100, y: 100, alive: true },
    { x: 120, y: 100, alive: true },
  ), false);
});

test('calculates running totals at the seek position', () => {
  const middle = calculateSessionTotalsAt(record, 2500);
  assert.equal(middle.kills, 1);
  assert.equal(middle.lootItems, 3);
  assert.equal(middle.deaths, 0);
  const end = calculateSessionTotalsAt(record, 5000);
  assert.equal(end.deaths, 1);
  assert.equal(end.flagCaptures, 1);
});

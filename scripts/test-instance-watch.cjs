const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../renderer/scripts/utils/instance-watch.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const context = { module: { exports: {} } };
context.exports = context.module.exports;
vm.runInNewContext(output, context);
const {
  applyInstanceViewTransform,
  getBattlegroundObjectiveLabels,
  getBattlegroundStatusLabel,
  getBattlegroundStrategyLabel,
  getInstanceCoordinateBounds,
  getInstanceMapProfile,
  getInstanceProjectionViewport,
  getParticipantDungeonFloor,
  groupActiveInstanceSessions,
  parseInstanceSessionKey,
  projectInstancePosition,
  projectMinimapTilePosition,
  zoomInstanceViewAt,
} = context.module.exports;

function player(name, map, instanceId, x, y) {
  return { name, map, instanceId, position_x: x, position_y: y };
}

test('parses an active runtime session key into telemetry filters', () => {
  const parsed = parseInstanceSessionKey('489:12');
  assert.equal(parsed.mapId, 489);
  assert.equal(parsed.instanceId, 12);
  assert.equal(parseInstanceSessionKey('489'), null);
  assert.equal(parseInstanceSessionKey('489:0'), null);
});

test('decodes common battleground status, strategy, and objective states', () => {
  assert.equal(getBattlegroundStatusLabel(3), 'In progress');
  assert.equal(getBattlegroundStrategyLabel(2, 1), 'Offensive');
  const labels = getBattlegroundObjectiveLabels({
    mapId: 489,
    allianceScore: 1,
    hordeScore: 2,
    worldStates: [{ id: 2339, value: 2 }, { id: 2338, value: 1 }],
  });
  assert.equal(labels[0], 'Alliance flag: Carried');
  assert.equal(labels[1], 'Horde flag: At base');
});

test('groups only active runtime instances', () => {
  const sessions = groupActiveInstanceSessions([
    player('Outside', 0, 0, 0, 0),
    player('Alpha', 489, 12, 100, 200),
    player('Bravo', 489, 12, 110, 210),
    player('Charlie', 33, 99, -10, 20),
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].key, '489:12');
  assert.equal(sessions[0].players.length, 2);
});

test('labels map 628 as Isle of Conquest', () => {
  const [session] = groupActiveInstanceSessions([
    player('Alpha', 628, 12, 100, 200),
  ]);
  assert.equal(session.label, 'Isle of Conquest · #12');
});

test('selects dungeon floors independently from WMO group and coordinate bounds', () => {
  const floors = [
    { id: 10, floorIndex: 1, bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 }, chunks: [{ wmoGroupId: 50, minZ: 0 }] },
    { id: 11, floorIndex: 2, bounds: { minX: 100, maxX: 200, minY: 100, maxY: 200 }, chunks: [{ wmoGroupId: 51, minZ: 25 }] },
  ];
  assert.equal(getParticipantDungeonFloor({ position_x: 10, position_y: 10, position_z: 30, wmoGroupId: 51 }, floors).id, 11);
  assert.equal(getParticipantDungeonFloor({ position_x: 20, position_y: 20, position_z: 0, wmoGroupId: -1 }, floors).id, 10);
});

test('auto-fit projection keeps a single-player session visible', () => {
  const players = [player('Solo', 33, 4, 500, -200)];
  const bounds = getInstanceCoordinateBounds(players);
  const point = projectInstancePosition(players[0], bounds, 800, 600);
  assert.equal(point.x, 400);
  assert.equal(point.y, 300);
});

test('Warsong Gulch uses fixed client-calibrated bounds and swapped axes', () => {
  const profile = getInstanceMapProfile(489);
  assert.ok(profile);
  assert.equal(profile.source, 'WorldMapArea.dbc:443');
  const topLeft = projectInstancePosition({
    position_x: profile.bounds.maxX,
    position_y: profile.bounds.maxY,
  }, profile.bounds, 1200, 800);
  const bottomRight = projectInstancePosition({
    position_x: profile.bounds.minX,
    position_y: profile.bounds.minY,
  }, profile.bounds, 1200, 800);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);
  assert.equal(bottomRight.x, 1200);
  assert.equal(bottomRight.y, 800);
});

test('pan and anchored zoom preserve the selected map point', () => {
  const viewport = { x: 10, y: 20, width: 800, height: 600 };
  const transform = { zoom: 1.5, panX: 30, panY: -20 };
  const anchor = { x: 300, y: 250 };
  const before = applyInstanceViewTransform(viewport, transform);
  const relative = { x: (anchor.x - before.x) / before.width, y: (anchor.y - before.y) / before.height };
  const zoomed = zoomInstanceViewAt(transform, viewport, anchor.x, anchor.y, 2.5);
  const after = applyInstanceViewTransform(viewport, zoomed);
  assert.ok(Math.abs(after.x + relative.x * after.width - anchor.x) < 0.001);
  assert.ok(Math.abs(after.y + relative.y * after.height - anchor.y) < 0.001);
});

test('returning to normal zoom recenters the map', () => {
  const reset = zoomInstanceViewAt(
    { zoom: 2, panX: 180, panY: -90 },
    { x: 10, y: 20, width: 800, height: 600 },
    250,
    300,
    1,
  );
  assert.equal(reset.zoom, 1);
  assert.equal(reset.panX, 0);
  assert.equal(reset.panY, 0);
});

test('client map aspect is letterboxed instead of stretched', () => {
  const viewport = getInstanceProjectionViewport(1600, 900, 1.5);
  assert.equal(viewport.x, 125);
  assert.equal(viewport.y, 0);
  assert.equal(viewport.width, 1350);
  assert.equal(viewport.height, 900);
});

test('minimap tile projection aligns world coordinates with a cropped tile image', () => {
  const units = 533.3333333333334;
  const projection = {
    gridSize: 64,
    worldUnitsPerTile: units,
    minTileX: 25,
    maxTileX: 29,
    minTileY: 30,
    maxTileY: 34,
  };
  const topLeft = projectMinimapTilePosition({
    position_x: (32 - projection.minTileY) * units,
    position_y: (32 - projection.minTileX) * units,
  }, projection, 1280, 1280);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);
});

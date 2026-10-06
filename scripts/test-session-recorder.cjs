const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/session-recorder.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const moduleValue = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', output)(
  moduleValue,
  moduleValue.exports,
  require,
  __dirname,
  __filename,
);
const { SessionRecorder } = moduleValue.exports;

function snapshot(capturedAt, players, overrides = {}) {
  return {
    players,
    battlegrounds: [],
    instances: [],
    deaths: [],
    events: [],
    source: 'worldserver',
    capturedAt,
    ...overrides,
  };
}

function player(instanceId, startedAt = 100) {
  return {
    name: 'Jaspianus', map: 631, instanceId, position_x: 10, position_y: 20, position_z: 30,
    orientation: 1, level: 79, race: 1, class: 1, account: '1', accountId: 1, isBot: true,
    alive: true, inCombat: true, mapType: 2, difficulty: 0, sessionStartedAt: startedAt,
  };
}

test('records, deduplicates, persists, and indexes a completed session', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-recorder-'));
  const recorder = new SessionRecorder({
    dataDir,
    routeIntervalMs: 1,
    completionGraceMs: 10,
    checkpointIntervalMs: 1,
  });
  const startedAt = Math.floor(Date.now() / 1000);
  const first = snapshot(startedAt * 1000 + 1000, [player(42, startedAt)], {
    events: [{ mapId: 631, instanceId: 42, eventId: 7, occurredAt: startedAt + 1, type: 'loot', actorGuid: 1,
      actorName: 'Jaspianus', targetGuid: 0, targetType: 0, targetName: '', valueId: 49908,
      valueName: 'Primordial Saronite', amount: 2 }],
    deaths: [{ mapId: 631, instanceId: 42, eventId: 8, occurredAt: startedAt + 1, victimGuid: 1,
      victimName: 'Jaspianus', killerGuid: 2, killerType: 3, killerName: 'Boss' }],
  });
  await recorder.ingest(first);
  await recorder.ingest({ ...first, capturedAt: first.capturedAt + 10 });
  await recorder.ingest(snapshot(first.capturedAt + 20, []));
  await recorder.ingest(snapshot(first.capturedAt + 40, []));

  const index = await recorder.list();
  assert.equal(index.length, 1);
  assert.equal(index[0].eventCount, 2);
  assert.equal(index[0].totals.lootItems, 2);
  assert.equal(index[0].totals.deaths, 1);
  const record = await recorder.get(index[0].id);
  assert.equal(record.completed, true);
  assert.equal(record.events.length, 2);
  assert.ok(record.routes.length >= 1);
  assert.equal(record.participants[0].name, 'Jaspianus');
});

test('purges abandoned incomplete checkpoints and temporary files on startup', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-incomplete-'));
  const options = { dataDir, routeIntervalMs: 1, checkpointIntervalMs: 1 };
  const startedAt = Math.floor(Date.now() / 1000);
  const firstRecorder = new SessionRecorder(options);
  await firstRecorder.ingest(snapshot(startedAt * 1000 + 1000, [player(77, startedAt)]));

  const sessionDir = path.join(dataDir, 'sessions');
  const activeDir = path.join(sessionDir, '.active');
  assert.equal((await fs.readdir(activeDir)).filter((name) => name.endsWith('.json')).length, 1);
  await fs.writeFile(path.join(activeDir, 'abandoned.tmp'), 'partial');
  await fs.writeFile(path.join(sessionDir, 'index.json.123.tmp'), 'partial');

  const restartedRecorder = new SessionRecorder(options);
  assert.equal((await restartedRecorder.list()).length, 0);
  assert.deepEqual(await fs.readdir(activeDir), []);
  assert.equal((await fs.readdir(sessionDir)).some((name) => name.endsWith('.tmp')), false);
});

test('purges completed history only when explicitly requested', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-purge-'));
  const recorder = new SessionRecorder({ dataDir, routeIntervalMs: 1, completionGraceMs: 1, checkpointIntervalMs: 1 });
  const startedAt = Math.floor(Date.now() / 1000);
  const completed = snapshot(startedAt * 1000 + 10, [player(1, startedAt)]);
  await recorder.ingest(completed);
  await recorder.ingest(snapshot(completed.capturedAt + 10, []));
  await recorder.ingest(snapshot(completed.capturedAt + 20, []));
  await recorder.ingest(snapshot(completed.capturedAt + 30, [player(2, startedAt + 1)]));

  assert.equal((await recorder.list()).length, 1);
  assert.equal(await recorder.purgeCompleted(), 1);
  assert.equal((await recorder.list()).length, 0);
  const sessionDir = path.join(dataDir, 'sessions');
  assert.deepEqual((await fs.readdir(sessionDir)).filter((name) => name.endsWith('.json')), ['index.json']);
  assert.equal((await fs.readdir(path.join(sessionDir, '.active'))).filter((name) => name.endsWith('.json')).length, 1);
});

test('derives objective transitions once and retains all completed records', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wowmin-history-'));
  const recorder = new SessionRecorder({ dataDir, routeIntervalMs: 1, completionGraceMs: 1 });
  const baseStartedAt = Math.floor(Date.now() / 1000);
  for (const [instanceId, startedAt] of [[1, baseStartedAt], [2, baseStartedAt + 1]]) {
    const active = snapshot(startedAt * 1000 + 10, [player(instanceId, startedAt)], {
      battlegrounds: [{ mapId: 631, instanceId, battlegroundTypeId: 0, status: 3, elapsedMs: 0,
        remainingMs: 0, winner: 0, allianceScore: 0, hordeScore: 0, alliancePlayers: 1,
        hordePlayers: 0, allianceAlive: 1, hordeAlive: 0, nextResurrectMs: 0,
        allianceStrategy: -1, hordeStrategy: -1, worldStates: [{ id: 9, value: 1 }] }],
    });
    await recorder.ingest(active);
    await recorder.ingest({ ...active, capturedAt: active.capturedAt + 10,
      battlegrounds: [{ ...active.battlegrounds[0], worldStates: [{ id: 9, value: 2 }] }] });
    await recorder.ingest(snapshot(active.capturedAt + 20, []));
    await recorder.ingest(snapshot(active.capturedAt + 30, []));
  }
  const index = await recorder.list();
  assert.equal(index.length, 2);
  assert.equal(index[0].instanceId, 2);
  assert.equal(index[0].totals.objectives, 1);
  assert.equal(index[1].instanceId, 1);
  assert.equal(index[1].totals.objectives, 1);
});

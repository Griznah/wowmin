const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, require, Buffer };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const {
  parseBotDatagram, parseCombatEventDatagram, parseCreatureDatagram, parsePathDatagram, parseStreamDatagram, parseUnitAuraDatagram,
} = loadModule('../src/telemetry-stream.ts');
const {
  LIVE_AURA_STALE_MS, LIVE_BOT_STALE_MS, LIVE_CREATURE_STALE_MS, LIVE_PATH_STALE_MS, LIVE_RENDER_DELAY_MS, LiveAuraStore, LiveBotStore,
  LiveCreatureBuffer,
  LivePathStore, LivePositionBuffer,
  creaturePathKey, lerpAngle, trimPathToPosition,
} = loadModule('../renderer/scripts/utils/live-positions.ts');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);

// Builds a datagram exactly as BuildStreamDatagrams in WowMinTelemetry.cpp does.
function datagram({ mapId = 601, instanceId = 7, sequence = 1, serverTimeMs = 5000, part = 0, partCount = 1, players }) {
  const header = Buffer.alloc(28);
  header.write('WMS1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt8(part, 5);
  header.writeUInt8(partCount, 6);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(sequence, 16);
  header.writeUInt32LE(serverTimeMs, 20);
  header.writeUInt16LE(players.length, 24);
  const records = players.map((player) => {
    const name = Buffer.from(player.name, 'utf8');
    const record = Buffer.alloc(30);
    record.writeUInt32LE(player.guid, 0);
    record.writeFloatLE(player.x, 4);
    record.writeFloatLE(player.y, 8);
    record.writeFloatLE(player.z, 12);
    record.writeFloatLE(player.orientation, 16);
    record.writeUInt8(player.healthPct, 20);
    record.writeUInt8(player.powerPct, 21);
    record.writeInt8(player.powerType, 22);
    record.writeUInt8(player.flags, 23);
    record.writeUInt8(player.stateFlags, 24);
    record.writeUInt8(name.length, 25);
    record.writeInt32LE(player.wmoGroupId, 26);
    return Buffer.concat([record, name]);
  });
  return Buffer.concat([header, ...records]);
}

const tankard = { guid: 42, name: 'Tankard', x: 529.5, y: 652.25, z: 777.5, orientation: 1.5, healthPct: 87,
  powerPct: 30, powerType: 1, flags: 3, stateFlags: 2, wmoGroupId: 25050 };

test('parses a stream datagram into session and player state', () => {
  const parsed = parseStreamDatagram(datagram({ sequence: 9, players: [tankard, { ...tankard, guid: 7, name: 'Wéb', flags: 4, wmoGroupId: -1 }] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.equal(parsed.sequence, 9);
  assert.equal(parsed.partCount, 1);
  const [first, second] = parsed.players;
  assert.equal(first.name, 'Tankard');
  assert.equal(first.guid, 42);
  near(first.x, 529.5, 'x');
  near(first.orientation, 1.5, 'orientation');
  assert.equal(first.healthPct, 87);
  assert.equal(first.powerType, 1);
  assert.equal(first.alive, true);
  assert.equal(first.inCombat, true);
  assert.equal(first.waitingForResurrect, false);
  assert.equal(first.stateFlags, 2);
  assert.equal(first.wmoGroupId, 25050);
  assert.equal(second.name, 'Wéb');
  assert.equal(second.alive, false);
  assert.equal(second.waitingForResurrect, true);
  assert.equal(second.wmoGroupId, -1);
});

test('rejects foreign, truncated, and malformed datagrams', () => {
  const good = datagram({ players: [tankard] });
  assert.equal(parseStreamDatagram(Buffer.from('nonsense')), null);
  assert.equal(parseStreamDatagram(Buffer.concat([Buffer.from('XXXX'), good.subarray(4)])), null);
  assert.equal(parseStreamDatagram(good.subarray(0, good.length - 3)), null);
  assert.equal(parseStreamDatagram(datagram({ part: 2, partCount: 2, players: [] })), null);
});

test('interpolates between stream samples a little behind live', () => {
  const buffer = new LivePositionBuffer();
  const frame = (x, orientation) => ({ mapId: 601, instanceId: 7, sequence: 1, serverTimeMs: 0,
    players: [{ ...tankard, x, orientation, alive: true }] });
  buffer.push(frame(500, 0.2), 1000);
  buffer.push(frame(510, 0.4), 1100);
  near(buffer.sampleAt('Tankard', 1050 + LIVE_RENDER_DELAY_MS).x, 505, 'halfway');
  near(buffer.sampleAt('Tankard', 1050 + LIVE_RENDER_DELAY_MS).orientation, 0.3, 'facing');
  assert.equal(buffer.sampleAt('Tankard', 2000).x, 510, 'holds the newest sample');
  assert.equal(buffer.sampleAt('Tankard', 1100 + 2001), null, 'stale');
  assert.equal(buffer.sampleAt('Nobody', 1100), null);
});

test('snaps across teleports instead of sliding', () => {
  const buffer = new LivePositionBuffer();
  const frame = (x) => ({ mapId: 601, instanceId: 7, sequence: 1, serverTimeMs: 0, players: [{ ...tankard, x }] });
  buffer.push(frame(0), 1000);
  buffer.push(frame(400), 1100);
  assert.equal(buffer.sampleAt('Tankard', 1050 + LIVE_RENDER_DELAY_MS).x, 400);
});

test('turns the short way round when interpolating facing', () => {
  near(lerpAngle(6.2, 0.1, 0.5), 6.2 + (0.1 + Math.PI * 2 - 6.2) / 2, 'across zero');
  near(lerpAngle(0.1, 6.2, 0.5), 0.1 - (0.1 + Math.PI * 2 - 6.2) / 2, 'backwards across zero');
});

test('overlays live fields on the polled player record and keeps the rest', () => {
  const { applyLiveSample } = loadModule('../renderer/scripts/utils/live-positions.ts');
  const polled = { name: 'Tankard', class: 1, level: 80, position_x: 0, position_y: 0, position_z: 0, orientation: 0,
    alive: true, inCombat: false, healthPct: 100, wmoGroupId: 1, mounted: false };
  const live = applyLiveSample(polled, { ...tankard, alive: false, inCombat: true, waitingForResurrect: true, stateFlags: 2 | 32 });
  assert.equal(live.class, 1);
  assert.equal(live.level, 80);
  near(live.position_x, 529.5, 'x');
  assert.equal(live.healthPct, 87);
  assert.equal(live.alive, false);
  assert.equal(live.inCombat, true);
  assert.equal(live.mounted, true);
  assert.equal(live.flagCarrier, true);
  assert.equal(live.stunned, false);
  assert.equal(live.wmoGroupId, 25050);
});

// Builds a path datagram exactly as BuildPathDatagrams in WowMinTelemetry.cpp does.
function pathDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, paths }) {
  const header = Buffer.alloc(24);
  header.write('WMP1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(paths.length, 20);
  const entries = paths.map((path) => {
    const entry = Buffer.alloc(12 + path.points.length * 12);
    entry.writeUInt32LE(path.guid, 0);
    entry.writeUInt32LE(path.splineId, 4);
    entry.writeUInt8(path.points.length, 8);
    entry.writeUInt8((path.truncated ? 1 : 0) | (path.creature ? 2 : 0), 9);
    path.points.forEach((point, index) => point.forEach((value, axis) => entry.writeFloatLE(value, 12 + index * 12 + axis * 4)));
    return entry;
  });
  return Buffer.concat([header, ...entries]);
}

test('parses a path datagram, including cleared and truncated paths', () => {
  const parsed = parsePathDatagram(pathDatagram({ paths: [
    { guid: 42, splineId: 9, truncated: true, points: [[1, 2, 3], [4.5, 5.5, 6.5]] },
    { guid: 43, splineId: 0, truncated: false, creature: true, points: [] },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.equal(parsed.serverTimeMs, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.paths)), [
    { guid: 42, splineId: 9, truncated: true, creature: false, points: [[1, 2, 3], [4.5, 5.5, 6.5]] },
    { guid: 43, splineId: 0, truncated: false, creature: true, points: [] },
  ]);
});

test('rejects truncated path datagrams and position datagrams', () => {
  const good = pathDatagram({ paths: [{ guid: 1, splineId: 2, points: [[1, 2, 3]] }] });
  assert.equal(parsePathDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parsePathDatagram(datagram({ players: [] })), null);
  assert.equal(parseStreamDatagram(good), null);
});

test('keeps the latest path per player until it is cleared or goes stale', () => {
  const store = new LivePathStore();
  const path = (name, points) => ({ guid: 1, name, splineId: 3, truncated: false, creature: false, points });
  store.push({ paths: [path('Bot', [[1, 1, 1]])] }, 1000);
  assert.deepEqual(store.get('Bot', 1500).points, [[1, 1, 1]]);
  store.push({ paths: [path('Bot', [])] }, 1600);
  assert.equal(store.get('Bot', 1700), null);
  store.push({ paths: [path('Bot', [[2, 2, 2]])] }, 2000);
  assert.equal(store.get('Bot', 2000 + LIVE_PATH_STALE_MS + 1), null);
});

test('trims the waypoints a player has already walked past', () => {
  const points = [[10, 0, 0], [20, 0, 0], [20, 10, 0]];
  // Still heading for the first waypoint.
  assert.deepEqual(trimPathToPosition(points, [2, 0, 0]), points);
  // Past the first waypoint, on the way to the second.
  assert.deepEqual(trimPathToPosition(points, [15, 0, 0]), points.slice(1));
  // Round the corner, on the last leg.
  assert.deepEqual(trimPathToPosition(points, [20, 5, 0]), points.slice(2));
  assert.deepEqual(trimPathToPosition([[1, 1, 1]], [0, 0, 0]), [[1, 1, 1]]);
});

test('keys creature paths by guid, apart from players with the same guid', () => {
  const store = new LivePathStore();
  store.push({ paths: [
    { guid: 5, name: 'Bot', splineId: 1, truncated: false, creature: false, points: [[1, 1, 1]] },
    { guid: 5, name: '', splineId: 2, truncated: false, creature: true, points: [[2, 2, 2]] },
  ] }, 0);
  assert.deepEqual(store.get('Bot', 0).points, [[1, 1, 1]]);
  assert.deepEqual(store.get(creaturePathKey(5), 0).points, [[2, 2, 2]]);
});

// Builds a creature datagram exactly as BuildCreatureDatagrams in WowMinTelemetry.cpp does.
function creatureDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, creatures }) {
  const header = Buffer.alloc(24);
  header.write('WMC1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(creatures.length, 20);
  return Buffer.concat([header, ...creatures.map((creature) => {
    const entry = Buffer.alloc(36);
    entry.writeUInt32LE(creature.guid, 0);
    entry.writeUInt32LE(creature.entry, 4);
    [creature.x, creature.y, creature.z, creature.orientation].forEach((value, index) => entry.writeFloatLE(value, 8 + index * 4));
    entry.writeUInt8(creature.healthPct, 24);
    entry.writeUInt8(creature.flags, 25);
    entry.writeUInt32LE(creature.targetGuid, 28);
    entry.writeInt32LE(creature.wmoGroupId, 32);
    return entry;
  })]);
}

test('parses a creature datagram and its state flags', () => {
  const parsed = parseCreatureDatagram(creatureDatagram({ creatures: [
    { guid: 900, entry: 29120, x: 550, y: 250, z: 224, orientation: 1.5, healthPct: 64, flags: 1 | 2 | 4 | 8 | 32, targetGuid: 42, wmoGroupId: 24879 },
    { guid: 901, entry: 28684, x: 1, y: 2, z: 3, orientation: 0, healthPct: 0, flags: 16 | 64, targetGuid: 0, wmoGroupId: -1 },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.creatures)), [
    { guid: 900, entry: 29120, x: 550, y: 250, z: 224, orientation: 1.5, healthPct: 64, alive: true, inCombat: true,
      hostile: true, boss: true, playerControlled: false, targetIsPlayer: true, scenery: false, targetGuid: 42, wmoGroupId: 24879 },
    { guid: 901, entry: 28684, x: 1, y: 2, z: 3, orientation: 0, healthPct: 0, alive: false, inCombat: false,
      hostile: false, boss: false, playerControlled: true, targetIsPlayer: false, scenery: true, targetGuid: 0, wmoGroupId: -1 },
  ]);
  const good = creatureDatagram({ creatures: [{ guid: 1, entry: 2, x: 0, y: 0, z: 0, orientation: 0, healthPct: 1, flags: 1, targetGuid: 0, wmoGroupId: -1 }] });
  assert.equal(parseCreatureDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parsePathDatagram(good), null);
});

// Builds a datagram as BuildCombatEventDatagrams in WowMinTelemetry.cpp does.
function combatDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, dropped = 0, events }) {
  const header = Buffer.alloc(24);
  header.write('WME1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(events.length, 20);
  header.writeUInt16LE(dropped, 22);
  return Buffer.concat([header, ...events.map((event) => {
    const entry = Buffer.alloc(44);
    entry.writeUInt8(event.kind, 0);
    entry.writeUInt8(event.flags ?? 0, 1);
    entry.writeUInt8(event.schoolMask ?? 0, 2);
    entry.writeUInt8(event.auraCategory ?? 0, 3);
    entry.writeUInt32LE(event.sourceGuid ?? 0, 4);
    entry.writeUInt32LE(event.targetGuid ?? 0, 8);
    entry.writeUInt32LE(event.spellId ?? 0, 12);
    entry.writeUInt32LE(event.value ?? 0, 16);
    entry.writeFloatLE(event.missileSpeed ?? 0, 20);
    entry.writeFloatLE(event.radius ?? 0, 24);
    (event.point ?? [0, 0, 0]).forEach((value, index) => entry.writeFloatLE(value, 28 + index * 4));
    entry.writeUInt16LE(event.ageMs ?? 0, 40);
    entry.writeUInt16LE(event.extraFlags ?? 0, 42);
    return entry;
  })]);
}

test('parses combat events, their flags, and the dropped count', () => {
  const parsed = parseCombatEventDatagram(combatDatagram({ dropped: 3, events: [
    { kind: 2, flags: 2 | 4 | 16 | 128, schoolMask: 16, sourceGuid: 42, targetGuid: 900, spellId: 10, value: 0,
      missileSpeed: 20, radius: 8, point: [550, 250, 224], ageMs: 35 },
    { kind: 4, flags: 1 | 64, schoolMask: 2, auraCategory: 2, sourceGuid: 901, targetGuid: 43, spellId: 48066, value: 30000 },
    { kind: 7, flags: 2 | 32, schoolMask: 32, sourceGuid: 42, targetGuid: 900, spellId: 48125, value: 812 },
    { kind: 2, sourceGuid: 2, spellId: 26573, schoolMask: 2, value: 8000, extraFlags: 1 },
    { kind: 99 },
    { kind: 6, flags: 1, schoolMask: 1, sourceGuid: 900, targetGuid: 42 },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.serverTimeMs, 5000);
  assert.equal(parsed.dropped, 3);
  const events = JSON.parse(JSON.stringify(parsed.events));
  assert.deepEqual(events.map((event) => event.kind), ['castGo', 'auraApply', 'damage', 'castGo', 'swing']);
  assert.equal(events[3].persistentArea, true);
  assert.equal(events[3].value, 8000);
  assert.deepEqual(events[0], {
    kind: 'castGo', sourceCreature: false, targetCreature: true, area: true, channeled: false, periodic: false,
    helpful: false, triggered: true, schoolMask: 16, auraCategory: null, sourceGuid: 42, targetGuid: 900, spellId: 10,
    value: 0, missileSpeed: 20, radius: 8, point: [550, 250, 224], ageMs: 35, persistentArea: false,
  });
  assert.equal(events[1].auraCategory, 'shield');
  assert.equal(events[1].sourceCreature, true);
  assert.equal(events[1].helpful, true);
  assert.equal(events[1].point, null);
  assert.equal(events[2].periodic, true);
  assert.equal(events[2].value, 812);
  const good = combatDatagram({ events: [{ kind: 6 }] });
  assert.equal(parseCombatEventDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parseCreatureDatagram(good), null);
});

// Builds a datagram as BuildUnitAuraDatagrams in WowMinTelemetry.cpp does.
function unitAuraDatagram(units) {
  const header = Buffer.alloc(24);
  header.write('WMU1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(601, 8);
  header.writeUInt32LE(7, 12);
  header.writeUInt32LE(5000, 16);
  header.writeUInt16LE(units.length, 20);
  return Buffer.concat([header, ...units.map((unit) => {
    const entry = Buffer.alloc(8 + unit.spellIds.length * 4);
    entry.writeUInt32LE(unit.guid, 0);
    entry.writeUInt8(unit.creature ? 1 : 0, 4);
    entry.writeUInt8(unit.spellIds.length, 5);
    unit.spellIds.forEach((spellId, index) => entry.writeUInt32LE(spellId, 8 + index * 4));
    return entry;
  })]);
}

test('parses unit aura lists and keeps each unit\'s latest until it goes stale or empties', () => {
  const parsed = parseUnitAuraDatagram(unitAuraDatagram([
    { guid: 1, creature: false, spellIds: [48066, 48068] },
    { guid: 900, creature: true, spellIds: [] },
  ]));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.units)), [
    { guid: 1, creature: false, spellIds: [48066, 48068] },
    { guid: 900, creature: true, spellIds: [] },
  ]);
  const good = unitAuraDatagram([{ guid: 1, creature: false, spellIds: [17] }]);
  assert.equal(parseUnitAuraDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parseCreatureDatagram(good), null);

  const store = new LiveAuraStore();
  store.push(parsed, 1000);
  store.push({ units: [{ guid: 900, creature: true, spellIds: [853] }] }, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify([...store.all(1000)])), [['p1', [48066, 48068]], ['c900', [853]]]);
  // An empty list clears the unit; silence past the stale time drops it.
  store.push({ units: [{ guid: 900, creature: true, spellIds: [] }] }, 2000);
  assert.deepEqual([...store.all(2000).keys()], ['p1']);
  assert.equal(store.all(1000 + LIVE_AURA_STALE_MS + 1).size, 0);
});

test('interpolates creatures and drops ones that stop being sent', () => {
  const buffer = new LiveCreatureBuffer();
  const creature = (x) => ({ guid: 9, entry: 1, x, y: 0, z: 0, orientation: 0, alive: true });
  buffer.push({ creatures: [creature(0)] }, 1000);
  buffer.push({ creatures: [creature(10)] }, 1100);
  const [sample] = buffer.samples(1100 + LIVE_RENDER_DELAY_MS - 50);
  near(sample.x, 5, 'halfway');
  assert.equal(buffer.samples(1100 + LIVE_CREATURE_STALE_MS + 1).length, 0);
});

function botDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, bots }) {
  const header = Buffer.alloc(24);
  header.write('WMB1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(bots.length, 20);
  return Buffer.concat([header, ...bots.map((bot) => {
    const strategies = Buffer.from(bot.strategies, 'utf8');
    const entry = Buffer.alloc(36);
    entry.writeUInt32LE(bot.guid, 0);
    entry.writeUInt8(bot.state, 4);
    entry.writeUInt8(bot.motionType, 5);
    entry.writeUInt8(bot.movePriority, 6);
    entry.writeUInt8(bot.flags, 7);
    [bot.moveX, bot.moveY, bot.moveZ].forEach((value, index) => entry.writeFloatLE(value, 8 + index * 4));
    entry.writeUInt32LE(bot.moveAgeMs, 20);
    entry.writeUInt32LE(bot.motionTargetGuid, 24);
    entry.writeUInt32LE(bot.targetGuid, 28);
    entry.writeUInt16LE(strategies.length, 32);
    entry.writeUInt8(bot.actions.length, 34);
    return Buffer.concat([entry, strategies, ...bot.actions.map((action) => {
      const name = Buffer.from(action.name, 'utf8');
      const head = Buffer.alloc(12);
      head.writeUInt8(name.length, 0);
      head.writeUInt16LE(action.repeats, 2);
      head.writeFloatLE(action.relevance, 4);
      head.writeUInt32LE(action.ageMs, 8);
      return Buffer.concat([head, name]);
    })]);
  })]);
}

const healerBot = {
  guid: 42, state: 0, motionType: 14, movePriority: 3, flags: 1 | 2, moveX: 530, moveY: 650.5, moveZ: 777.25,
  moveAgeMs: 1200, motionTargetGuid: 43, targetGuid: 900, strategies: 'dps assist,heal,racials',
  actions: [{ name: 'flash heal', repeats: 3, relevance: 40, ageMs: 100 }, { name: 'follow', repeats: 1, relevance: 1.5, ageMs: 4000 }],
};

test('parses a bot decision datagram with strategies and actions', () => {
  const parsed = parseBotDatagram(botDatagram({ bots: [
    healerBot,
    { guid: 44, state: 2, motionType: 255, movePriority: 0, flags: 4, moveX: 0, moveY: 0, moveZ: 0, moveAgeMs: 0,
      motionTargetGuid: 0, targetGuid: 42, strategies: '', actions: [] },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.equal(parsed.serverTimeMs, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.bots)), [
    { guid: 42, state: 'combat', motionType: 14, movePriority: 3,
      moveTarget: { x: 530, y: 650.5, z: 777.25, ageMs: 1200 }, motionTargetGuid: 43, motionTargetIsPlayer: true,
      targetGuid: 900, targetIsPlayer: false, strategies: ['dps assist', 'heal', 'racials'],
      actions: [{ repeats: 3, relevance: 40, ageMs: 100, name: 'flash heal' }, { repeats: 1, relevance: 1.5, ageMs: 4000, name: 'follow' }] },
    { guid: 44, state: 'dead', motionType: null, movePriority: 0, moveTarget: null, motionTargetGuid: 0,
      motionTargetIsPlayer: false, targetGuid: 42, targetIsPlayer: true, strategies: [], actions: [] },
  ]);
});

test('rejects truncated bot datagrams and other kinds', () => {
  const good = botDatagram({ bots: [healerBot] });
  assert.ok(parseBotDatagram(good));
  for (const cut of [good.length - 1, good.length - 8, 24 + 36 + 5, 24 + 10]) {
    assert.equal(parseBotDatagram(good.subarray(0, cut)), null, `cut at ${cut}`);
  }
  assert.equal(parseCreatureDatagram(good), null);
  assert.equal(parseBotDatagram(pathDatagram({ paths: [] })), null);
});

test('keeps the latest decisions per bot, ageing them until they go stale', () => {
  const store = new LiveBotStore();
  const decision = (action) => ({ name: 'Healbot', guid: 42, moveTarget: { x: 1, y: 2, z: 3, ageMs: 500 },
    actions: [{ name: action, repeats: 1, relevance: 1, ageMs: 100 }] });
  store.push({ bots: [decision('follow')] }, 1000);
  store.push({ bots: [decision('flash heal')] }, 2000);
  const current = store.get('Healbot', 2600);
  assert.equal(current.actions[0].name, 'flash heal');
  assert.equal(current.actions[0].ageMs, 700);
  assert.equal(current.moveTarget.ageMs, 1100);
  assert.equal(store.get('Healbot', 2000).actions[0].ageMs, 100);
  assert.equal(store.get('Nobody', 2000), null);
  assert.equal(store.get('Healbot', 2000 + LIVE_BOT_STALE_MS + 1), null);
  assert.equal(store.size, 0);
});

test('looks up streamed players and creatures by guid', () => {
  const positions = new LivePositionBuffer();
  positions.push({ players: [{ ...tankard }] }, 1000);
  assert.equal(positions.nameOf(42), 'Tankard');
  assert.equal(positions.nameOf(7), null);
  const creatures = new LiveCreatureBuffer();
  creatures.push({ creatures: [{ guid: 9, entry: 1, x: 0, y: 0, z: 0, orientation: 0, alive: true }] }, 1000);
  assert.equal(creatures.latest(9).entry, 1);
  assert.equal(creatures.latest(10), null);
});

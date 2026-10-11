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
  const context = { module: { exports: {} }, require };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const {
  AREA_FLASH_MS, CombatEffectStore, EVENT_DRIVEN_MS, HEAL_COLOR, NUMBER_LIFETIME_MS, RELEASE_FLASH_MS, STREAK_MS,
  auraTintColor, getCastStrikeKind, getTravelMs, schoolColor, unitKey,
} = loadModule('../renderer/scripts/utils/spell-events.ts');
const { LIVE_RENDER_DELAY_MS } = loadModule('../renderer/scripts/utils/live-positions.ts');

// A combat event as parseCombatEventDatagram returns it.
function event(fields) {
  return {
    kind: 'castGo', sourceGuid: 1, sourceCreature: false, targetGuid: 900, targetCreature: true, spellId: 116,
    schoolMask: 16, auraCategory: null, value: 0, missileSpeed: 0, radius: 0, point: null, area: false,
    channeled: false, periodic: false, helpful: false, triggered: false, ageMs: 0, ...fields,
  };
}

const update = (events, dropped = 0) => ({ mapId: 601, instanceId: 7, serverTimeMs: 0, dropped, events });
const plain = (value) => JSON.parse(JSON.stringify(value));
const tenYards = () => 10;
const unknown = () => null;

test('names units like the model layer and colours schools, the most telling first', () => {
  assert.equal(unitKey(42, false), 'p42');
  assert.equal(unitKey(42, true), 'c42');
  assert.equal(schoolColor(4), '#fb923c');
  assert.equal(schoolColor(4 | 16), schoolColor(16));
  assert.equal(schoolColor(0), schoolColor(1));
  assert.notEqual(auraTintColor('crowdControl'), auraTintColor('shield'));
});

test('plays events on the delayed clock, offset by their age', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ kind: 'castStart', value: 2500, ageMs: 40 })]), 1000);
  const playAt = 1000 - 40 + LIVE_RENDER_DELAY_MS;
  store.advance(playAt - 1, tenYards);
  assert.equal(store.casts.length, 0);
  store.advance(playAt, tenYards);
  assert.deepEqual(plain(store.casts.map(({ caster, spellId, release }) => ({ caster, spellId, release }))),
    [{ caster: 'p1', spellId: 116, release: false }]);
  assert.ok(store.active);
});

test('a cast glows until it fires, then flashes, launches a missile, and cues a cast animation', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ kind: 'castStart', value: 2500 }),
    event({ kind: 'castGo', missileSpeed: 25, ageMs: 0 }),
  ]), 0);
  const cues = store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(cues), [{ unit: 'p1', kind: 'cast' }]);
  assert.equal(store.casts.length, 1);
  assert.equal(store.casts[0].release, true);
  assert.equal(store.projectiles.length, 1);
  assert.equal(store.projectiles[0].target, 'c900');
  assert.equal(store.projectiles[0].travelMs, 400);
  assert.equal(store.projectiles[0].streak, false);
  // The release flash and the missile both end on time.
  store.advance(LIVE_RENDER_DELAY_MS + RELEASE_FLASH_MS, tenYards);
  assert.equal(store.casts.length, 0);
  store.advance(LIVE_RENDER_DELAY_MS + 400, tenYards);
  assert.equal(store.projectiles.length, 0);
  assert.ok(store.isEventDriven('p1', LIVE_RENDER_DELAY_MS + 400));
  assert.ok(!store.isEventDriven('p1', LIVE_RENDER_DELAY_MS + EVENT_DRIVEN_MS));
});

test('a cancelled cast stops glowing', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ kind: 'castStart', value: 3000 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  store.push(update([event({ kind: 'castCancel' })]), 500);
  store.advance(500 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.casts.length, 0);
});

test('instant spells streak; no missile without both units; triggered spells only ring', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ missileSpeed: 0 })]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.projectiles[0].streak, true);
  assert.equal(store.projectiles[0].travelMs, STREAK_MS);

  const hidden = new CombatEffectStore();
  hidden.push(update([event({ missileSpeed: 20 })]), 0);
  hidden.advance(LIVE_RENDER_DELAY_MS, unknown);
  assert.equal(hidden.projectiles.length, 0);

  const triggered = new CombatEffectStore();
  const cues = (triggered.push(update([event({ triggered: true, area: true, radius: 8, missileSpeed: 20 })]), 0),
    triggered.advance(LIVE_RENDER_DELAY_MS, tenYards));
  assert.deepEqual(plain(cues), []);
  assert.equal(triggered.casts.length, 0);
  assert.equal(triggered.projectiles.length, 0);
  assert.equal(triggered.rings.length, 1);
});

test('area spells ring at their ground point; channelled ones last the channel and beam to a target', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ area: true, radius: 8, point: [10, 20, 30], targetGuid: 0, channeled: true, value: 8000, spellId: 10 }),
    event({ sourceGuid: 2, area: true, radius: 10, targetGuid: 0, spellId: 1449, schoolMask: 64 }),
    event({ sourceGuid: 3, channeled: true, value: 3000, spellId: 15407, schoolMask: 32 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.rings.map(({ caster, point, radius, endAt }) => ({ caster, point, radius, endAt }))), [
    { caster: 'p1', point: [10, 20, 30], radius: 8, endAt: LIVE_RENDER_DELAY_MS + 8000 },
    { caster: 'p2', point: null, radius: 10, endAt: LIVE_RENDER_DELAY_MS + AREA_FLASH_MS },
  ]);
  assert.equal(store.beams.length, 1);
  assert.equal(store.beams[0].source, 'p3');
  // Party buffs and raid-wide areas get no ring.
  store.push(update([
    event({ sourceGuid: 4, area: true, radius: 30, targetGuid: 0, spellId: 48162, schoolMask: 2, helpful: true }),
    event({ sourceGuid: 900, sourceCreature: true, area: true, radius: 100, targetGuid: 0, spellId: 52086, schoolMask: 32 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.rings.length, 2);
  assert.equal(store.beams[0].target, 'c900');
  // A channel is not a missile.
  assert.equal(store.projectiles.filter((projectile) => projectile.source === 'p3').length, 0);
  store.push(update([event({ kind: 'castCancel', sourceGuid: 3, spellId: 15407 })]), 1000);
  store.advance(1000 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.beams.length, 0);
});

test('chooses attack animations for fired spells', () => {
  assert.equal(getCastStrikeKind(event({ schoolMask: 4 })), 'cast');
  assert.equal(getCastStrikeKind(event({ schoolMask: 1, spellId: 75 })), 'ranged');
  assert.equal(getCastStrikeKind(event({ schoolMask: 1, spellId: 12294 })), 'melee');
  assert.equal(getCastStrikeKind(event({ schoolMask: 1, spellId: 6673, helpful: true, targetGuid: 1, targetCreature: false })), null);
  assert.equal(getCastStrikeKind(event({ schoolMask: 4, triggered: true })), null);
  assert.equal(getTravelMs(10, 20), 500);
  assert.equal(getTravelMs(1000, 20), 3000);
  assert.equal(getTravelMs(0.1, 20), 120);
});

test('swings cue melee strikes and drive the unit by events for a while', () => {
  const store = new CombatEffectStore();
  store.push(update([event({ kind: 'swing', sourceGuid: 900, sourceCreature: true, targetGuid: 1, targetCreature: false, schoolMask: 1, spellId: 0 })]), 0);
  assert.deepEqual(plain(store.advance(LIVE_RENDER_DELAY_MS, tenYards)), [{ unit: 'c900', kind: 'melee' }]);
  assert.ok(store.isEventDriven('c900', LIVE_RENDER_DELAY_MS + 1000));
  assert.ok(!store.isEventDriven('p1', LIVE_RENDER_DELAY_MS + 1000));
});

test('damage and heals float numbers; spell hits and heals also flash, white hits do not', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ kind: 'damage', value: 812, spellId: 48125, schoolMask: 32, periodic: true }),
    event({ kind: 'damage', value: 340, spellId: 0, schoolMask: 1 }),
    event({ kind: 'heal', value: 2000, spellId: 48071, schoolMask: 2, targetGuid: 2, targetCreature: false, helpful: true }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.deepEqual(plain(store.numbers.map(({ target, amount, heal, periodic, color }) => ({ target, amount, heal, periodic, color }))), [
    { target: 'c900', amount: 812, heal: false, periodic: true, color: schoolColor(32) },
    { target: 'c900', amount: 340, heal: false, periodic: false, color: schoolColor(1) },
    { target: 'p2', amount: 2000, heal: true, periodic: false, color: HEAL_COLOR },
  ]);
  assert.deepEqual(plain(store.impacts.map(({ target, heal, small }) => ({ target, heal, small }))), [
    { target: 'c900', heal: false, small: true },
    { target: 'p2', heal: true, small: false },
  ]);
  store.advance(LIVE_RENDER_DELAY_MS + NUMBER_LIFETIME_MS, tenYards);
  assert.equal(store.numbers.length, 0);
  assert.ok(!store.active);
});

test('tints units by their strongest notable aura until it is removed or runs out', () => {
  const store = new CombatEffectStore();
  store.push(update([
    event({ kind: 'auraApply', auraCategory: 'offensive', spellId: 2825, value: 40000 }),
    event({ kind: 'auraApply', auraCategory: 'crowdControl', spellId: 118, value: 8000 }),
  ]), 0);
  store.advance(LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.tint('c900'), auraTintColor('crowdControl'));
  assert.deepEqual(plain([...store.tints()]), [['c900', auraTintColor('crowdControl')]]);
  store.push(update([event({ kind: 'auraRemove', spellId: 118 })]), 1000);
  store.advance(1000 + LIVE_RENDER_DELAY_MS, tenYards);
  assert.equal(store.tint('c900'), auraTintColor('offensive'));
  store.advance(LIVE_RENDER_DELAY_MS + 40000, tenYards);
  assert.equal(store.tint('c900'), null);
});

test('counts dropped events and the event rate', () => {
  const store = new CombatEffectStore();
  store.push(update([event({}), event({})], 5), 1000);
  store.push(update([], 2), 1500);
  assert.equal(store.dropped, 7);
  assert.equal(store.eventsPerSecond(1500), 1);
  assert.equal(store.eventsPerSecond(4000), 0);
  store.clear();
  assert.equal(store.dropped, 0);
});

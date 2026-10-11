const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

// Spell art (level 2): the M2 emitter and ribbon parser, track export, and
// the renderer's track and particle maths. No Blizzard files: buffers are
// built by hand in the documented 3.3.5 layouts.

const load = (file) => import(pathToFileURL(path.join(__dirname, 'scene', file)).href);

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)], bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, require, Math };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const tracks = loadModule('../renderer/scripts/utils/m2-tracks.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);

// A file with room for data after a header; `put` writes and returns offsets.
function m2Buffer(size = 4096) {
  const buffer = Buffer.alloc(size);
  let next = 1024;
  const alloc = (bytes) => {
    const at = next;
    next += Math.ceil(bytes / 4) * 4;
    return at;
  };
  return { buffer, alloc };
}

// An M2Track with one sequence of keys, written at `at`.
function writeTrack({ buffer, alloc }, at, { times, values, write, width, globalSequence = -1, interpolation = 1 }) {
  buffer.writeUInt16LE(interpolation, at);
  buffer.writeInt16LE(globalSequence, at + 2);
  const timeData = alloc(times.length * 4);
  times.forEach((time, index) => buffer.writeUInt32LE(time, timeData + index * 4));
  const timeList = alloc(8);
  buffer.writeUInt32LE(times.length, timeList);
  buffer.writeUInt32LE(timeData, timeList + 4);
  const valueData = alloc(values.length * width);
  values.forEach((value, index) => write(value, valueData + index * width));
  const valueList = alloc(8);
  buffer.writeUInt32LE(values.length, valueList);
  buffer.writeUInt32LE(valueData, valueList + 4);
  buffer.writeUInt32LE(1, at + 4);
  buffer.writeUInt32LE(timeList, at + 8);
  buffer.writeUInt32LE(1, at + 12);
  buffer.writeUInt32LE(valueList, at + 16);
}

function writeFBlock({ buffer, alloc }, at, times, values, write, width, components = 1) {
  const timeData = alloc(times.length * 2);
  times.forEach((time, index) => buffer.writeInt16LE(Math.round(time * 32767), timeData + index * 2));
  const valueData = alloc(values.length * width);
  values.forEach((value, index) => write(value, valueData + index * width));
  buffer.writeUInt32LE(times.length, at);
  buffer.writeUInt32LE(timeData, at + 4);
  buffer.writeUInt32LE(values.length / components, at + 8);
  buffer.writeUInt32LE(valueData, at + 12);
}

test('reads a particle emitter in the 3.3.5 layout', async () => {
  const { parseParticleEmitters, PARTICLE_SIZE } = await load('m2-effects.mjs');
  const file = m2Buffer();
  const { buffer } = file;
  const at = file.alloc(PARTICLE_SIZE);
  buffer.writeUInt32LE(1, 296);
  buffer.writeUInt32LE(at, 300);
  buffer.writeUInt32LE(0x20000 | 0x10, at + 0x04);
  buffer.writeFloatLE(0.5, at + 0x08);
  buffer.writeUInt16LE(3, at + 0x14);
  buffer.writeUInt16LE(2, at + 0x16);
  buffer.writeUInt8(4, at + 0x28);
  buffer.writeUInt8(2, at + 0x29);
  buffer.writeUInt16LE(4, at + 0x30);
  buffer.writeUInt16LE(8, at + 0x32);
  const float = (value, offset) => buffer.writeFloatLE(value, offset);
  writeTrack(file, at + 0x98, { times: [0], values: [0.6], write: float, width: 4 });
  buffer.writeFloatLE(0.1, at + 0xAC);
  writeTrack(file, at + 0xB0, { times: [0, 500], values: [60, 30], write: float, width: 4 });
  writeTrack(file, at + 0x84, { times: [0], values: [2], write: float, width: 4 });
  writeFBlock(file, at + 0x104, [0, 0.5, 1], [255, 0, 0, 0, 255, 0, 0, 0, 255], float, 4, 3);
  writeFBlock(file, at + 0x114, [0, 1], [1, 0], (value, offset) => buffer.writeInt16LE(Math.round(value * 32767), offset), 2);
  buffer.writeFloatLE(0.25, at + 0x15C);
  buffer.writeFloatLE(1.5, at + 0x174);

  const [emitter] = parseParticleEmitters(buffer);
  assert.equal(emitter.flags, 0x20010);
  near(emitter.position[0], 0.5, 'position');
  assert.equal(emitter.bone, 3);
  assert.equal(emitter.texture, 2);
  assert.equal(emitter.blendingType, 4);
  assert.equal(emitter.emitterType, 2);
  assert.deepEqual([emitter.rows, emitter.columns], [4, 8]);
  near(emitter.lifespan.sequences[0].values[0], 0.6, 'lifespan');
  near(emitter.lifespanVariation, 0.1, 'lifespan variation');
  assert.deepEqual(plain(emitter.emissionRate.sequences[0].times), [0, 500]);
  // Plain gravity is a pull down Z.
  assert.deepEqual(plain(emitter.gravity.sequences[0].values), [0, 0, -2]);
  assert.equal(emitter.color.values.length, 9);
  near(emitter.color.times[1], 0.5, 'colour mid time');
  near(emitter.alpha.values[0], 1, 'alpha');
  near(emitter.tailLength, 0.25, 'tail length');
  near(emitter.drag, 1.5, 'drag');
  // A count that runs past the file reads as none.
  buffer.writeUInt32LE(100, 296);
  assert.deepEqual(parseParticleEmitters(buffer), []);
});

test('decompresses packed gravity', async () => {
  const { decompressGravity } = await load('m2-effects.mjs');
  // x = y = 0, z magnitude 100 → straight up, 100 * 0.04238648.
  const [x, y, z] = decompressGravity(100 << 16);
  assert.deepEqual([x, y], [0, 0]);
  near(z, 4.238648, 'up');
  near(decompressGravity(-100 << 16)[2], -4.238648, 'down');
});

test('reads a ribbon in the 3.3.5 layout', async () => {
  const { parseRibbons, RIBBON_SIZE } = await load('m2-effects.mjs');
  const file = m2Buffer();
  const { buffer } = file;
  const at = file.alloc(RIBBON_SIZE);
  buffer.writeUInt32LE(1, 288);
  buffer.writeUInt32LE(at, 292);
  buffer.writeUInt32LE(7, at + 0x04);
  const textures = file.alloc(2);
  buffer.writeUInt16LE(2, textures);
  buffer.writeUInt32LE(1, at + 0x14);
  buffer.writeUInt32LE(textures, at + 0x18);
  writeTrack(file, at + 0x4C, { times: [0], values: [0.22], write: (value, offset) => buffer.writeFloatLE(value, offset), width: 4 });
  buffer.writeFloatLE(10, at + 0x74);
  buffer.writeFloatLE(0.6, at + 0x78);
  const [ribbon] = parseRibbons(buffer);
  assert.equal(ribbon.bone, 7);
  assert.deepEqual(ribbon.textures, [2]);
  near(ribbon.heightAbove.sequences[0].values[0], 0.22, 'height above');
  near(ribbon.edgesPerSecond, 10, 'edges per second');
  near(ribbon.edgeLifetime, 0.6, 'edge lifetime');
});

test('exports tracks for the clips kept, or a loop\'s keys', async () => {
  const { exportTrack } = await load('effect-model.mjs');
  const track = { interpolation: 1, globalSequence: -1, sequences: [{ times: [0, 100], values: [1, 2] }, { times: [0], values: [9] }] };
  assert.deepEqual(exportTrack(track, [{ name: 'Stand', index: 0 }, { name: 'Death', index: 2 }]),
    { g: -1, s: false, k: { Stand: [[0, 100], [1, 2]] } });
  assert.deepEqual(exportTrack({ ...track, globalSequence: 1, interpolation: 0 }, []),
    { g: 1, s: true, k: { global: [[0, 100], [1, 2]] } });
  assert.equal(exportTrack({ ...track, sequences: [] }, [{ name: 'Stand', index: 0 }]), null);
});

test('evaluates tracks by clip time, and loops by elapsed time', () => {
  const clock = { clip: 'Stand', timeMs: 50, elapsedMs: 1250, loops: [1000] };
  const track = { g: -1, s: false, k: { Stand: [[0, 100], [0, 10, 100, 110]] } };
  assert.deepEqual(plain(tracks.evalTrack(track, 2, clock, [7, 7])), [50, 60]);
  assert.deepEqual(plain(tracks.evalTrack({ ...track, s: true }, 2, clock, [7, 7])), [0, 10]);
  assert.deepEqual(plain(tracks.evalTrack(null, 2, clock, [7, 7])), [7, 7]);
  // A loop of 1000 ms, 1250 ms in: 250 ms into its keys.
  const loop = { g: 0, s: false, k: { global: [[0, 1000], [0, 4]] } };
  assert.deepEqual(plain(tracks.evalTrack(loop, 1, clock, [0])), [1]);
  // Past the last key holds it.
  assert.deepEqual(plain(tracks.interpolate([0, 100], [1, 2], 1, 500)), [2]);
});

test('evaluates life curves and texture cells', () => {
  const curve = { t: [0, 0.5, 1], v: [0, 10, 0] };
  assert.deepEqual(plain(tracks.evalLifeCurve(curve, 1, 0.25, [9])), [5]);
  assert.deepEqual(plain(tracks.evalLifeCurve({ t: [], v: [] }, 1, 0.25, [9])), [9]);
  assert.deepEqual(plain(tracks.cellUv(0, 4, 4)), [0, 0, 0.25, 0.25]);
  assert.deepEqual(plain(tracks.cellUv(5, 4, 4)), [0.25, 0.25, 0.5, 0.5]);
  // Cells wrap round the sheet.
  assert.deepEqual(plain(tracks.cellUv(17, 4, 4)), plain(tracks.cellUv(1, 4, 4)));
  near(tracks.quaternionAngleZ([0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)]), Math.PI / 2, 'uv rotation');
});

test('spawns particles on planes and spheres, and counts emission', () => {
  const fixed = (...values) => { let index = 0; return () => values[index++ % values.length]; };
  // Plane, no spread: straight up at full speed, from the rectangle.
  const plane = tracks.spawnParticle({ emitterType: 1, areaLength: 2, areaWidth: 4, verticalRange: 0, horizontalRange: 0,
    speed: 3, speedVariation: 0, zSource: 0 }, fixed(0, 0, 0, 1, -1));
  assert.deepEqual(plain(plane.velocity), [0, 0, 3]);
  assert.deepEqual(plain(plane.position), [1, -2, 0]);
  // Sphere: on the shell between the radii, flying outward.
  const sphere = tracks.spawnParticle({ emitterType: 2, areaLength: 1, areaWidth: 3, verticalRange: Math.PI / 2,
    horizontalRange: 0, speed: 2, speedVariation: 0, zSource: 0 }, fixed(0, 1, 0, 1));
  near(Math.hypot(...sphere.position), 3, 'radius');
  near(sphere.velocity[0] / 2, sphere.position[0] / 3, 'outward');
  // A narrow sphere emitter points forward (+X), like a breath; its
  // horizontal range fans it out sideways, its vertical range up and down.
  const breath = (vertical, horizontal) => tracks.spawnParticle({ emitterType: 2, areaLength: 0, areaWidth: 0,
    verticalRange: 0.1, horizontalRange: 1, speed: 10, speedVariation: 0, zSource: 0 }, fixed(0, vertical, horizontal, 0));
  const ahead = breath(0, 0);
  near(ahead.velocity[0], 10, 'straight ahead');
  near(ahead.velocity[2], 0, 'level');
  const fanned = breath(0, 1);
  near(Math.atan2(fanned.velocity[1], fanned.velocity[0]), 1, 'fanned sideways');
  near(Math.asin(breath(1, 0).velocity[2] / 10), 0.1, 'tilted up');
  // zSource: away from a point below.
  const source = tracks.spawnParticle({ emitterType: 1, areaLength: 0, areaWidth: 0, verticalRange: 0, horizontalRange: 0,
    speed: 5, speedVariation: 0, zSource: 2 }, fixed(0));
  assert.deepEqual(plain(source.velocity), [0, 0, 5]);
  const emitted = tracks.emitCount(0.5, 10, 0.12);
  assert.equal(emitted.count, 1);
  near(emitted.carry, 0.7, 'carry');
  assert.equal(tracks.particleBlend(4), 'add');
  assert.equal(tracks.particleBlend(2), 'alpha');
  assert.equal(tracks.materialBlend(4), 'add');
});

test('picks the kit a cast plays, its body slots, and the animations it names', () => {
  const kits = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const kit = (anim) => ({ anim, effects: [] });
  const visual = { missile: null, kits: { precast: kit(51), cast: kit(53), channel: kit(124) } };
  assert.equal(kits.castKit(visual, { release: false, channeled: false }).anim, 51);
  assert.equal(kits.castKit(visual, { release: true, channeled: false }).anim, 53);
  assert.equal(kits.castKit(visual, { release: false, channeled: true }).anim, 124);
  // A channel without its own kit keeps the precast one.
  assert.equal(kits.castKit({ missile: null, kits: { precast: kit(52) } }, { release: false, channeled: true }).anim, 52);
  assert.equal(kits.castKit({ missile: null, kits: {} }, { release: true, channeled: false }), undefined);
  assert.equal(kits.slotAnchor('leftHand'), 'handLeft');
  assert.equal(kits.slotAnchor('rightWeapon'), 'handRight');
  assert.equal(kits.slotAnchor('base'), 'feet');
  assert.equal(kits.slotAnchor('breath'), 'breath');
  assert.equal(kits.slotAnchor('special2'), 'chest');
  assert.equal(kits.kitAnimationName(125), 'ChannelCastOmni');
  assert.equal(kits.kitAnimationName(9), 'CombatWound');
  assert.equal(kits.kitAnimationName(-1), null);
});

test('rains only for spells whose area runs procedure 9, at its rate, spread over the disc', () => {
  const kits = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const kit = (procs) => ({ anim: -1, effects: [], procs });
  const blizzard = { missile: null, falling: { id: 398, scale: 1 }, kits: { persistentArea: kit([{ code: 9, params: [0, 5, 0, 0] }]) } };
  assert.equal(kits.rainRate(blizzard), 5);
  assert.equal(kits.rainRate({ ...blizzard, falling: null }), 0);
  assert.equal(kits.rainRate({ ...blizzard, kits: { persistentArea: kit([{ code: 3, params: [0, 5, 0, 0] }]) } }), 0);
  assert.equal(kits.rainRate({ ...blizzard, kits: { impactArea: kit([{ code: 9, params: [0, 0, 0, 0] }]) } }), 5);
  assert.deepEqual(plain(kits.pointInDisc([10, 20, 3], 8, 1, 0)), [18, 20, 3]);
  assert.deepEqual(plain(kits.pointInDisc([10, 20, 3], 8, 0, 0.5)), [10, 20, 3]);
});

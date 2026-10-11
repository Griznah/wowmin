// Loads an M2 model with its skeleton and the animations wowmin plays (stand,
// move, fight, cast, die), for players and creatures in the instance view.
// Everything stays in M2 model space: Z up, facing +X, as server orientation 0.

import { M2Model, M2SkinProfile } from '@wowserhq/format';

import { skinFileName, staticBatchColor } from './m2.mjs';

const M2_VERTEX_SIZE = 48;
const M2_NO_LOOP = 0xFFFF;
// Set on sequences whose keyframes are inside the .m2 rather than a .anim file.
const M2_SEQUENCE_FLAG_INLINE = 0x20;
const M2_TRACK_INTERPOLATION_NONE = 0;

// AnimationData.dbc IDs of the animations exported, by the name the renderer
// asks for.
export const UNIT_ANIMATIONS = {
  Stand: 0,
  Death: 1,
  Walk: 4,
  Run: 5,
  Dead: 6,
  AttackUnarmed: 16,
  Attack1H: 17,
  Attack2H: 18,
  Attack2HL: 19,
  ReadyUnarmed: 25,
  Ready1H: 26,
  Ready2H: 27,
  Ready2HL: 28,
  ReadyBow: 29,
  AttackBow: 46,
  ReadyRifle: 48,
  AttackRifle: 49,
  ReadySpellDirected: 51,
  ReadySpellOmni: 52,
  SpellCastDirected: 53,
  SpellCastOmni: 54,
  // Named by spell visual kits: hit reactions, channelling, and other casts.
  CombatWound: 9,
  CombatCritical: 10,
  Stun: 14,
  SpellCast: 32,
  BattleRoar: 55,
  Special1H: 57,
  AttackThrown: 107,
  ReadyThrown: 108,
  SpecialUnarmed: 118,
  UseStandingLoop: 123,
  ChannelCastDirected: 124,
  ChannelCastOmni: 125,
};

const asBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

// M2 stores rotations as signed 16-bit quaternion components.
export function decompressQuaternionComponent(value) {
  return (value < 0 ? value + 32768 : value - 32767) / 32767;
}

export function decompressQuaternions(values) {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 4) {
    let length = 0;
    for (let axis = 0; axis < 4; axis += 1) {
      result[index + axis] = decompressQuaternionComponent(values[index + axis]);
      length += result[index + axis] ** 2;
    }
    length = Math.sqrt(length) || 1;
    for (let axis = 0; axis < 4; axis += 1) result[index + axis] /= length;
  }
  return result;
}

// Positions, normals, UVs, and up to four bone influences per vertex, with
// weights normalised to sum to 1.
export function expandSkinnedVertices(modelVertices, skinVertexLookup) {
  const view = new DataView(modelVertices);
  const count = skinVertexLookup.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    const base = skinVertexLookup[index] * M2_VERTEX_SIZE;
    for (let axis = 0; axis < 3; axis += 1) {
      positions[index * 3 + axis] = view.getFloat32(base + axis * 4, true);
      normals[index * 3 + axis] = view.getFloat32(base + 20 + axis * 4, true);
    }
    uvs[index * 2] = view.getFloat32(base + 32, true);
    uvs[index * 2 + 1] = view.getFloat32(base + 36, true);
    let total = 0;
    for (let influence = 0; influence < 4; influence += 1) total += view.getUint8(base + 12 + influence);
    for (let influence = 0; influence < 4; influence += 1) {
      const weight = view.getUint8(base + 12 + influence);
      joints[index * 4 + influence] = weight ? view.getUint8(base + 16 + influence) : 0;
      weights[index * 4 + influence] = total ? weight / total : influence === 0 ? 1 : 0;
    }
  }
  return { positions, normals, uvs, joints, weights };
}

// The sequence index for each wanted animation: variation 0, keyframes inline.
export function selectSequences(sequences, wanted = UNIT_ANIMATIONS) {
  const selected = [];
  for (const [name, id] of Object.entries(wanted)) {
    const index = sequences.findIndex((sequence) => sequence.id === id && sequence.variationIndex === 0);
    if (index < 0 || !(sequences[index].flags & M2_SEQUENCE_FLAG_INLINE)) continue;
    selected.push({ name, id, index, duration: sequences[index].duration, moveSpeed: sequences[index].moveSpeed });
  }
  return selected;
}

function trackKeys(track, sequenceIndex) {
  // Tracks on a global sequence loop independently of the animation; they
  // are held at their first key instead.
  const index = track.loopIndex === M2_NO_LOOP ? sequenceIndex : 0;
  const times = track.sequenceTimes[index];
  const values = track.sequenceKeys[index];
  if (!times?.length || !values?.length) return null;
  if (track.loopIndex !== M2_NO_LOOP) {
    const width = values.length / times.length;
    return { times: Uint32Array.of(0), values: values.slice(0, width), step: true };
  }
  return { times, values, step: track.trackType === M2_TRACK_INTERPOLATION_NONE };
}

// Keyframes for one bone in one sequence, as glTF node channels: translation
// is offset from the parent's pivot so the bone turns about its own pivot.
export function boneChannels(bone, parentPivot, sequenceIndex) {
  const offset = [0, 1, 2].map((axis) => bone.pivot[axis] - (parentPivot?.[axis] ?? 0));
  const channels = {};
  const translation = trackKeys(bone.translationTrack, sequenceIndex);
  if (translation) {
    const values = new Float32Array(translation.values.length);
    for (let index = 0; index < values.length; index += 1) values[index] = translation.values[index] + offset[index % 3];
    channels.translation = { times: translation.times, values, step: translation.step };
  }
  const rotation = trackKeys(bone.rotationTrack, sequenceIndex);
  if (rotation) channels.rotation = { times: rotation.times, values: decompressQuaternions(rotation.values), step: rotation.step };
  const scale = trackKeys(bone.scaleTrack, sequenceIndex);
  if (scale) channels.scale = { times: scale.times, values: Float32Array.from(scale.values), step: scale.step };
  return channels;
}

// Loads the model, its first skin profile, the bones, and the wanted
// animations. `showSection(id)` picks geosets (all when omitted).
export function loadSkinnedM2(modelName, readFile, { showSection = () => true, animations = UNIT_ANIMATIONS } = {}) {
  const modelBuffer = readFile(modelName);
  const skinBuffer = modelBuffer ? readFile(skinFileName(modelName)) : null;
  if (!modelBuffer || !skinBuffer) return null;
  const model = new M2Model().load(asBytes(modelBuffer));
  const skin = new M2SkinProfile(model).load(asBytes(skinBuffer));
  if (!skin.indices.length) return null;

  const bones = model.bones.map((bone) => ({
    parentIndex: bone.parentIndex,
    pivot: Array.from(bone.pivot),
  }));
  const sequences = selectSequences(model.sequences, animations);
  const clips = sequences.map((sequence) => ({
    name: sequence.name,
    duration: sequence.duration,
    moveSpeed: sequence.moveSpeed,
    bones: model.bones.map((bone) => boneChannels(bone, model.bones[bone.parentIndex]?.pivot, sequence.index)),
  }));

  return {
    ...expandSkinnedVertices(model.vertices, skin.vertices),
    indices: skin.indices,
    bones,
    clips,
    textures: model.textures.map((texture) => ({ type: texture.component, filename: texture.filename, flags: texture.flags })),
    batches: skin.batches.flatMap((batch) => {
      if (!showSection(batch.skinSection.id)) return [];
      const textureIndex = model.textures.indexOf(batch.textures[0]);
      return [{
        ...staticBatchColor(model, batch.colorIndex, batch.textureWeightIndex),
        section: batch.skinSection.id,
        indexStart: batch.skinSection.indexStart + (batch.skinSection.level << 16),
        indexCount: batch.skinSection.indexCount,
        blend: batch.material.blend,
        materialFlags: batch.material.flags,
        textureIndex,
      }];
    }),
    sectionIds: [...new Set(skin.batches.map((batch) => batch.skinSection.id))],
  };
}

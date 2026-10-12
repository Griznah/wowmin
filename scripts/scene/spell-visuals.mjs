// Resolves a spell to the client's own art for it: Spell.dbc → SpellVisual →
// SpellVisualKit (one per stage: precast, cast, impact, ...) → the effect
// model on each body slot (SpellVisualEffectName). Field numbers are for
// 3.3.5 and were checked against the client's tables.

import { readDbc } from './dbc.mjs';

const SPELL_VISUAL_FIELD = 131;
// Spell.dbc's enUS name and rank ("Rank 3", "Racial").
const SPELL_NAME_FIELD = 136;
const SPELL_RANK_FIELD = 153;
// Spell.dbc's three effects and the auras they apply. A taunt forces its
// target to attack (effect 114) or applies the taunt aura (11).
const SPELL_EFFECT_FIELDS = [71, 72, 73];
const SPELL_AURA_FIELDS = [95, 96, 97];
const EFFECT_ATTACK_ME = 114;
const AURA_MOD_TAUNT = 11;
// SpellVisual fields naming a kit, by the stage the kit plays at.
const VISUAL_KITS = {
  precast: 1, cast: 2, impact: 3, state: 4, stateDone: 5, channel: 6,
  casterImpact: 14, targetImpact: 15, instantArea: 23, impactArea: 24, persistentArea: 25,
};
const VISUAL_MISSILE_MODEL = 8;
const VISUAL_MISSILE_DESTINATION_ATTACHMENT = 10;
const VISUAL_MISSILE_ATTACHMENT = 16;
// SpellVisualKit: start and loop animation, then an effect per body slot.
const KIT_START_ANIM = 1;
const KIT_ANIM = 2;
const KIT_SLOTS = ['head', 'chest', 'base', 'leftHand', 'rightHand', 'breath', 'leftWeapon', 'rightWeapon',
  'special1', 'special2', 'special3', 'world'];
const KIT_FIRST_SLOT = 3;
// Up to four procedures a kit runs (CharProc), each with four parameters
// (CharParamZero..Three, one array per parameter).
const KIT_PROCS = 17;
const KIT_PROC_PARAMS = [21, 25, 29, 33];
// Procedure 9 (undocumented) rains models over the area: Blizzard's ice,
// Rain of Fire's fire. The data doesn't say which model falls; these are the
// models the client has for them (creature Rain of Fire spells name the fire
// model directly). By SpellVisual ID: Blizzard, Rain of Fire.
export const FALLING_EFFECTS = { 9490: 398, 10379: 448 };
// GameObjectDisplayInfo: the model file.
const GAMEOBJECT_MODEL_FIELD = 1;
// SpellVisualEffectName: name, file, area effect size, scale.
const EFFECT_FILE = 2;
const EFFECT_AREA_SIZE = 3;
const EFFECT_SCALE = 4;

export class SpellVisuals {
  constructor(readFile) {
    this.readFile = readFile;
    this.tables = new Map();
    this.present = new Map();
  }

  table(name) {
    if (!this.tables.has(name)) {
      const buffer = this.readFile(`DBFilesClient\\${name}.dbc`);
      this.tables.set(name, buffer ? readDbc(buffer).byId() : new Map());
    }
    return this.tables.get(name);
  }

  // The model file for a game object display (GameObjectDisplayInfo), or null
  // if it has none to draw: building (WMO) objects, which the effect
  // converter can't build, and the invisible marker models of traps.
  gameObjectModel(displayId) {
    const file = this.table('GameObjectDisplayInfo').get(displayId)?.string(GAMEOBJECT_MODEL_FIELD);
    if (!file || /\.wmo$/i.test(file) || /invisible/i.test(file)) return null;
    const modelName = file.replace(/\.md[xl]$/i, '.m2');
    return this.hasFile(modelName) ? modelName : null;
  }

  // The model file for an effect, or null if it isn't in the client.
  effectModel(effectId) {
    const effect = this.table('SpellVisualEffectName').get(effectId);
    const file = effect?.string(EFFECT_FILE);
    if (!file) return null;
    const modelName = file.replace(/\.md[xl]$/i, '.m2');
    return this.hasFile(modelName) ? modelName : null;
  }

  // Whether the client has a file, remembered (reading one decompresses it).
  hasFile(name) {
    let known = this.present.get(name);
    if (known === undefined) {
      known = Boolean(this.readFile(name));
      this.present.set(name, known);
    }
    return known;
  }

  effect(effectId) {
    const effect = this.table('SpellVisualEffectName').get(effectId);
    if (!effect || !this.effectModel(effectId)) return null;
    return { id: effectId, scale: effect.float(EFFECT_SCALE) || 1, areaSize: effect.float(EFFECT_AREA_SIZE) };
  }

  kit(kitId) {
    const kit = this.table('SpellVisualKit').get(kitId);
    if (!kit) return null;
    const effects = KIT_SLOTS.flatMap((slot, index) => {
      const effect = this.effect(kit.int(KIT_FIRST_SLOT + index));
      return effect ? [{ slot, ...effect }] : [];
    });
    const startAnim = kit.int(KIT_START_ANIM);
    const anim = kit.int(KIT_ANIM);
    const procs = [0, 1, 2, 3].flatMap((index) => {
      const code = kit.int(KIT_PROCS + index);
      return code > 0 ? [{ code, params: KIT_PROC_PARAMS.map((field) => kit.float(field + index)) }] : [];
    });
    if (!effects.length && !procs.length && anim < 0 && startAnim < 0) return null;
    return { id: kitId, startAnim, anim, effects, procs };
  }

  // The spell's name, rank, and whether it taunts, or null if the client has
  // no such spell.
  info(spellId) {
    const spell = this.table('Spell').get(spellId);
    if (!spell) return null;
    const taunt = SPELL_EFFECT_FIELDS.some((field) => spell.int(field) === EFFECT_ATTACK_ME)
      || SPELL_AURA_FIELDS.some((field) => spell.int(field) === AURA_MOD_TAUNT);
    return { id: spellId, name: spell.string(SPELL_NAME_FIELD), rank: spell.string(SPELL_RANK_FIELD), taunt };
  }

  // Everything wowmin draws for a spell, or null if it has no art.
  forSpell(spellId) {
    const spell = this.table('Spell').get(spellId);
    const visual = spell ? this.table('SpellVisual').get(spell.uint(SPELL_VISUAL_FIELD)) : null;
    if (!visual) return null;
    const kits = {};
    for (const [stage, field] of Object.entries(VISUAL_KITS)) {
      const kit = this.kit(visual.uint(field));
      if (kit) kits[stage] = kit;
    }
    const missile = this.effect(visual.uint(VISUAL_MISSILE_MODEL));
    if (!missile && !Object.keys(kits).length) return null;
    const falling = this.effect(FALLING_EFFECTS[visual.uint(0)] ?? 0);
    return {
      spellId,
      visualId: visual.uint(0),
      missile: missile && {
        ...missile,
        attachment: visual.int(VISUAL_MISSILE_ATTACHMENT),
        destinationAttachment: visual.int(VISUAL_MISSILE_DESTINATION_ATTACHMENT),
      },
      falling,
      kits,
    };
  }
}

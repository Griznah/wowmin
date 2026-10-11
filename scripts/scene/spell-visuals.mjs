// Resolves a spell to the client's own art for it: Spell.dbc → SpellVisual →
// SpellVisualKit (one per stage: precast, cast, impact, ...) → the effect
// model on each body slot (SpellVisualEffectName). Field numbers are for
// 3.3.5 and were checked against the client's tables.

import { readDbc } from './dbc.mjs';

const SPELL_VISUAL_FIELD = 131;
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
// SpellVisualEffectName: name, file, area effect size, scale.
const EFFECT_FILE = 2;
const EFFECT_AREA_SIZE = 3;
const EFFECT_SCALE = 4;

export class SpellVisuals {
  constructor(readFile) {
    this.readFile = readFile;
    this.tables = new Map();
  }

  table(name) {
    if (!this.tables.has(name)) {
      const buffer = this.readFile(`DBFilesClient\\${name}.dbc`);
      this.tables.set(name, buffer ? readDbc(buffer).byId() : new Map());
    }
    return this.tables.get(name);
  }

  // The model file for an effect, or null if it isn't in the client.
  effectModel(effectId) {
    const effect = this.table('SpellVisualEffectName').get(effectId);
    const file = effect?.string(EFFECT_FILE);
    if (!file) return null;
    const modelName = file.replace(/\.md[xl]$/i, '.m2');
    return this.readFile(modelName) ? modelName : null;
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
    if (!effects.length && anim < 0 && startAnim < 0) return null;
    return { id: kitId, startAnim, anim, effects };
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
    return {
      spellId,
      visualId: visual.uint(0),
      missile: missile && {
        ...missile,
        attachment: visual.int(VISUAL_MISSILE_ATTACHMENT),
        destinationAttachment: visual.int(VISUAL_MISSILE_DESTINATION_ATTACHMENT),
      },
      kits,
    };
  }
}

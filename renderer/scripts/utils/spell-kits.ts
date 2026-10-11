import type { CastGlow } from './spell-events';

// The client's spell art as wowmin plays it: a spell's kits by stage, which
// body slot each effect sits on, and the animations kits name. Pure, so it
// can be tested without three.js.

// Where on a unit an effect sits (as SpellEffectLayer's anchors).
export type UnitAnchorRole = 'handRight' | 'handLeft' | 'chest' | 'head' | 'overhead' | 'feet';

// A spell's art as served by /assets/models/visual/<spellId>.json
// (scripts/scene/spell-visuals.mjs).
export interface VisualEffect {
  slot: string;
  id: number;
  scale: number;
}

export interface VisualKit {
  anim: number;
  effects: VisualEffect[];
}

export type KitStage = 'precast' | 'cast' | 'channel' | 'impact' | 'targetImpact';

export interface SpellVisual {
  missile: { id: number; scale: number } | null;
  kits: Partial<Record<KitStage, VisualKit>>;
}

// AnimationData IDs kits name, by the clip names unit models export
// (UNIT_ANIMATIONS in scripts/scene/m2-skinned.mjs).
const KIT_ANIMATIONS: Record<number, string> = {
  9: 'CombatWound', 10: 'CombatCritical', 14: 'Stun', 16: 'AttackUnarmed', 17: 'Attack1H', 32: 'SpellCast',
  51: 'ReadySpellDirected', 52: 'ReadySpellOmni', 53: 'SpellCastDirected', 54: 'SpellCastOmni', 55: 'BattleRoar',
  57: 'Special1H', 107: 'AttackThrown', 108: 'ReadyThrown', 118: 'SpecialUnarmed', 123: 'UseStandingLoop',
  124: 'ChannelCastDirected', 125: 'ChannelCastOmni',
};

export function kitAnimationName(anim: number | undefined): string | null {
  return anim === undefined ? null : KIT_ANIMATIONS[anim] ?? null;
}

// Kit body slots onto the points units have.
export function slotAnchor(slot: string): UnitAnchorRole {
  switch (slot) {
    case 'head': case 'breath': return 'head';
    case 'base': case 'world': return 'feet';
    case 'leftHand': case 'leftWeapon': return 'handLeft';
    case 'rightHand': case 'rightWeapon': return 'handRight';
    default: return 'chest';
  }
}

// The kit a cast plays: the cast kit as it fires, the channel kit (or the
// precast kit) while channelling, and the precast kit while casting.
export function castKit(visual: SpellVisual, cast: Pick<CastGlow, 'release' | 'channeled'>): VisualKit | undefined {
  if (cast.release) return visual.kits.cast;
  if (cast.channeled) return visual.kits.channel ?? visual.kits.precast;
  return visual.kits.precast;
}


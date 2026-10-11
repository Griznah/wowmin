import type { CastGlow } from './spell-events';

// The client's spell art as wowmin plays it: a spell's kits by stage, which
// body slot each effect sits on, and the animations kits name. Pure, so it
// can be tested without three.js.

// Where on a unit an effect sits (as SpellEffectLayer's anchors).
export type UnitAnchorRole = 'handRight' | 'handLeft' | 'chest' | 'head' | 'breath' | 'overhead' | 'feet';

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
  // Procedures the client runs for the kit: a code and four parameters.
  procs?: Array<{ code: number; params: number[] }>;
}

export type KitStage = 'precast' | 'cast' | 'channel' | 'impact' | 'targetImpact' | 'instantArea' | 'impactArea' | 'persistentArea';

export interface SpellVisual {
  missile: { id: number; scale: number } | null;
  // The model procedure 9 rains over the area (Blizzard, Rain of Fire).
  falling?: { id: number; scale: number } | null;
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
    case 'head': return 'head';
    case 'breath': return 'breath';
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


// Procedure 9 rains a model over the area; its second parameter looks like
// the number a second (5 for Blizzard and Rain of Fire).
const RAIN_PROCEDURE = 9;
const DEFAULT_RAIN_RATE = 5;
// Ground art drawn at the models' own size looked a little too large next to
// the client (the user's eye on Consecration, Flamestrike, Death and Decay,
// and Blizzard), so area-kit models are scaled by this, and falling models
// land within this share of the spell's radius.
export const AREA_ART_SCALE = 0.75;
export const RAIN_SPREAD = AREA_ART_SCALE;

// How many falling models a second the spell's area rains, or 0 for none.
export function rainRate(visual: SpellVisual): number {
  if (!visual.falling) return 0;
  for (const kit of [visual.kits.persistentArea, visual.kits.impactArea, visual.kits.instantArea]) {
    const proc = kit?.procs?.find((candidate) => candidate.code === RAIN_PROCEDURE);
    if (proc) return proc.params[1] > 0 ? proc.params[1] : DEFAULT_RAIN_RATE;
  }
  return 0;
}

// A point spread evenly over a disc of `radius` round `center`, from two
// random numbers in [0, 1).
export function pointInDisc(center: [number, number, number], radius: number, a: number, b: number): [number, number, number] {
  const distance = radius * Math.sqrt(a);
  const angle = b * Math.PI * 2;
  return [center[0] + Math.cos(angle) * distance, center[1] + Math.sin(angle) * distance, center[2]];
}

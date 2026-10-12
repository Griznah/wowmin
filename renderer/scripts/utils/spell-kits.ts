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
  id: number;
  anim: number;
  effects: VisualEffect[];
  // Procedures the client runs for the kit: a code and four parameters.
  procs?: Array<{ code: number; params: number[] }>;
}

export type KitStage = 'precast' | 'cast' | 'channel' | 'impact' | 'targetImpact' | 'state' | 'instantArea' | 'impactArea' | 'persistentArea';

// A chain drawn from the caster to its target and on to each target it
// jumps to (SpellChainEffects): its texture (served as
// /assets/models/icon/chain-<id>.png), width and texture length in yards,
// and how long each link shows and the delay between links (ms).
export interface SpellChain {
  id: number;
  width: number;
  textureScale: number;
  segmentMs: number;
  delayMs: number;
}

// An aura that keeps casting an area spell round its bearer (Starfall):
// how far it reaches, the spells it casts, and its school.
export interface BearerArea {
  radius: number;
  triggers: number[];
  schoolMask: number;
}

export interface SpellVisual {
  missile: { id: number; scale: number } | null;
  // The model procedure 9 rains over the area (Blizzard, Rain of Fire).
  falling?: { id: number; scale: number } | null;
  kits: Partial<Record<KitStage, VisualKit>>;
  chain?: SpellChain;
  bearerArea?: BearerArea;
  // Art by school bit, for spells whose art depends on the cast's school
  // (a wand's Shoot); the spell's own fields are then empty.
  bySchool?: Record<string, SpellVisual>;
}

// The art a cast of this school plays: the school's own for a spell that
// has art by school (null if its school has none), else the spell's.
export function artForSchool(visual: SpellVisual, schoolMask: number): SpellVisual | null {
  if (!visual.bySchool) return visual;
  const school = Object.keys(visual.bySchool).map(Number).find((bit) => schoolMask & bit);
  return school === undefined ? null : visual.bySchool[school];
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


// Kit procedures that colour a unit's model, as the client's unit code runs
// them: 1 multiplies the model's colour by its first parameter (0xRRGGBB,
// stored as a float) for as long as the kit plays, the newest such kit on a
// unit winning; 13 does so for a moment, holding for its second parameter
// (seconds) and fading back to white over its third, over any procedure 1
// colour. Their other parameters are unused. 14 makes the unit see-through:
// its first parameter (0 to 1) times the model's own opacity, reached over
// its third parameter (seconds; a second when 0), the newest such kit
// winning (Shadowform).
const COLOR_PROCEDURE = 1;
const COLOR_FLASH_PROCEDURE = 13;
const ALPHA_PROCEDURE = 14;
export const DEFAULT_ALPHA_FADE_MS = 1000;

export interface ColorFlash {
  color: number;
  holdMs: number;
  fadeMs: number;
}

// The colour a kit gives its unit while it plays, or null.
export function kitColor(kit: VisualKit): number | null {
  const proc = kit.procs?.find((candidate) => candidate.code === COLOR_PROCEDURE);
  return proc ? Math.round(proc.params[0]) & 0xffffff : null;
}

// How see-through a kit makes its unit while it plays, and how fast it
// fades to that, or null.
export function kitAlpha(kit: VisualKit): { alpha: number; fadeMs: number } | null {
  const proc = kit.procs?.find((candidate) => candidate.code === ALPHA_PROCEDURE);
  if (!proc || !(proc.params[0] > 0 && proc.params[0] <= 1)) return null;
  return { alpha: proc.params[0], fadeMs: proc.params[2] > 0 ? proc.params[2] * 1000 : DEFAULT_ALPHA_FADE_MS };
}

// The colour flash a kit starts on its unit, or null.
export function kitColorFlash(kit: VisualKit): ColorFlash | null {
  const proc = kit.procs?.find((candidate) => candidate.code === COLOR_FLASH_PROCEDURE);
  if (!proc) return null;
  return { color: Math.round(proc.params[0]) & 0xffffff, holdMs: proc.params[1] * 1000, fadeMs: proc.params[2] * 1000 };
}

// A flash's colour `elapsedMs` after it began: its own while it holds, then
// fading to white; null once it is over.
export function flashColor(flash: ColorFlash, elapsedMs: number): number | null {
  if (elapsedMs < 0) return null;
  if (elapsedMs < flash.holdMs) return flash.color;
  const fade = elapsedMs - flash.holdMs;
  if (fade >= flash.fadeMs) return null;
  const strength = 1 - fade / flash.fadeMs;
  const channel = (shift: number) => Math.round(255 - (255 - ((flash.color >> shift) & 0xff)) * strength);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
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

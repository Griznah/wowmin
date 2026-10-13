// Chooses what a unit model is doing from what the live stream says about it:
// standing, moving, fighting, casting, or dead. Swings are not synced to real
// hits; a fighting unit strikes every few seconds with a ready pose between.

export type UnitStance = 'stand' | 'walk' | 'run' | 'dead' | 'melee' | 'ranged' | 'cast';
export type UnitCombatStyle = 'melee' | 'ranged' | 'cast';

export interface UnitWeapons {
  mainHandType: number;
  mainHandSubclass: number;
  offHandType: number;
  rangedSubclass: number;
}

// Faster than this (yards per second) counts as moving; walking up to
// UNIT_RUN_SPEED, running beyond it.
export const UNIT_MOVING_SPEED = 0.6;
export const UNIT_RUN_SPEED = 4;

// InventoryType values (item_template.InventoryType).
const INVENTORY_WEAPON = 13;
const INVENTORY_TWO_HAND = 17;
const INVENTORY_MAIN_HAND = 21;
const INVENTORY_OFF_HAND = 22;
// Weapon subclasses.
const WEAPON_BOW = 2;
const WEAPON_GUN = 3;
const WEAPON_POLEARM = 6;
const WEAPON_STAFF = 10;
const WEAPON_CROSSBOW = 18;

const CLASS_WARRIOR = 1;
const CLASS_PALADIN = 2;
const CLASS_HUNTER = 3;
const CLASS_ROGUE = 4;
const CLASS_DEATH_KNIGHT = 6;
const CLASS_SHAMAN = 7;
const CLASS_DRUID = 11;

export function chooseUnitStance(unit: {
  alive: boolean;
  speed: number;
  inCombat: boolean;
  style: UnitCombatStyle | null;
}): UnitStance {
  if (!unit.alive) return 'dead';
  if (unit.speed > UNIT_MOVING_SPEED) return unit.speed > UNIT_RUN_SPEED ? 'run' : 'walk';
  if (unit.inCombat && unit.style) return unit.style;
  return 'stand';
}

function isDualWielding(weapons: UnitWeapons): boolean {
  return weapons.offHandType === INVENTORY_WEAPON || weapons.offHandType === INVENTORY_OFF_HAND;
}

// How a player fights, from class, gear, and (for bots) strategies. A
// shapeshifted druid fights in melee.
export function getPlayerCombatStyle(
  classId: number,
  weapons: UnitWeapons,
  { shapeshifted = false, strategies = [] as string[] } = {},
): UnitCombatStyle {
  if (strategies.includes('ranged') || strategies.includes('heal')) {
    return classId === CLASS_HUNTER ? 'ranged' : 'cast';
  }
  if (strategies.includes('tank') || strategies.includes('close') || strategies.includes('melee')) return 'melee';
  switch (classId) {
    case CLASS_WARRIOR:
    case CLASS_PALADIN:
    case CLASS_ROGUE:
    case CLASS_DEATH_KNIGHT:
      return 'melee';
    case CLASS_HUNTER:
      return weapons.rangedSubclass === WEAPON_BOW || weapons.rangedSubclass === WEAPON_GUN
        || weapons.rangedSubclass === WEAPON_CROSSBOW ? 'ranged' : 'melee';
    case CLASS_SHAMAN:
      return isDualWielding(weapons) ? 'melee' : 'cast';
    case CLASS_DRUID:
      return shapeshifted ? 'melee' : 'cast';
    default:
      return 'cast';
  }
}

// A creature in combat strikes when its target is in reach (or unknown), and
// otherwise casts if its model can.
export function getCreatureCombatStyle(targetDistance: number | null, canCast: boolean, reach = 6): UnitCombatStyle {
  if (targetDistance === null || targetDistance <= reach) return 'melee';
  return canCast ? 'cast' : 'melee';
}

function first(available: ReadonlySet<string>, names: string[]): string | null {
  return names.find((name) => available.has(name)) ?? null;
}

// The looping clip for a stance and, when fighting, the clip for each strike,
// picked from the clips the model has.
export function getStanceClips(
  stance: UnitStance,
  weapons: UnitWeapons,
  available: ReadonlySet<string>,
): { loop: string | null; strike: string | null; holdLastFrame?: boolean } {
  const twoHand = weapons.mainHandType === INVENTORY_TWO_HAND;
  const long = twoHand && (weapons.mainHandSubclass === WEAPON_POLEARM || weapons.mainHandSubclass === WEAPON_STAFF);
  const oneHand = weapons.mainHandType === INVENTORY_WEAPON || weapons.mainHandType === INVENTORY_MAIN_HAND;
  const stand = first(available, ['Stand']);
  switch (stance) {
    case 'dead':
      return available.has('Death')
        ? { loop: 'Death', strike: null, holdLastFrame: true }
        : { loop: first(available, ['Dead', 'Stand']), strike: null };
    case 'walk':
      return { loop: first(available, ['Walk', 'Run', 'Stand']), strike: null };
    case 'run':
      return { loop: first(available, ['Run', 'Walk', 'Stand']), strike: null };
    case 'melee': {
      const attacks = long ? ['Attack2HL', 'Attack2H'] : twoHand ? ['Attack2H', 'Attack2HL'] : oneHand ? ['Attack1H'] : [];
      const ready = long ? ['Ready2HL', 'Ready2H'] : twoHand ? ['Ready2H', 'Ready2HL'] : oneHand ? ['Ready1H'] : [];
      return {
        loop: first(available, [...ready, 'ReadyUnarmed', 'Ready1H', 'Stand']),
        strike: first(available, [...attacks, 'AttackUnarmed', 'Attack1H', 'Attack2H']),
      };
    }
    case 'ranged': {
      const gun = weapons.rangedSubclass === WEAPON_GUN;
      return {
        loop: first(available, gun ? ['ReadyRifle', 'ReadyBow'] : ['ReadyBow', 'ReadyRifle']) ?? stand,
        strike: first(available, gun ? ['AttackRifle', 'AttackBow'] : ['AttackBow', 'AttackRifle']),
      };
    }
    case 'cast':
      return {
        loop: first(available, ['ReadySpellDirected', 'ReadySpellOmni', 'Stand']),
        strike: first(available, ['SpellCastDirected', 'SpellCastOmni', 'AttackUnarmed']),
      };
    default:
      return { loop: stand, strike: null };
  }
}

// Seconds between strikes, varied per unit so a pack doesn't swing in step.
export function getStrikeInterval(stance: UnitStance, jitter: number): number {
  const [base, spread] = stance === 'cast' ? [2.4, 0.8] : stance === 'ranged' ? [2.2, 0.6] : [1.6, 0.6];
  return base + spread * Math.min(1, Math.max(0, jitter));
}

// Playback rate for a movement clip, so feet roughly match ground speed.
export function getMoveTimeScale(speed: number, clipSpeed: number | undefined): number {
  if (!clipSpeed || clipSpeed <= 0 || speed <= 0) return 1;
  return Math.min(2, Math.max(0.5, speed / clipSpeed));
}

// Weapons sit in the hands when drawn and on the back or hip otherwise; a
// drawn ranged weapon puts the melee ones away.
export function isItemShown(role: string, placement: 'drawn' | 'sheathed', sheathState: number): boolean {
  const drawn = role === 'ranged' ? sheathState === 2 : sheathState === 1;
  return placement === 'drawn' ? drawn : !drawn;
}

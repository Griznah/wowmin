import { type Camera, Group } from 'three';

import type { CombatEffectStore, Impact, Point3, Projectile, UnitKey } from '../utils/spell-events';
import { EffectInstance, type EffectPlacement, type EffectTemplate, getEffectView, loadEffectTemplate } from './m2-effect';
import type { UnitAnchorRole } from './spell-effects';

// Plays the client's own spell art (level 2) for the combat effect store's
// missiles and impacts, from the spell's SpellVisual: the missile model in
// flight and the impact kit's models on the target. Spells without art, or
// whose art is still loading, are left to the level 1 glows
// (SpellEffectLayer), which asks `handles` first.

// A spell's art as served by /assets/models/visual/<spellId>.json
// (scripts/scene/spell-visuals.mjs).
interface VisualEffect {
  slot: string;
  id: number;
  scale: number;
}

interface VisualKit {
  effects: VisualEffect[];
}

interface SpellVisual {
  missile: { id: number; scale: number } | null;
  kits: Partial<Record<'impact' | 'targetImpact', VisualKit>>;
}

export type UnitAnchorWithScale = (unit: UnitKey, role: UnitAnchorRole) => Point3 | null;

interface PlayingEffect {
  instance: EffectInstance;
  // Where it is this frame, or null to stay where it was.
  place: (now: number) => EffectPlacement | null;
  // When it stops emitting (ms, delayed clock); null to stop when told.
  stopAt: number | null;
  last: EffectPlacement | null;
}

// Global particle budget: past it, emitters stop spawning until room frees.
export const PARTICLE_BUDGET = 4000;

// Kit body slots onto the points units have.
function slotAnchor(slot: string): UnitAnchorRole {
  switch (slot) {
    case 'head': case 'breath': return 'head';
    case 'base': case 'world': return 'feet';
    case 'leftHand': case 'leftWeapon': return 'handLeft';
    case 'rightHand': case 'rightWeapon': return 'handRight';
    default: return 'chest';
  }
}

export class SpellVisualLayer {
  readonly group = new Group();
  private readonly visuals = new Map<number, SpellVisual | null | 'loading'>();
  private readonly templates = new Map<number, EffectTemplate | null | 'loading'>();
  private readonly playing: PlayingEffect[] = [];
  private readonly missiles = new Map<Projectile, PlayingEffect>();
  private readonly seenImpacts = new WeakSet<Impact>();
  private particleCount = 0;

  constructor(private readonly onLoaded: () => void) {
    // Server (x, y, z) Z-up becomes (x, z, -y) Y-up, as for the scene.
    this.group.rotation.x = -Math.PI / 2;
  }

  get count(): number {
    return this.playing.length;
  }

  get particles(): number {
    return this.particleCount;
  }

  // Whether this layer draws the store entry, so level 1 should not.
  handles(entry: Projectile | Impact): boolean {
    if ('travelMs' in entry) return this.missiles.has(entry);
    return this.seenImpacts.has(entry);
  }

  update(store: CombatEffectStore | null, now: number, anchor: UnitAnchorWithScale, unitScale: (unit: UnitKey) => number,
    camera: Camera): void {
    if (store) {
      for (const projectile of store.projectiles) this.startMissile(projectile, now, anchor);
      for (const impact of store.impacts) this.startImpact(impact, now, anchor, unitScale);
    }
    // Missiles the store has finished with have landed.
    for (const [projectile, effect] of this.missiles) {
      if (!store || now >= projectile.startAt + projectile.travelMs) {
        effect.instance.stop();
        this.missiles.delete(projectile);
      }
    }

    this.group.updateMatrixWorld(true);
    const view = getEffectView(camera, this.group);
    const budget = { left: PARTICLE_BUDGET };
    for (let index = this.playing.length - 1; index >= 0; index -= 1) {
      const effect = this.playing[index];
      if (effect.stopAt !== null && now >= effect.stopAt && !effect.instance.stopped) effect.instance.stop();
      const placement = effect.place(now) ?? effect.last;
      if (placement) {
        effect.last = placement;
        effect.instance.update(now, placement, view, this.group, budget);
      }
      if (effect.instance.done || (!placement && effect.instance.stopped)) {
        effect.instance.dispose();
        this.playing.splice(index, 1);
      }
    }
    this.particleCount = PARTICLE_BUDGET - budget.left;
  }

  private visual(spellId: number): SpellVisual | null | undefined {
    if (!spellId) return null;
    const known = this.visuals.get(spellId);
    if (known === 'loading') return undefined;
    if (known !== undefined) return known;
    this.visuals.set(spellId, 'loading');
    fetch(`assets/models/visual/${spellId}.json`)
      .then((response) => (response.ok ? response.json() as Promise<SpellVisual> : null))
      .catch(() => null)
      .then((visual) => {
        this.visuals.set(spellId, visual);
        if (visual) {
          if (visual.missile) this.template(visual.missile.id);
          for (const kit of [visual.kits.impact, visual.kits.targetImpact]) kit?.effects.forEach((effect) => this.template(effect.id));
        }
        this.onLoaded();
      });
    return undefined;
  }

  private template(effectId: number): EffectTemplate | null | undefined {
    const known = this.templates.get(effectId);
    if (known === 'loading') return undefined;
    if (known !== undefined) return known;
    this.templates.set(effectId, 'loading');
    loadEffectTemplate(`assets/models/effect/${effectId}.glb`)
      .then((template) => this.templates.set(effectId, template))
      .catch((error) => {
        console.warn(`Could not load spell effect ${effectId}`, error);
        this.templates.set(effectId, null);
      })
      .finally(() => this.onLoaded());
    return undefined;
  }

  private play(template: EffectTemplate, now: number, loop: boolean, place: PlayingEffect['place'],
    stopAt: number | null): PlayingEffect {
    const instance = new EffectInstance(template, now, loop);
    this.group.add(instance.root, instance.particles);
    const effect: PlayingEffect = { instance, place, stopAt, last: null };
    this.playing.push(effect);
    return effect;
  }

  private startMissile(projectile: Projectile, now: number, anchor: UnitAnchorWithScale): void {
    if (this.missiles.has(projectile) || now < projectile.startAt) return;
    const missile = this.visual(projectile.spellId)?.missile;
    if (!missile) return;
    const template = this.template(missile.id);
    if (!template) return;
    const effect = this.play(template, now, true, (time) => {
      const from = anchor(projectile.source, 'handRight');
      const to = anchor(projectile.target, 'chest');
      if (!from || !to) return null;
      const t = Math.min(1, Math.max(0, (time - projectile.startAt) / projectile.travelMs));
      const position: Point3 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      return { position, yaw: Math.atan2(dy, dx), pitch: Math.atan2(to[2] - from[2], Math.hypot(dx, dy)), scale: missile.scale };
    }, null);
    this.missiles.set(projectile, effect);
  }

  private startImpact(impact: Impact, now: number, anchor: UnitAnchorWithScale, unitScale: (unit: UnitKey) => number): void {
    if (this.seenImpacts.has(impact) || now < impact.at || impact.small) return;
    const visual = this.visual(impact.spellId);
    const kit = visual?.kits.targetImpact ?? visual?.kits.impact;
    if (!kit?.effects.length) return;
    const templates = kit.effects.map((effect) => this.template(effect.id));
    // Wait until every model is in, so the kit plays together.
    if (templates.some((template) => template === undefined)) return;
    this.seenImpacts.add(impact);
    kit.effects.forEach((effect, index) => {
      const template = templates[index];
      if (!template) return;
      const role = slotAnchor(effect.slot);
      const instance = this.play(template, now, false, () => {
        const point = anchor(impact.target, role);
        return point ? { position: point, yaw: 0, scale: effect.scale * unitScale(impact.target) } : null;
      }, null);
      instance.stopAt = now + instance.instance.duration;
    });
  }
}

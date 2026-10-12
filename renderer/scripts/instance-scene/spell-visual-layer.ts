import { type Camera, Group } from 'three';

import type { AreaEffect, AreaRing, Beam, CastGlow, CombatEffectStore, Impact, Point3, Projectile, UnitKey } from '../utils/spell-events';
import { useServerAxes } from './iso-camera';
import { EffectInstance, type EffectPlacement, type EffectTemplate, EffectTemplateCache, getEffectView } from './m2-effect';
import type { UnitAnchor } from './spell-effects';
import {
  AREA_ART_SCALE, castKit, kitAnimationName, pointInDisc, RAIN_SPREAD, rainRate, slotAnchor, type SpellVisual, type VisualKit,
} from '../utils/spell-kits';

// Plays the client's own spell art (level 2) for the combat effect store's
// casts, missiles, and impacts, from the spell's SpellVisual kits: precast
// effects on the caster while casting, channel effects while channelling,
// cast effects as it fires, the missile model in flight, and impact effects
// on the target. It also says which animations the kits name, for the unit
// models. Spells without art, or whose art is still loading, are left to the
// level 1 glows (SpellEffectLayer), which asks `handles` first.

// What the layer needs to know about units: where a point on one is, its
// overall scale, and which way it faces.
export interface UnitInfo {
  anchor: UnitAnchor;
  scale: (unit: UnitKey) => number;
  facing: (unit: UnitKey) => number;
}

// Animations a unit should play for its spells: a loop while casting or
// channelling, and a one-off as a spell fires or lands.
export interface KitAnimation {
  loop: string | null;
  once: string | null;
}

interface PlayingEffect {
  instance: EffectInstance;
  // Where it is this frame, or null to stay where it was.
  place: (now: number) => EffectPlacement | null;
  // When it stops emitting (ms, delayed clock); null to stop when told.
  stopAt: number | null;
  last: EffectPlacement | null;
}

// Global particle budget: past it, emitters stop spawning until room frees.
const PARTICLE_BUDGET = 4000;

export class SpellVisualLayer {
  readonly group = new Group();
  private readonly visuals = new Map<number, SpellVisual | null | 'loading'>();
  private readonly templates: EffectTemplateCache;
  private readonly playing: PlayingEffect[] = [];
  private readonly missiles = new Map<Projectile, PlayingEffect>();
  private readonly casts = new Map<CastGlow, { kit: VisualKit; effects: PlayingEffect[] }>();
  private readonly seenImpacts = new WeakSet<Impact>();
  // Areas being played: their lasting effects, and what they rain.
  private readonly areas = new Map<AreaEffect, {
    lasting: PlayingEffect[];
    rain: { template: EffectTemplate; scale: number; rate: number; carry: number; center: Point3; yaw: number } | null;
  }>();
  private lastUpdateAt = 0;
  // Aura art on units, by unit and state kit: its effects, and the pose it
  // names (an aura's pose wins over a cast's: a stunned unit isn't casting).
  private readonly states = new Map<string, { unit: UnitKey; kit: VisualKit; effects: PlayingEffect[] }>();
  private readonly onceAnimations = new Map<UnitKey, string>();
  private particleCount = 0;

  constructor(private readonly onLoaded: () => void) {
    this.templates = new EffectTemplateCache(onLoaded, 'spell effect');
    useServerAxes(this.group);
  }

  get count(): number {
    return this.playing.length;
  }

  get particles(): number {
    return this.particleCount;
  }

  // Whether the client's art decides how the store entry looks, so level 1
  // should not draw it: anything this layer plays, and anything of a spell
  // with art, even a stage it has no art for (Holy Light has no missile, so
  // nothing flies). Spells without art, or still loading, keep level 1.
  handles(entry: Projectile | Impact | CastGlow | AreaRing | Beam): boolean {
    const playing = 'travelMs' in entry ? this.missiles.has(entry)
      : 'radius' in entry || 'source' in entry ? false
        : 'caster' in entry ? this.casts.has(entry) : this.seenImpacts.has(entry);
    if (playing) return true;
    const visual = entry.spellId ? this.visuals.get(entry.spellId) : null;
    return typeof visual === 'object' && visual !== null;
  }

  // Whether an aura's spell shows client art on the unit, so its level 1
  // tint should give way. False while its art is loading.
  hasAuraArt(spellId: number): boolean {
    const visual = this.visuals.get(spellId);
    return typeof visual === 'object' && visual !== null && Boolean(visual.kits.state?.effects.length);
  }

  // The animations kits ask of each unit now; one-offs are handed out once.
  takeAnimations(): Map<UnitKey, KitAnimation> {
    const animations = new Map<UnitKey, KitAnimation>();
    for (const [cast, { kit }] of this.casts) {
      if (cast.release) continue;
      const loop = kitAnimationName(kit.anim);
      if (loop) animations.set(cast.caster, { loop, once: null });
    }
    for (const { unit, kit } of this.states.values()) {
      const loop = kitAnimationName(kit.anim);
      if (loop) animations.set(unit, { loop, once: null });
    }
    for (const [unit, once] of this.onceAnimations) {
      animations.set(unit, { loop: animations.get(unit)?.loop ?? null, once });
    }
    this.onceAnimations.clear();
    return animations;
  }

  // `auras` lists each unit's art auras (spell IDs), from the live stream.
  update(store: CombatEffectStore | null, now: number, units: UnitInfo, camera: Camera,
    auras: ReadonlyMap<UnitKey, readonly number[]> = new Map()): void {
    const castsNow = new Set(store?.casts ?? []);
    const areasNow = new Set(store?.areas ?? []);
    const seconds = this.lastUpdateAt ? Math.min(0.1, Math.max(0, (now - this.lastUpdateAt) / 1000)) : 0;
    this.lastUpdateAt = now;
    if (store) {
      for (const area of store.areas) this.startArea(area, now, units);
      for (const cast of store.casts) this.startCast(cast, now, units);
      for (const projectile of store.projectiles) this.startMissile(projectile, now, units);
      for (const impact of store.impacts) this.startImpact(impact, now, units);
    }
    this.syncStates(store ? auras : new Map(), now, units);
    // Casts the store has ended: held effects stop; release flashes play out.
    for (const [cast, { effects }] of this.casts) {
      if (castsNow.has(cast)) continue;
      if (!cast.release) for (const effect of effects) effect.instance.stop();
      this.casts.delete(cast);
    }
    // Areas: rain while they last; when they end, lasting effects end too.
    for (const [area, playing] of this.areas) {
      if (!areasNow.has(area) || now >= area.endAt) {
        for (const effect of playing.lasting) effect.instance.stop(now);
        if (!areasNow.has(area)) this.areas.delete(area);
        else playing.rain = null;
        continue;
      }
      const rain = playing.rain;
      if (!rain) continue;
      rain.carry += rain.rate * seconds;
      for (; rain.carry >= 1; rain.carry -= 1) {
        const position = pointInDisc(rain.center, area.radius * RAIN_SPREAD, Math.random(), Math.random());
        const drop = this.play(rain.template, now, false, () => ({ position, yaw: rain.yaw, scale: rain.scale }));
        drop.stopAt = now + drop.instance.duration;
      }
    }
    // Missiles the store has finished with have landed.
    for (const [projectile, effect] of this.missiles) {
      if (!store || now >= projectile.startAt + projectile.travelMs) {
        effect.instance.stop();
        this.missiles.delete(projectile);
      }
    }

    // Effects bring their own nodes up to date; the scene view does the rest.
    this.group.updateWorldMatrix(true, false);
    const view = getEffectView(camera, this.group);
    const budget = { left: PARTICLE_BUDGET };
    for (let index = this.playing.length - 1; index >= 0; index -= 1) {
      const effect = this.playing[index];
      if (effect.stopAt !== null && now >= effect.stopAt && !effect.instance.stopped) effect.instance.stop(now);
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
          for (const kit of Object.values(visual.kits)) kit?.effects.forEach((effect) => this.template(effect.id));
          if (visual.falling) this.template(visual.falling.id);
        }
        this.onLoaded();
      });
    return undefined;
  }

  private template(effectId: number): EffectTemplate | null | undefined {
    return this.templates.get(`assets/models/effect/${effectId}.glb`);
  }

  // The kit's templates once all are in (null for any that failed), or
  // undefined while some are loading, so a kit plays together.
  private kitTemplates(kit: VisualKit): Array<EffectTemplate | null> | undefined {
    const templates = kit.effects.map((effect) => this.template(effect.id));
    return templates.some((template) => template === undefined) ? undefined : templates as Array<EffectTemplate | null>;
  }

  private play(template: EffectTemplate, now: number, loop: boolean, place: PlayingEffect['place']): PlayingEffect {
    const instance = new EffectInstance(template, now, loop);
    this.group.add(instance.root, instance.particles);
    const effect: PlayingEffect = { instance, place, stopAt: null, last: null };
    this.playing.push(effect);
    return effect;
  }

  // Each of a kit's effects on its body slot of `unit`, following it.
  private playKit(kit: VisualKit, templates: Array<EffectTemplate | null>, unit: UnitKey, now: number, loop: boolean,
    units: UnitInfo): PlayingEffect[] {
    return kit.effects.flatMap((effect, index) => {
      const template = templates[index];
      if (!template) return [];
      const role = slotAnchor(effect.slot);
      const playing = this.play(template, now, loop, () => {
        const point = units.anchor(unit, role);
        return point ? { position: point, yaw: units.facing(unit), scale: effect.scale * units.scale(unit) } : null;
      });
      if (!loop) playing.stopAt = now + playing.instance.duration;
      return [playing];
    });
  }

  private startCast(cast: CastGlow, now: number, units: UnitInfo): void {
    if (this.casts.has(cast) || now < cast.startAt) return;
    const visual = this.visual(cast.spellId);
    const kit = visual ? castKit(visual, cast) : undefined;
    if (!kit) return;
    const templates = this.kitTemplates(kit);
    if (!templates) return;
    this.casts.set(cast, { kit, effects: this.playKit(kit, templates, cast.caster, now, !cast.release, units) });
    if (cast.release) {
      const once = kitAnimationName(kit.anim);
      if (once) this.onceAnimations.set(cast.caster, once);
    }
  }

  // Plays each shown unit's aura art (its spells' state kits, once per kit),
  // ending art for auras that have gone with its Death.
  private syncStates(auras: ReadonlyMap<UnitKey, readonly number[]>, now: number, units: UnitInfo): void {
    const wanted = new Map<string, { unit: UnitKey; kit: VisualKit }>();
    for (const [unit, spellIds] of auras) {
      if (!units.anchor(unit, 'feet')) continue;
      for (const spellId of spellIds) {
        const kit = this.visual(spellId)?.kits.state;
        if (!kit || (!kit.effects.length && kit.anim < 0)) continue;
        const key = `${unit}|${kit.id}`;
        if (!wanted.has(key)) wanted.set(key, { unit, kit });
      }
    }
    for (const [key, state] of this.states) {
      if (wanted.has(key)) continue;
      for (const effect of state.effects) effect.instance.stop(now);
      this.states.delete(key);
    }
    for (const [key, { unit, kit }] of wanted) {
      if (this.states.has(key)) continue;
      const templates = this.kitTemplates(kit);
      if (!templates) continue;
      this.states.set(key, { unit, kit, effects: this.playKit(kit, templates, unit, now, true, units) });
    }
  }

  private startArea(area: AreaEffect, now: number, units: UnitInfo): void {
    if (this.areas.has(area) || now < area.startAt) return;
    const visual = this.visual(area.spellId);
    if (visual === undefined) return;
    if (visual === null) {
      this.areas.set(area, { lasting: [], rain: null });
      return;
    }
    const once = [visual.kits.instantArea, visual.kits.impactArea].filter((kit): kit is VisualKit => Boolean(kit));
    const lasting = visual.kits.persistentArea;
    const rate = rainRate(visual);
    // Wait until every model is in, so the area plays together.
    const kitTemplates = [...once, ...(lasting ? [lasting] : [])].map((kit) => this.kitTemplates(kit));
    const rainTemplate = rate > 0 && visual.falling ? this.template(visual.falling.id) : null;
    if (kitTemplates.some((templates) => !templates) || rainTemplate === undefined) return;
    const center = area.point ?? units.anchor(area.caster, 'feet');
    if (!center) return;
    const yaw = units.facing(area.caster);
    const placeAt = (scale: number) => () => ({ position: center, yaw, scale: scale * AREA_ART_SCALE });
    once.forEach((kit, index) => kit.effects.forEach((effect, slot) => {
      const template = kitTemplates[index]![slot];
      if (!template) return;
      const playing = this.play(template, now, false, placeAt(effect.scale));
      playing.stopAt = now + playing.instance.duration;
    }));
    const lasts = area.endAt > area.startAt;
    const lastingEffects = lasting ? lasting.effects.flatMap((effect, slot) => {
      const template = kitTemplates[once.length]![slot];
      if (!template) return [];
      const playing = this.play(template, now, lasts, placeAt(effect.scale));
      if (!lasts) playing.stopAt = now + playing.instance.duration;
      return lasts ? [playing] : [];
    }) : [];
    this.areas.set(area, {
      lasting: lastingEffects,
      rain: rainTemplate && lasts ? { template: rainTemplate, scale: visual.falling!.scale, rate, carry: 0, center, yaw } : null,
    });
  }

  private startMissile(projectile: Projectile, now: number, units: UnitInfo): void {
    if (this.missiles.has(projectile) || now < projectile.startAt) return;
    const missile = this.visual(projectile.spellId)?.missile;
    if (!missile) return;
    const template = this.template(missile.id);
    if (!template) return;
    const effect = this.play(template, now, true, (time) => {
      const from = units.anchor(projectile.source, 'handRight');
      const to = units.anchor(projectile.target, 'chest');
      if (!from || !to) return null;
      const t = Math.min(1, Math.max(0, (time - projectile.startAt) / projectile.travelMs));
      const position: Point3 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      return { position, yaw: Math.atan2(dy, dx), pitch: Math.atan2(to[2] - from[2], Math.hypot(dx, dy)), scale: missile.scale };
    });
    this.missiles.set(projectile, effect);
  }

  private startImpact(impact: Impact, now: number, units: UnitInfo): void {
    if (this.seenImpacts.has(impact) || now < impact.at || impact.small) return;
    const visual = this.visual(impact.spellId);
    const kit = visual?.kits.targetImpact ?? visual?.kits.impact;
    if (!kit) return;
    const templates = this.kitTemplates(kit);
    if (!templates) return;
    this.seenImpacts.add(impact);
    this.playKit(kit, templates, impact.target, now, false, units);
    const once = kitAnimationName(kit.anim);
    if (once) this.onceAnimations.set(impact.target, once);
  }
}

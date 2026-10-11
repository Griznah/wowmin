import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
} from 'three';

import {
  type CombatEffectStore,
  type Impact,
  IMPACT_LIFETIME_MS,
  type Point3,
  type Projectile,
  type UnitKey,
} from '../utils/spell-events';

// Draws the combat effect store's live effects as glowing additive sprites
// and floor rings, in server coordinates under a Z-up group like the unit
// models. Effects are drawn without depth testing, like the unit floor rings,
// so walls never hide them.

// Where on a unit an effect sits.
export type UnitAnchorRole = 'handRight' | 'handLeft' | 'chest' | 'head' | 'overhead' | 'feet';
// A unit's anchor point in server coordinates, or null if it isn't shown.
export type UnitAnchor = (unit: UnitKey, role: UnitAnchorRole) => Point3 | null;

const EFFECT_RENDER_ORDER = 3;
const RING_LIFT = 0.08;
const BEAM_SPACING = 1.2;
const MAX_BEAM_SPRITES = 40;
const TRAIL_SPRITES = 3;
const NO_EFFECTS: Pick<CombatEffectStore, 'casts' | 'beams' | 'projectiles' | 'impacts' | 'rings'> = {
  casts: [], beams: [], projectiles: [], impacts: [], rings: [],
};

function createGlowTexture(): Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

const lerp = (from: Point3, to: Point3, t: number): Point3 =>
  [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

interface FloorRing {
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  fill: Mesh<CircleGeometry, MeshBasicMaterial>;
}

export class SpellEffectLayer {
  readonly group = new Group();
  private readonly texture = createGlowTexture();
  private readonly sprites: Sprite[] = [];
  private readonly floorRings: FloorRing[] = [];
  private spritesUsed = 0;
  private ringsUsed = 0;
  private drawn = 0;

  constructor() {
    // Server (x, y, z) Z-up becomes (x, z, -y) Y-up, as for the scene.
    this.group.rotation.x = -Math.PI / 2;
  }

  // Effects drawn in the last update, for the debug overlay.
  get count(): number {
    return this.drawn;
  }

  // Draws the store's effects, or none for a null store, except missiles and
  // impacts `skip` says are drawn elsewhere (the client's own art).
  update(store: CombatEffectStore | null, now: number, anchor: UnitAnchor,
    skip: (entry: Projectile | Impact) => boolean = () => false): void {
    this.spritesUsed = 0;
    this.ringsUsed = 0;
    let drawn = 0;
    const effects = store ?? NO_EFFECTS;

    for (const cast of effects.casts) {
      if (cast.startAt > now) continue;
      const right = anchor(cast.caster, 'handRight');
      if (!right) continue;
      drawn += 1;
      if (cast.release) {
        const t = clamp01((now - cast.startAt) / (cast.endAt - cast.startAt));
        this.sprite(right, cast.color, 1.6 + 1.6 * t, 1 - t);
        continue;
      }
      // Grows as the cast fills, with a gentle pulse.
      const progress = clamp01((now - cast.startAt) / Math.max(1, cast.endAt - cast.startAt));
      const size = (0.8 + 0.8 * progress) * (1 + 0.12 * Math.sin(now / 90));
      this.sprite(right, cast.color, size, 0.9);
      const left = anchor(cast.caster, 'handLeft');
      if (left) this.sprite(left, cast.color, size * 0.85, 0.75);
    }

    for (const beam of effects.beams) {
      if (beam.startAt > now) continue;
      const from = anchor(beam.source, 'handRight');
      const to = anchor(beam.target, 'chest');
      if (!from || !to) continue;
      drawn += 1;
      const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      const count = Math.min(MAX_BEAM_SPRITES, Math.max(2, Math.ceil(length / BEAM_SPACING)));
      // Flows from the caster to the target.
      const flow = (now / 400) % 1;
      for (let index = 0; index < count; index += 1) {
        this.sprite(lerp(from, to, (index + flow) / count), beam.color, 0.8, 0.65);
      }
    }

    for (const projectile of effects.projectiles) {
      if (projectile.startAt > now || skip(projectile)) continue;
      const from = anchor(projectile.source, 'handRight');
      const to = anchor(projectile.target, 'chest');
      if (!from || !to) continue;
      drawn += 1;
      const t = clamp01((now - projectile.startAt) / projectile.travelMs);
      if (projectile.streak) {
        for (let index = 0; index < 4; index += 1) {
          this.sprite(lerp(from, to, clamp01(t - index * 0.12)), projectile.color, 0.9 - index * 0.15, 0.9 - index * 0.2);
        }
        continue;
      }
      const head = projectile.physical ? 0.6 : 1.4;
      this.sprite(lerp(from, to, t), projectile.color, head, 1);
      for (let index = 1; index <= TRAIL_SPRITES; index += 1) {
        const behind = clamp01(t - index * 0.05);
        this.sprite(lerp(from, to, behind), projectile.color, head * (1 - index * 0.22), 0.7 - index * 0.18);
      }
    }

    for (const impact of effects.impacts) {
      if (impact.at > now || skip(impact)) continue;
      const t = clamp01((now - impact.at) / IMPACT_LIFETIME_MS);
      const scale = impact.small ? 0.5 : 1;
      if (impact.heal) {
        const feet = anchor(impact.target, 'feet');
        const top = anchor(impact.target, 'overhead');
        if (!feet || !top) continue;
        drawn += 1;
        // Sparkles rising up the body.
        for (let index = 0; index < 3; index += 1) {
          const rise = clamp01(t + index * 0.2);
          const point = lerp(feet, top, rise);
          point[0] += Math.cos(index * 2.1) * 0.35;
          point[1] += Math.sin(index * 2.1) * 0.35;
          this.sprite(point, impact.color, 0.8 * scale, (1 - t) * 0.9);
        }
        continue;
      }
      const chest = anchor(impact.target, 'chest');
      if (!chest) continue;
      drawn += 1;
      this.sprite(chest, impact.color, (1 + 2 * t) * scale, 1 - t);
    }

    for (const area of effects.rings) {
      if (area.startAt > now) continue;
      const center = area.point ?? anchor(area.caster, 'feet');
      // The caster must be shown, even for a ring at a ground point.
      if (!center || !anchor(area.caster, 'feet')) continue;
      drawn += 1;
      const total = area.endAt - area.startAt;
      const elapsed = now - area.startAt;
      const left = area.endAt - now;
      // A flash fades out; a long-lived area pulses and fades at the end.
      const opacity = total <= 1000
        ? 0.85 * (1 - clamp01(elapsed / total))
        : (0.45 + 0.1 * Math.sin(now / 250)) * clamp01(left / 300) * clamp01(elapsed / 200);
      this.ring(center, area.radius, area.color, opacity);
    }

    for (let index = this.spritesUsed; index < this.sprites.length; index += 1) this.sprites[index].visible = false;
    for (let index = this.ringsUsed; index < this.floorRings.length; index += 1) {
      this.floorRings[index].ring.visible = false;
      this.floorRings[index].fill.visible = false;
    }
    this.drawn = drawn;
  }

  private sprite(position: Point3, color: string, size: number, opacity: number): void {
    if (opacity <= 0 || size <= 0) return;
    let sprite = this.sprites[this.spritesUsed];
    if (!sprite) {
      sprite = new Sprite(new SpriteMaterial({
        map: this.texture, blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
      }));
      sprite.renderOrder = EFFECT_RENDER_ORDER;
      sprite.frustumCulled = false;
      this.sprites.push(sprite);
      this.group.add(sprite);
    }
    this.spritesUsed += 1;
    sprite.visible = true;
    sprite.position.set(position[0], position[1], position[2]);
    sprite.scale.set(size, size, 1);
    sprite.material.color.set(color);
    sprite.material.opacity = Math.min(1, opacity);
  }

  private ring(center: Point3, radius: number, color: string, opacity: number): void {
    if (opacity <= 0 || radius <= 0) return;
    let floor = this.floorRings[this.ringsUsed];
    if (!floor) {
      const material = () => new MeshBasicMaterial({
        blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
      });
      floor = {
        ring: new Mesh(new RingGeometry(0.92, 1, 64), material()),
        fill: new Mesh(new CircleGeometry(0.92, 64), material()),
      };
      for (const mesh of [floor.ring, floor.fill]) {
        mesh.renderOrder = EFFECT_RENDER_ORDER;
        mesh.frustumCulled = false;
        this.group.add(mesh);
      }
      this.floorRings.push(floor);
    }
    this.ringsUsed += 1;
    for (const [mesh, strength] of [[floor.ring, 1], [floor.fill, 0.18]] as const) {
      mesh.visible = true;
      mesh.position.set(center[0], center[1], center[2] + RING_LIFT);
      mesh.scale.set(radius, radius, 1);
      mesh.material.color.set(color);
      mesh.material.opacity = opacity * strength;
    }
  }
}

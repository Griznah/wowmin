import {
  AdditiveBlending,
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  LoopOnce,
  LoopRepeat,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  NormalBlending,
  type Object3D,
  RingGeometry,
  SkinnedMesh,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { Point3, StrikeKind } from '../utils/spell-events';
import {
  chooseUnitStance,
  getMoveTimeScale,
  getStanceClips,
  getStrikeInterval,
  isItemShown,
  type UnitCombatStyle,
  type UnitStance,
  type UnitWeapons,
} from '../utils/unit-animation';

// One unit to draw, in server coordinates.
export interface UnitModelPose {
  id: string;
  url: string;
  x: number;
  y: number;
  z: number;
  orientation: number;
  scale: number;
  alive: boolean;
  inCombat: boolean;
  // How it fights when in combat, or null if it just stands.
  style: UnitCombatStyle | null;
  weapons: UnitWeapons;
  // 0 weapons sheathed, 1 melee weapons drawn, 2 ranged weapon drawn.
  sheathState: number;
  marker: UnitMarkerStyle;
  // A real attack that starts now, from the combat events.
  strike?: StrikeKind | null;
  // Recent attacks came from real events, so no made-up timed strikes.
  eventDriven?: boolean;
  // Glow colour for a notable aura, or null for none.
  tint?: string | null;
  // Animations the spell's kits name: a loop while casting or channelling,
  // and a one-off as a spell fires or lands (clip names; skipped if the
  // model lacks them).
  kitLoop?: string | null;
  kitOnce?: string | null;
}

// Effect points the converter exports on the skeleton.
export type UnitPointRole = 'handRight' | 'handLeft' | 'chest' | 'head' | 'breath' | 'overhead';

// The ring on the floor under a model, with a pointer the way it faces.
export interface UnitMarkerStyle {
  color: string;
  inCombat: boolean;
  selected: boolean;
  // Drawn as an arc inside the ring; null for none (players, full health).
  healthPct: number | null;
  // Scenery gets no ring or pointer at all.
  hidden?: boolean;
}

interface ModelTemplate {
  state: 'loading' | 'ready' | 'failed';
  scene?: Object3D;
  clips?: Map<string, AnimationClip>;
  speeds?: Record<string, number>;
  // Floor ring radius in model units, from the model's footprint.
  radius?: number;
  // Standing height in model units (times the display scale).
  height?: number;
}

interface UnitMarker {
  group: Group;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  pointer: Mesh<BufferGeometry, MeshBasicMaterial>;
  combat: Mesh<RingGeometry, MeshBasicMaterial>;
  selected: Mesh<RingGeometry, MeshBasicMaterial>;
  health: Mesh<RingGeometry, MeshBasicMaterial>;
  radius: number;
  healthShown: number | null;
}

interface UnitInstance {
  url: string;
  root: Group;
  mixer: AnimationMixer;
  template: ModelTemplate;
  loop: AnimationAction | null;
  loopName: string | null;
  strike: AnimationAction | null;
  stance: UnitStance | null;
  nextStrikeAt: number;
  jitter: number;
  // Smoothed ground speed from successive positions.
  lastX: number;
  lastY: number;
  lastAt: number;
  speed: number;
  seenAlive: boolean;
  sheathState: number | null;
  // Item models tagged drawn or sheathed by the converter.
  sheathItems: Object3D[];
  marker: UnitMarker;
  model: Object3D;
  points: Map<string, Object3D>;
  tint: string | null;
  // The shared materials swapped out for tinted copies, by mesh.
  tinted: Map<Mesh, Material | Material[]>;
}

const CROSSFADE_SECONDS = 0.2;
const SPEED_SMOOTHING = 0.25;
// The longest step the mixers advance in one frame, so a stalled tab doesn't
// jump animations.
const MAX_STEP_SECONDS = 0.1;
// Floor rings: drawn after the scene without depth testing, so the floor
// never hides them, and before the models, which stand on them.
const MARKER_RENDER_ORDER = 1;
const MODEL_RENDER_ORDER = 2;
const MARKER_LIFT = 0.05;
const MARKER_MIN_RADIUS = 0.6;
const MARKER_MAX_RADIUS = 8;
const TINT_STRENGTH = 0.55;
const COMBAT_COLOR = '#ef4444';
const SELECTED_COLOR = '#fbbf24';

// Floor ring radius for a model: a little under half its widest footprint.
export function getMarkerRadius(sizeX: number, sizeY: number, displayScale: number): number {
  const radius = Math.max(sizeX, sizeY) * 0.45;
  return Math.min(MARKER_MAX_RADIUS, Math.max(MARKER_MIN_RADIUS, radius)) * (displayScale || 1);
}

function healthColor(fraction: number): string {
  return fraction > 0.5 ? '#22c55e' : fraction > 0.2 ? '#eab308' : '#dc2626';
}

function markerMesh<T extends BufferGeometry>(geometry: T, color: string): Mesh<T, MeshBasicMaterial> {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, side: DoubleSide, depthTest: false, depthWrite: false }));
  mesh.renderOrder = MARKER_RENDER_ORDER;
  mesh.frustumCulled = false;
  return mesh;
}

// The pointer: a triangle just outside the ring, ahead of the unit (+X).
function pointerGeometry(radius: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    radius * 1.1, radius * 0.32, 0,
    radius * 1.1, -radius * 0.32, 0,
    radius * 1.55, 0, 0,
  ], 3));
  return geometry;
}

function createMarker(radius: number): UnitMarker {
  const group = new Group();
  group.position.z = MARKER_LIFT;
  const marker: UnitMarker = {
    group,
    ring: markerMesh(new RingGeometry(radius * 0.86, radius, 48), '#94a3b8'),
    pointer: markerMesh(pointerGeometry(radius), '#94a3b8'),
    combat: markerMesh(new RingGeometry(radius * 1.0, radius * 1.08, 48), COMBAT_COLOR),
    selected: markerMesh(new RingGeometry(radius * 1.14, radius * 1.22, 48), SELECTED_COLOR),
    health: markerMesh(new RingGeometry(radius * 0.7, radius * 0.8, 48), healthColor(1)),
    radius,
    healthShown: null,
  };
  marker.health.visible = false;
  group.add(marker.ring, marker.pointer, marker.combat, marker.selected, marker.health);
  return marker;
}

function updateMarker(marker: UnitMarker, style: UnitMarkerStyle, alive: boolean): void {
  marker.group.visible = !style.hidden;
  marker.ring.material.color.set(style.color);
  marker.pointer.material.color.set(style.color);
  // A corpse faces nowhere in particular.
  marker.pointer.visible = alive;
  marker.combat.visible = alive && style.inCombat;
  marker.selected.visible = style.selected;
  const health = alive && style.healthPct !== null && style.healthPct < 100 ? Math.max(0, Math.round(style.healthPct)) : null;
  if (health === marker.healthShown) return;
  marker.healthShown = health;
  marker.health.visible = health !== null;
  if (health === null) return;
  marker.health.geometry.dispose();
  // Fills anticlockwise from the pointer, like a clock hand.
  marker.health.geometry = new RingGeometry(marker.radius * 0.7, marker.radius * 0.8, 48, 1, 0, Math.PI * 2 * (health / 100));
  marker.health.material.color.set(healthColor(health / 100));
}

function disposeMarker(marker: UnitMarker): void {
  for (const mesh of [marker.ring, marker.pointer, marker.combat, marker.selected, marker.health]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

// Players and creatures as animated client models, placed in server
// coordinates under a Z-up group like the scene's.
export class UnitModelLayer {
  readonly group = new Group();
  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, ModelTemplate>();
  private readonly units = new Map<string, UnitInstance>();
  private readonly materials = new Map<string, Material>();
  private lastUpdateAt = 0;

  constructor(private readonly onLoaded: () => void) {
    // Server (x, y, z) Z-up becomes (x, z, -y) Y-up, as for the scene.
    this.group.rotation.x = -Math.PI / 2;
  }

  get count(): number {
    return this.group.children.length;
  }

  // An effect point on a drawn unit, in server coordinates, or null if the
  // unit isn't drawn as a model or its model has no such point.
  pointOf(id: string, role: UnitPointRole): Point3 | null {
    const point = this.units.get(id)?.points.get(role);
    if (!point) return null;
    const position = this.group.worldToLocal(point.getWorldPosition(new Vector3()));
    return [position.x, position.y, position.z];
  }

  // Which way a drawn unit faces (radians about Z), or null.
  orientationOf(id: string): number | null {
    return this.units.get(id)?.root.rotation.z ?? null;
  }

  // A drawn unit's overall scale (its display's times its own), or null.
  scaleOf(id: string): number | null {
    const unit = this.units.get(id);
    if (!unit) return null;
    return unit.root.scale.x * (unit.template.scene?.children[0]?.scale.x ?? 1);
  }

  // A drawn unit's standing height in yards, or null.
  heightOf(id: string): number | null {
    const unit = this.units.get(id);
    return unit?.template.height ? unit.template.height * unit.root.scale.x : null;
  }

  // Places and animates the given units; returns the IDs drawn as models.
  // Units whose model is still loading, or has none, are left to markers.
  update(poses: UnitModelPose[], nowMs: number): Set<string> {
    const step = this.lastUpdateAt ? Math.min(MAX_STEP_SECONDS, Math.max(0, (nowMs - this.lastUpdateAt) / 1000)) : 0;
    this.lastUpdateAt = nowMs;
    const shown = new Set<string>();
    for (const pose of poses) {
      const template = this.template(pose.url);
      if (template.state !== 'ready') continue;
      let unit = this.units.get(pose.id);
      if (unit && unit.url !== pose.url) {
        this.remove(pose.id);
        unit = undefined;
      }
      if (!unit) unit = this.create(pose, template, nowMs);
      this.place(unit, pose, nowMs, step);
      shown.add(pose.id);
    }
    for (const id of [...this.units.keys()]) if (!shown.has(id)) this.remove(id);
    this.group.updateMatrixWorld(true);
    return shown;
  }

  private template(url: string): ModelTemplate {
    let template = this.templates.get(url);
    if (template) return template;
    template = { state: 'loading' };
    this.templates.set(url, template);
    const loading = template;
    this.loader.load(url, (gltf) => {
      const footprint = new Box3();
      gltf.scene.traverse((object) => {
        if (object instanceof Mesh) {
          object.material = this.convertMaterial(object.material as MeshStandardMaterial);
          object.frustumCulled = false;
          object.renderOrder = MODEL_RENDER_ORDER;
        }
        // The body only: weapons and shoulders would widen the ring.
        if (object instanceof SkinnedMesh) {
          object.geometry.computeBoundingBox();
          footprint.union(object.geometry.boundingBox!);
        }
      });
      const root = gltf.scene.children[0];
      loading.radius = footprint.isEmpty()
        ? MARKER_MIN_RADIUS
        : getMarkerRadius(footprint.max.x - footprint.min.x, footprint.max.y - footprint.min.y, root?.scale.x ?? 1);
      loading.height = footprint.isEmpty() ? undefined : footprint.max.z * (root?.scale.x ?? 1);
      const durations = (root?.userData.wowClipDurations ?? {}) as Record<string, number>;
      loading.clips = new Map(gltf.animations.map((clip) => {
        if (durations[clip.name]) clip.duration = durations[clip.name];
        return [clip.name, clip];
      }));
      loading.speeds = (root?.userData.wowClipSpeeds ?? {}) as Record<string, number>;
      loading.scene = gltf.scene;
      loading.state = 'ready';
      this.onLoaded();
    }, undefined, () => {
      loading.state = 'failed';
    });
    return template;
  }

  private create(pose: UnitModelPose, template: ModelTemplate, nowMs: number): UnitInstance {
    const model = cloneSkinned(template.scene!);
    const root = new Group();
    const marker = createMarker(template.radius ?? MARKER_MIN_RADIUS);
    root.add(marker.group, model);
    this.group.add(root);
    const jitter = Math.random();
    const unit: UnitInstance = {
      url: pose.url,
      root,
      mixer: new AnimationMixer(model),
      template,
      loop: null,
      loopName: null,
      strike: null,
      stance: null,
      nextStrikeAt: nowMs + jitter * 1500,
      jitter,
      lastX: pose.x,
      lastY: pose.y,
      lastAt: nowMs,
      speed: 0,
      seenAlive: pose.alive,
      sheathState: null,
      sheathItems: [],
      marker,
      model,
      points: new Map(),
      tint: null,
      tinted: new Map(),
    };
    model.traverse((object) => {
      if (object.userData.wowSheath) unit.sheathItems.push(object);
      if (object.userData.wowPoint) unit.points.set(object.userData.wowPoint as string, object);
    });
    this.units.set(pose.id, unit);
    return unit;
  }

  private remove(id: string): void {
    const unit = this.units.get(id);
    if (!unit) return;
    unit.mixer.stopAllAction();
    this.setTint(unit, null);
    disposeMarker(unit.marker);
    this.group.remove(unit.root);
    this.units.delete(id);
  }

  private place(unit: UnitInstance, pose: UnitModelPose, nowMs: number, step: number): void {
    unit.root.position.set(pose.x, pose.y, pose.z);
    unit.root.rotation.z = pose.orientation;
    unit.root.scale.setScalar(pose.scale || 1);

    const elapsed = (nowMs - unit.lastAt) / 1000;
    if (elapsed > 0.05) {
      const instant = Math.hypot(pose.x - unit.lastX, pose.y - unit.lastY) / elapsed;
      // A jump (teleport, first sample after a gap) is not movement.
      unit.speed = instant > 60 ? 0 : unit.speed + (instant - unit.speed) * Math.min(1, SPEED_SMOOTHING * elapsed * 30);
      unit.lastX = pose.x;
      unit.lastY = pose.y;
      unit.lastAt = nowMs;
    }
    if (pose.alive) unit.seenAlive = true;
    updateMarker(unit.marker, pose.marker, pose.alive);
    this.setTint(unit, pose.tint ?? null);
    if (unit.sheathState !== pose.sheathState) {
      unit.sheathState = pose.sheathState;
      for (const item of unit.sheathItems) item.visible = isItemShown(item.userData.wowItem, item.userData.wowSheath, pose.sheathState);
    }

    const clips = unit.template.clips!;
    const stance = chooseUnitStance({ alive: pose.alive, speed: unit.speed, inCombat: pose.inCombat, style: pose.style });
    const chosen = getStanceClips(stance, pose.weapons, new Set(clips.keys()));
    // Standing or fighting, a cast or channel holds the pose its kit names.
    const still = stance !== 'walk' && stance !== 'run' && stance !== 'dead';
    const kitLoop = still && pose.kitLoop && clips.has(pose.kitLoop) ? pose.kitLoop : null;
    if (kitLoop) chosen.loop = kitLoop;
    if (stance !== unit.stance || chosen.loop !== unit.loopName) {
      unit.stance = stance;
      this.playLoop(unit, chosen.loop, Boolean(chosen.holdLastFrame), pose.alive || unit.seenAlive);
    }
    if (unit.loop && (stance === 'walk' || stance === 'run') && unit.loopName) {
      unit.loop.timeScale = getMoveTimeScale(unit.speed, unit.template.speeds?.[unit.loopName]);
    }
    const fighting = stance === 'melee' || stance === 'ranged' || stance === 'cast';
    if (still && pose.kitOnce && clips.has(pose.kitOnce)) {
      this.playStrike(unit, pose.kitOnce);
    } else if (pose.strike && (fighting || stance === 'stand')) {
      // A real attack: the clip for what was done, whatever the stance.
      const strike = getStanceClips(pose.strike, pose.weapons, new Set(clips.keys())).strike;
      if (strike) this.playStrike(unit, strike);
    } else if (!pose.eventDriven && !kitLoop && chosen.strike && fighting && nowMs >= unit.nextStrikeAt) {
      unit.nextStrikeAt = nowMs + getStrikeInterval(stance, unit.jitter) * 1000;
      unit.jitter = Math.random();
      this.playStrike(unit, chosen.strike);
    }
    unit.mixer.update(step);
    this.finishStrike(unit);
  }

  private playLoop(unit: UnitInstance, name: string | null, holdLastFrame: boolean, animateDeath: boolean): void {
    const previous = unit.loop;
    unit.loopName = name;
    unit.strike?.fadeOut(CROSSFADE_SECONDS);
    unit.strike = null;
    const clip = name ? unit.template.clips!.get(name) : undefined;
    if (!clip) {
      previous?.fadeOut(CROSSFADE_SECONDS);
      unit.loop = null;
      return;
    }
    const action = unit.mixer.clipAction(clip);
    action.reset();
    action.timeScale = 1;
    if (holdLastFrame) {
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      // Already dead when first seen: lie still rather than replay the fall.
      if (!animateDeath) action.time = clip.duration;
    } else {
      action.setLoop(LoopRepeat, Infinity);
    }
    action.play();
    if (previous && previous !== action) action.crossFadeFrom(previous, CROSSFADE_SECONDS, false);
    unit.loop = action;
  }

  private playStrike(unit: UnitInstance, name: string): void {
    const clip = unit.template.clips!.get(name);
    if (!clip || !unit.loop) return;
    const strike = unit.mixer.clipAction(clip);
    if (unit.strike && unit.strike !== strike) unit.strike.fadeOut(CROSSFADE_SECONDS);
    strike.reset();
    strike.setLoop(LoopOnce, 1);
    strike.clampWhenFinished = false;
    strike.play();
    strike.crossFadeFrom(unit.loop, CROSSFADE_SECONDS, false);
    unit.strike = strike;
  }

  // Blends a finished strike back into the ready pose.
  private finishStrike(unit: UnitInstance): void {
    const strike = unit.strike;
    if (!strike || !unit.loop || strike.time < strike.getClip().duration - CROSSFADE_SECONDS) return;
    unit.loop.reset().play();
    unit.loop.crossFadeFrom(strike, CROSSFADE_SECONDS, false);
    unit.strike = null;
  }

  // Swaps the unit's materials for glowing copies, or back to the shared ones.
  private setTint(unit: UnitInstance, color: string | null): void {
    if (unit.tint === color) return;
    unit.tint = color;
    if (!color) {
      for (const [mesh, original] of unit.tinted) {
        for (const copy of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) copy.dispose();
        mesh.material = original;
      }
      unit.tinted.clear();
      return;
    }
    unit.model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (!unit.tinted.has(object)) {
        unit.tinted.set(object, object.material);
        object.material = Array.isArray(object.material)
          ? object.material.map((material: Material) => material.clone())
          : (object.material as Material).clone();
      }
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshLambertMaterial) material.emissive.set(color).multiplyScalar(TINT_STRENGTH);
      }
    });
  }

  // Lit, so models keep their shape; the scene itself is unlit.
  private convertMaterial(source: MeshStandardMaterial): Material {
    const cached = this.materials.get(source.uuid);
    if (cached) return cached;
    const blend = (source.userData.wowBlend ?? 'opaque') as string;
    const material = new MeshLambertMaterial({
      name: source.name,
      map: source.map ?? null,
      color: source.color.clone(),
      opacity: source.opacity,
      side: source.side === DoubleSide ? DoubleSide : FrontSide,
      alphaTest: blend === 'alphaKey' ? 0.5 : 0,
      transparent: (blend !== 'opaque' && blend !== 'alphaKey') || source.opacity < 1,
      depthWrite: (blend === 'opaque' || blend === 'alphaKey') && source.opacity >= 1,
      blending: blend === 'add' ? AdditiveBlending : NormalBlending,
    });
    this.materials.set(source.uuid, material);
    return material;
  }
}

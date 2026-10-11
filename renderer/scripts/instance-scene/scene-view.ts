import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  type BufferGeometry,
  Color,
  type DataArrayTexture,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  Scene,
  Sphere,
  SRGBColorSpace,
  type Texture,
  Vector3,
  WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { type FadeSettings, type FadeVolume, type IsoView, MAX_FADE_VOLUMES } from '../utils/map-projection';
import type { CombatEffectStore, Point3, UnitKey } from '../utils/spell-events';
import { applyIsoCamera } from './iso-camera';
import { SpellEffectLayer, type UnitAnchorRole } from './spell-effects';
import { buildLayerArray, BYTE_SHADING_SCALE, createTerrainMaterial, prepareAlphaAtlas } from './terrain-material';
import { SpellVisualLayer, type UnitInfo } from './spell-visual-layer';
import { type UnitModelPose, UnitModelLayer } from './unit-models';

type WowBlend = 'opaque' | 'alphaKey' | 'alpha' | 'add' | 'mod' | 'mod2x';

interface TerrainTextures {
  layers: DataArrayTexture;
  alphas: Map<string, Texture>;
}

interface LiquidExtras {
  id: number;
  kind: 'water' | 'ocean' | 'magma' | 'slime';
  frames: string[];
  // Water and ocean: the map's colour for them (sRGB, 0-1).
  color?: [number, number, number];
}

// Liquid textures animate at this many frames a second; water is see-through.
const LIQUID_FPS = 15;
const WATER_OPACITY = 0.7;
// Water without a colour from its map: a dull blue-green.
const WATER_COLOR: [number, number, number] = [0.2, 0.3, 0.3];
// Water textures are dark ripples, mostly alpha: laid over the water's colour.
const WATER_FRAGMENT = `
#ifdef USE_MAP
  vec4 ripples = texture2D(map, vMapUv);
  diffuseColor.rgb = mix(diffuseColor.rgb, ripples.rgb, ripples.a);
#endif
`;

// WMO interiors carry baked lighting in their vertex colours, which the client
// brightens; props have no baked light and are drawn slightly dimmed to sit in
// the same range. Tuned by eye against Azjol-Nerub.
const VERTEX_LIT_BRIGHTNESS = 2;
const UNLIT_BRIGHTNESS = 0.75;
const BACKGROUND = 0x08111d;
// Untextured ground until terrain textures are drawn.
const TERRAIN_COLOR = 0x4a5a3c;
// Effect heights on units drawn without a model, or whose model lacks the
// point, as fractions of a standing height (yards).
const DEFAULT_UNIT_HEIGHT = 2;
const CHEST_HEIGHT = 0.6;
const HEAD_HEIGHT = 0.9;

// Party fade, matching getSceneFade() in map-projection.ts: each volume keeps
// its surroundings solid, fading out over the height range above and below and
// (when on) over the outer half of the horizontal reach. Faded geometry is
// dithered with a 4x4 ordered pattern rather than alpha-blended, so solid
// walls keep writing depth and need no back-to-front sorting. Positions are in
// server coordinates; three.js is Y-up, so server (x, y, z) is (x, -z, y) here.
const FADE_VERTEX_DECLARATIONS = 'varying vec3 vWowPosition;\n';
const FADE_VERTEX = `
vec4 wowWorld = modelMatrix * vec4(transformed, 1.0);
vWowPosition = vec3(wowWorld.x, -wowWorld.z, wowWorld.y);
`;
const FADE_FRAGMENT_DECLARATIONS = `
#define WOW_MAX_VOLUMES ${MAX_FADE_VOLUMES}
uniform vec3 wowVolumeMin[WOW_MAX_VOLUMES];
uniform vec3 wowVolumeMax[WOW_MAX_VOLUMES];
uniform int wowVolumeCount;
uniform float wowHeightRange;
uniform float wowHorizontalRange;
varying vec3 vWowPosition;
float wowBayer4(vec2 position) {
  const float pattern[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  ivec2 cell = ivec2(mod(position, 4.0));
  return (pattern[cell.x + cell.y * 4] + 0.5) / 16.0;
}
float wowVolumeFade(int index) {
  vec3 outside = max(max(wowVolumeMin[index] - vWowPosition, vWowPosition - wowVolumeMax[index]), 0.0);
  float vertical = clamp(1.0 - outside.z / wowHeightRange, 0.0, 1.0);
  if (wowHorizontalRange <= 0.0) return vertical;
  float core = wowHorizontalRange * 0.5;
  return vertical * (1.0 - clamp((length(outside.xy) - core) / (wowHorizontalRange - core), 0.0, 1.0));
}
`;
const FADE_FRAGMENT = `
float wowFade = wowVolumeCount == 0 ? 1.0 : 0.0;
for (int index = 0; index < WOW_MAX_VOLUMES; index++) {
  if (index >= wowVolumeCount) break;
  wowFade = max(wowFade, wowVolumeFade(index));
}
if (wowFade <= 0.0 || wowFade < wowBayer4(gl_FragCoord.xy)) discard;
`;

// Building batches share one vertex buffer per WMO group, so three.js would
// size every batch's bounds to the whole group. Fit them to the vertices the
// batch's triangles actually use, so fade and frustum culling can skip it.
function fitBoundsToIndices(geometry: BufferGeometry, fitted: WeakSet<BufferGeometry>): void {
  if (fitted.has(geometry)) return;
  fitted.add(geometry);
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  if (!index || !position) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return;
  }
  const box = new Box3();
  const vertex = new Vector3();
  for (let item = 0; item < index.count; item += 1) box.expandByPoint(vertex.fromBufferAttribute(position, index.getX(item)));
  geometry.boundingBox = box;
  geometry.boundingSphere = box.getBoundingSphere(new Sphere());
}

interface MeshBounds {
  mesh: Mesh;
  // Server coordinates.
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export type SceneLoadState = 'loading' | 'ready' | 'failed';

// Draws an exported instance scene with an orthographic camera that matches
// the overlay's IsoView projection. Renders only when asked.
export class InstanceSceneView {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  // Shared by every scene material.
  private readonly fadeUniforms = {
    wowVolumeMin: { value: Array.from({ length: MAX_FADE_VOLUMES }, () => new Vector3()) },
    wowVolumeMax: { value: Array.from({ length: MAX_FADE_VOLUMES }, () => new Vector3()) },
    wowVolumeCount: { value: 0 },
    wowHeightRange: { value: 1 },
    wowHorizontalRange: { value: 0 },
  };
  private readonly loader = new GLTFLoader();
  private readonly roots = new Map<string, Object3D>();
  // World bounds of each mesh, so wholly faded meshes are not drawn.
  private readonly meshBounds = new Map<Object3D, MeshBounds[]>();
  private readonly states = new Map<string, SceneLoadState>();
  private readonly materials = new Map<string, Material>();
  private shown: Object3D | null = null;
  private lost = false;
  // Player and creature models; lit, unlike the scene.
  private readonly units: UnitModelLayer;
  // Spell effects, drawn over everything.
  private readonly effects = new SpellEffectLayer();
  // The client's own spell art, where a spell has it.
  private readonly spellVisuals: SpellVisualLayer;
  private effectsShown = false;
  // Liquid materials and their animation frames, by scene URL.
  private readonly liquids = new Map<string, Array<{ material: MeshBasicMaterial; frames: Texture[] }>>();
  // What the canvas currently shows, to skip redrawing an unchanged frame.
  private lastFrameKey = '';

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onChange: () => void) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(BACKGROUND);
    this.units = new UnitModelLayer(() => {
      this.lastFrameKey = '';
      this.onChange();
    });
    this.scene.add(this.units.group);
    this.scene.add(this.effects.group);
    this.spellVisuals = new SpellVisualLayer(() => {
      this.lastFrameKey = '';
      this.onChange();
    });
    this.scene.add(this.spellVisuals.group);
    this.scene.add(new AmbientLight(0xffffff, 2.2));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(sun);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      this.lastFrameKey = '';
      this.onChange();
    });
  }

  static isSupported(): boolean {
    try {
      return Boolean(document.createElement('canvas').getContext('webgl2'));
    } catch {
      return false;
    }
  }

  get available(): boolean {
    return !this.lost;
  }

  // Places the unit models for the next render; returns the IDs drawn as
  // models (the rest still need markers).
  setUnits(poses: UnitModelPose[], nowMs: number): Set<string> {
    if (this.lost) return new Set();
    // Animations the spells' kits ask for (from the last frame's effects).
    const animations = this.spellVisuals.takeAnimations();
    return this.units.update(animations.size ? poses.map((pose) => {
      const animation = animations.get(pose.id);
      return animation ? { ...pose, kitLoop: animation.loop, kitOnce: animation.once } : pose;
    }) : poses, nowMs);
  }

  // Where an effect sits on a unit, in server coordinates: the model's own
  // point when it has one, otherwise a height up from its feet. `positions`
  // holds the units shown (feet, server coordinates).
  anchor(positions: ReadonlyMap<UnitKey, Point3>, unit: UnitKey, role: UnitAnchorRole): Point3 | null {
    const feet = positions.get(unit);
    if (!feet) return null;
    if (role === 'feet') return feet;
    const point = this.units.pointOf(unit, role);
    if (point) return point;
    const height = this.units.heightOf(unit) ?? DEFAULT_UNIT_HEIGHT;
    const up = role === 'overhead' ? height + 0.3 : role === 'head' || role === 'breath' ? height * HEAD_HEIGHT : height * CHEST_HEIGHT;
    return [feet[0], feet[1], feet[2] + up];
  }

  // Places the store's live effects for the next render; call after
  // setUnits, so hand points follow this frame's animation.
  setEffects(store: CombatEffectStore | null, positions: ReadonlyMap<UnitKey, Point3>, now: number,
    auras?: ReadonlyMap<UnitKey, readonly number[]>): number {
    if (this.lost) return 0;
    const before = this.effects.count + this.spellVisuals.count;
    const anchor = (unit: UnitKey, role: UnitAnchorRole) => this.anchor(positions, unit, role);
    const units: UnitInfo = {
      anchor,
      scale: (unit) => this.units.scaleOf(unit) ?? 1,
      facing: (unit) => this.units.orientationOf(unit) ?? 0,
    };
    this.spellVisuals.update(store, now, units, this.camera, auras);
    this.effects.update(store, now, anchor, (entry) => this.spellVisuals.handles(entry));
    const count = this.effects.count + this.spellVisuals.count;
    // One more frame after the last effect ends, to clear it.
    this.effectsShown = count > 0 || before > 0;
    return count;
  }

  // Whether an aura's spell shows the client's art (so its tint gives way).
  hasAuraArt(spellId: number): boolean {
    return this.spellVisuals.hasAuraArt(spellId);
  }

  // The client's spell art playing, and its live particles, for ?debug.
  get spellArt(): { effects: number; particles: number } {
    return { effects: this.spellVisuals.count, particles: this.spellVisuals.particles };
  }

  state(url: string): SceneLoadState | undefined {
    return this.states.get(url);
  }

  load(url: string): void {
    if (this.states.has(url)) return;
    this.states.set(url, 'loading');
    this.loader.load(url, async (gltf) => {
      const root = gltf.scene;
      const terrain = await this.terrainTextures(gltf);
      const frames = await this.liquidFrames(gltf);
      const liquids: Array<{ material: MeshBasicMaterial; frames: Texture[] }> = [];
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const liquid = (object.material as Material).userData?.wowLiquid as LiquidExtras | undefined;
        if (liquid) {
          const material = this.liquidMaterial(liquid, frames);
          if (material) {
            object.material = material.material;
            object.renderOrder = 1;
            liquids.push(material);
            return;
          }
        }
        object.material = this.convertMaterial(object, terrain);
      });
      if (liquids.length) this.liquids.set(url, liquids);
      root.updateMatrixWorld(true);
      const bounds: MeshBounds[] = [];
      const fitted = new WeakSet<BufferGeometry>();
      root.traverse((object) => {
        object.matrixAutoUpdate = false;
        if (!(object instanceof Mesh)) return;
        fitBoundsToIndices(object.geometry, fitted);
        const box = new Box3().copy(object.geometry.boundingBox!).applyMatrix4(object.matrixWorld);
        bounds.push({
          mesh: object,
          minX: box.min.x, maxX: box.max.x,
          minY: -box.max.z, maxY: -box.min.z,
          minZ: box.min.y, maxZ: box.max.y,
        });
      });
      this.meshBounds.set(root, bounds);
      this.roots.set(url, root);
      this.states.set(url, 'ready');
      this.onChange();
    }, undefined, (error) => {
      console.warn(`Could not load instance scene ${url}`, error);
      this.states.set(url, 'failed');
      this.onChange();
    });
  }

  // Geometry stays solid around the fade volumes (the party) and fades out
  // beyond them per `fade`. With no volumes everything is drawn solid.
  render(
    url: string,
    view: IsoView,
    width: number,
    height: number,
    volumes: FadeVolume[],
    fade: FadeSettings,
  ): boolean {
    const root = this.roots.get(url);
    if (!root || this.lost) return false;
    const active = volumes.slice(0, MAX_FADE_VOLUMES);
    // Live positions redraw the overlay up to 30 times a second; the scene only
    // changes when the camera moves or the fade shifts by about a yard.
    const frameKey = [
      url, width, height, view.pixelsPerUnit.toFixed(4),
      ...view.center.map((value) => value.toFixed(3)),
      ...view.basis.toCamera.map((value) => value.toFixed(5)),
      fade.height, fade.horizontal ?? 0,
      ...active.flatMap((volume) => [volume.minX, volume.maxX, volume.minY, volume.maxY, volume.minZ, volume.maxZ]
        .map((value) => Math.round(value))),
    ].join('|');
    // Animated models, live effects, and liquids need every frame.
    const liquids = this.liquids.get(url);
    if (frameKey === this.lastFrameKey && !this.units.count && !this.effectsShown && !liquids?.length) return true;
    if (liquids) {
      for (const liquid of liquids) {
        liquid.material.map = liquid.frames[Math.floor(performance.now() / (1000 / LIQUID_FPS)) % liquid.frames.length];
      }
    }
    this.lastFrameKey = frameKey;
    if (this.shown !== root) {
      if (this.shown) this.scene.remove(this.shown);
      this.scene.add(root);
      this.shown = root;
    }
    active.forEach((volume, index) => {
      this.fadeUniforms.wowVolumeMin.value[index].set(volume.minX, volume.minY, volume.minZ);
      this.fadeUniforms.wowVolumeMax.value[index].set(volume.maxX, volume.maxY, volume.maxZ);
    });
    this.fadeUniforms.wowVolumeCount.value = active.length;
    this.fadeUniforms.wowHeightRange.value = fade.height;
    this.fadeUniforms.wowHorizontalRange.value = fade.horizontal ?? 0;
    const reach = fade.horizontal ?? Infinity;
    for (const bounds of this.meshBounds.get(root) ?? []) {
      bounds.mesh.visible = !active.length || active.some((volume) =>
        bounds.maxZ > volume.minZ - fade.height && bounds.minZ < volume.maxZ + fade.height
        && bounds.maxX > volume.minX - reach && bounds.minX < volume.maxX + reach
        && bounds.maxY > volume.minY - reach && bounds.minY < volume.maxY + reach);
    }
    this.renderer.setSize(width, height, false);
    applyIsoCamera(this.camera, view, width, height);
    this.renderer.render(this.scene, this.camera);
    // Exposed for diagnosing slow scenes from the browser's developer tools.
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
    return true;
  }

  // One function for every material, so three.js shares the compiled program.
  private readonly injectPartyFade = (shader: WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, this.fadeUniforms);
    shader.vertexShader = FADE_VERTEX_DECLARATIONS + shader.vertexShader
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FADE_VERTEX}`);
    shader.fragmentShader = FADE_FRAGMENT_DECLARATIONS + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE_FRAGMENT}`);
  };

  // Every texture in the scene by its material's name, for liquid frames.
  private async liquidFrames(gltf: GLTF): Promise<Map<string, Texture>> {
    const frames = new Map<string, Texture>();
    const materials = (await gltf.parser.getDependencies('material')) as MeshStandardMaterial[];
    for (const material of materials) {
      if (/^liquid-frame-\d+$/.test(material.name) && material.map) frames.set(material.name, material.map);
    }
    return frames;
  }

  // A liquid's material: its first frame, unlit; water and ocean see-through
  // in their map's colour, magma and slime solid (they glow).
  private liquidMaterial(liquid: LiquidExtras, frames: Map<string, Texture>):
    { material: MeshBasicMaterial; frames: Texture[] } | null {
    const textures = liquid.frames.map((name) => frames.get(name)).filter((texture): texture is Texture => Boolean(texture));
    if (!textures.length) return null;
    const see = liquid.kind === 'water' || liquid.kind === 'ocean';
    const material = new MeshBasicMaterial({
      map: textures[0], side: DoubleSide, transparent: see, opacity: see ? WATER_OPACITY : 1, depthWrite: !see,
    });
    if (see) {
      material.color.setRGB(...(liquid.color ?? WATER_COLOR), SRGBColorSpace);
      material.onBeforeCompile = (shader) => {
        this.injectPartyFade(shader);
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', WATER_FRAGMENT);
      };
      material.customProgramCacheKey = () => 'wow-water';
    } else {
      material.onBeforeCompile = this.injectPartyFade;
    }
    return { material, frames: textures };
  }

  // The map's ground textures as one array, and each tile's alpha atlas by
  // name; null for a scene without terrain.
  private async terrainTextures(gltf: GLTF): Promise<TerrainTextures | null> {
    const names = gltf.scene.children[0]?.userData.wowTerrainLayers as string[] | undefined;
    if (!names?.length) return null;
    const materials = (await gltf.parser.getDependencies('material')) as MeshStandardMaterial[];
    const byName = new Map(materials.map((material) => [material.name, material]));
    const layers = buildLayerArray(names.map((name) => (byName.get(name)?.map?.image as CanvasImageSource | undefined) ?? null));
    const alphas = new Map<string, Texture>();
    for (const material of materials) {
      if (material.name.startsWith('terrain-alpha-') && material.map) alphas.set(material.name, prepareAlphaAtlas(material.map));
    }
    return { layers, alphas };
  }

  private convertMaterial(mesh: Mesh, terrain: TerrainTextures | null = null): Material | Material[] {
    const vertexLit = Boolean(mesh.geometry.getAttribute('color'));
    const convert = (source: Material): Material => {
      // Terrain: its texture layers blended through its alpha atlas, lit by
      // the scene's lights (it has no baked lighting), with its vertex
      // shading as colour. Plain ground if its textures are missing.
      if (source.userData.wowTerrain) {
        const alpha = terrain?.alphas.get(source.userData.alpha as string);
        const shadingScale = mesh.geometry.getAttribute('color')?.normalized ? BYTE_SHADING_SCALE : 1;
        if (!terrain || !alpha) {
          const plain = new MeshLambertMaterial({
            color: new Color(TERRAIN_COLOR).multiplyScalar(vertexLit ? shadingScale : 1), vertexColors: vertexLit,
          });
          plain.onBeforeCompile = this.injectPartyFade;
          return plain;
        }
        return createTerrainMaterial({
          layers: terrain.layers, alpha, origin: source.userData.origin as [number, number],
          vertexShaded: vertexLit, shadingScale, partyFade: this.injectPartyFade,
        });
      }
      const key = `${source.uuid}|${vertexLit}`;
      const cached = this.materials.get(key);
      if (cached) return cached;
      const standard = source as MeshStandardMaterial;
      const blend = (source.userData.wowBlend ?? 'opaque') as WowBlend;
      const material = new MeshBasicMaterial({
        name: source.name,
        map: standard.map ?? null,
        color: (standard.color ?? new Color(1, 1, 1)).clone()
          .multiplyScalar(vertexLit ? VERTEX_LIT_BRIGHTNESS : UNLIT_BRIGHTNESS),
        opacity: source.opacity,
        vertexColors: vertexLit,
        side: source.side === DoubleSide ? DoubleSide : FrontSide,
        alphaTest: blend === 'alphaKey' ? 0.5 : 0,
        transparent: (blend !== 'opaque' && blend !== 'alphaKey') || source.opacity < 1,
        depthWrite: (blend === 'opaque' || blend === 'alphaKey') && source.opacity >= 1,
        blending: blend === 'add' ? AdditiveBlending : blend === 'mod' || blend === 'mod2x' ? MultiplyBlending : NormalBlending,
        premultipliedAlpha: blend === 'mod' || blend === 'mod2x',
      });
      material.onBeforeCompile = this.injectPartyFade;
      this.materials.set(key, material);
      return material;
    };
    return Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  }
}

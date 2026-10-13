import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three';

import type { Point3 } from '../utils/spell-events';
import type { SpellChain } from '../utils/spell-kits';
import type { EffectView } from './m2-effect';

// Draws spells' chains (SpellChainEffects: Chain Heal, Chain Lightning) as
// textured ribbons between units, in the spell layer's server coordinates:
// each turned edge-on to the camera, its texture flowing from the start of
// the link to its end.

export interface ChainDraw {
  chain: SpellChain;
  from: Point3;
  to: Point3;
  // 0 to 1, for fading in and out.
  opacity: number;
  // Seconds since the link appeared, for the flow.
  age: number;
}

// The ribbons are a little wider than the data says, so they read at the
// isometric view's zoom.
export const CHAIN_WIDTH_SCALE = 2.5;
const SEGMENTS = 12;
// Texture lengths a second the texture moves along the link.
const FLOW_RATE = 1.5;
const RENDER_ORDER = 4;
const MAX_RIBBONS = 48;

type Ribbon = Mesh<BufferGeometry, MeshBasicMaterial>;

function createRibbon(): Ribbon {
  const geometry = new BufferGeometry();
  const vertices = (SEGMENTS + 1) * 2;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(vertices * 2), 2));
  const index: number[] = [];
  for (let segment = 0; segment < SEGMENTS; segment += 1) {
    const at = segment * 2;
    index.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
  }
  geometry.setIndex(index);
  const material = new MeshBasicMaterial({
    blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
  });
  const ribbon = new Mesh(geometry, material);
  ribbon.renderOrder = RENDER_ORDER;
  ribbon.frustumCulled = false;
  return ribbon;
}

export class ChainRibbons {
  readonly group = new Group();
  private readonly ribbons: Ribbon[] = [];
  private readonly textures = new Map<number, Texture | null>();
  private readonly loader = new TextureLoader();
  private used = 0;

  constructor(private readonly onLoaded: () => void) {}

  get count(): number {
    return this.used;
  }

  // Draws this frame's links; the rest are hidden. Links whose texture is
  // still loading are left out.
  update(draws: ChainDraw[], view: EffectView): void {
    this.used = 0;
    for (const draw of draws.slice(0, MAX_RIBBONS)) {
      const texture = this.texture(draw.chain.id);
      if (!texture) continue;
      this.place(this.ribbon(), draw, texture, view);
    }
    for (let index = this.used; index < this.ribbons.length; index += 1) this.ribbons[index].visible = false;
  }

  private ribbon(): Ribbon {
    let ribbon = this.ribbons[this.used];
    if (!ribbon) {
      ribbon = createRibbon();
      this.ribbons.push(ribbon);
      this.group.add(ribbon);
    }
    this.used += 1;
    return ribbon;
  }

  private texture(chainId: number): Texture | null {
    if (this.textures.has(chainId)) return this.textures.get(chainId) ?? null;
    this.textures.set(chainId, null);
    this.loader.load(`assets/models/icon/chain-${chainId}.png`, (texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      this.textures.set(chainId, texture);
      this.onLoaded();
    });
    return null;
  }

  // A flat strip from `from` to `to`, its width across the line of sight.
  private place(ribbon: Ribbon, { chain, from, to, opacity, age }: ChainDraw, texture: Texture, view: EffectView): void {
    const along: Point3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = Math.hypot(...along);
    const [cx, cy, cz] = view.toCamera;
    // across = along × toCamera, so the strip faces the camera.
    let across: Point3 = [along[1] * cz - along[2] * cy, along[2] * cx - along[0] * cz, along[0] * cy - along[1] * cx];
    const acrossLength = Math.hypot(...across);
    across = acrossLength > 1e-6 ? across.map((value) => value / acrossLength) as Point3 : [...view.right];
    const half = (chain.width * CHAIN_WIDTH_SCALE) / 2;
    const repeats = length / Math.max(0.1, chain.textureScale);
    const flow = -age * FLOW_RATE;
    const positions = ribbon.geometry.getAttribute('position') as BufferAttribute;
    const uvs = ribbon.geometry.getAttribute('uv') as BufferAttribute;
    for (let step = 0; step <= SEGMENTS; step += 1) {
      const t = step / SEGMENTS;
      const x = from[0] + along[0] * t;
      const y = from[1] + along[1] * t;
      const z = from[2] + along[2] * t;
      positions.setXYZ(step * 2, x - across[0] * half, y - across[1] * half, z - across[2] * half);
      positions.setXYZ(step * 2 + 1, x + across[0] * half, y + across[1] * half, z + across[2] * half);
      uvs.setXY(step * 2, t * repeats + flow, 0);
      uvs.setXY(step * 2 + 1, t * repeats + flow, 1);
    }
    positions.needsUpdate = true;
    uvs.needsUpdate = true;
    if (ribbon.material.map !== texture) {
      ribbon.material.map = texture;
      ribbon.material.needsUpdate = true;
    }
    ribbon.material.opacity = opacity;
    ribbon.visible = true;
  }
}

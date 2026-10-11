import {
  ClampToEdgeWrapping,
  Color,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshLambertMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';

// The ground's material: each chunk blends up to four texture layers through
// its alpha maps, as the client does (layer 1 as the base, each later layer
// mixed over it by its alpha), darkened by the baked shadow, then shaded by
// the vertex colours (MCCV) and lit. Built by scripts/scene/terrain.mjs and
// export-scene.mjs: per vertex `_layers` (four layer indices into the map's
// texture array, -1 for none) and `_cell` (the chunk's row and column in the
// tile); per tile an alpha atlas (RGB: layers 2-4, A: light).

const TILE_SIZE = 1600 / 3;
const CHUNK_SIZE = TILE_SIZE / 16;
// Ground textures repeat 8 times across a chunk.
const TEXTURE_REPEAT = CHUNK_SIZE / 8;
const LAYER_TEXTURE_SIZE = 256;
// Under the scene's lights, a plain white diffuse is far too bright; this
// brings the ground to about the client's level. Tuned by eye.
const GROUND_BRIGHTNESS = 0.75;

// Packs the map's ground textures into one texture array (resampled to one
// size), in the order of their layer indices.
export function buildLayerArray(images: Array<CanvasImageSource | null>): DataArrayTexture {
  const size = LAYER_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4 * Math.max(1, images.length));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  images.forEach((image, index) => {
    if (!image) return;
    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);
    data.set(context.getImageData(0, 0, size, size).data, index * size * size * 4);
  });
  const array = new DataArrayTexture(data, size, size, Math.max(1, images.length));
  array.wrapS = RepeatWrapping;
  array.wrapT = RepeatWrapping;
  array.minFilter = LinearMipmapLinearFilter;
  array.magFilter = LinearFilter;
  array.generateMipmaps = true;
  array.colorSpace = SRGBColorSpace;
  array.needsUpdate = true;
  return array;
}

// A tile's alpha atlas holds data, not colour.
export function prepareAlphaAtlas(texture: Texture): Texture {
  texture.colorSpace = NoColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX_DECLARATIONS = `
attribute vec4 _layers;
attribute vec2 _cell;
varying vec4 vWowLayers;
varying vec2 vWowCell;
varying vec2 vWowServer;
`;

const VERTEX = `
vWowLayers = _layers;
vWowCell = _cell;
vWowServer = position.xy;
`;

const FRAGMENT_DECLARATIONS = `
precision highp sampler2DArray;
uniform sampler2DArray wowTerrainLayers;
uniform sampler2D wowTerrainAlpha;
uniform vec2 wowTileOrigin;
varying vec4 vWowLayers;
varying vec2 vWowCell;
varying vec2 vWowServer;
`;

const FRAGMENT = `
{
  vec2 repeatUv = vWowServer / ${TEXTURE_REPEAT.toFixed(6)};
  // Within the tile, in chunks: east (column) and south (row) of its corner.
  vec2 inTile = vec2(wowTileOrigin.y - vWowServer.y, wowTileOrigin.x - vWowServer.x) / ${CHUNK_SIZE.toFixed(6)};
  vec2 cell = vec2(vWowCell.y, vWowCell.x);
  // Stay inside this chunk's 64 x 64 cell, so neighbours never bleed in.
  vec2 inCell = clamp(inTile - cell, 0.5 / 64.0, 63.5 / 64.0);
  vec4 splat = texture2D(wowTerrainAlpha, (cell + inCell) / 16.0);
  vec4 layers = floor(vWowLayers + 0.5);
  vec3 ground = layers.x >= 0.0 ? texture(wowTerrainLayers, vec3(repeatUv, layers.x)).rgb : vec3(0.5);
  if (layers.y >= 0.0) ground = mix(ground, texture(wowTerrainLayers, vec3(repeatUv, layers.y)).rgb, splat.r);
  if (layers.z >= 0.0) ground = mix(ground, texture(wowTerrainLayers, vec3(repeatUv, layers.z)).rgb, splat.g);
  if (layers.w >= 0.0) ground = mix(ground, texture(wowTerrainLayers, vec3(repeatUv, layers.w)).rgb, splat.b);
  diffuseColor.rgb *= ground * splat.a;
}
`;

export function createTerrainMaterial({
  layers,
  alpha,
  origin,
  vertexShaded,
  partyFade,
}: {
  layers: DataArrayTexture;
  alpha: Texture;
  origin: [number, number];
  vertexShaded: boolean;
  partyFade: (shader: WebGLProgramParametersWithUniforms) => void;
}): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color: new Color(GROUND_BRIGHTNESS, GROUND_BRIGHTNESS, GROUND_BRIGHTNESS), vertexColors: vertexShaded });
  const uniforms = {
    wowTerrainLayers: { value: layers },
    wowTerrainAlpha: { value: alpha },
    wowTileOrigin: { value: new Vector2(origin[0], origin[1]) },
  };
  material.onBeforeCompile = (shader) => {
    partyFade(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERTEX_DECLARATIONS + shader.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX}`);
    shader.fragmentShader = FRAGMENT_DECLARATIONS + shader.fragmentShader
      .replace('#include <map_fragment>', FRAGMENT);
  };
  material.customProgramCacheKey = () => 'wow-terrain';
  return material;
}

// Decodes BLP textures to web images, picking the first mip level that fits
// the size cap. Fully opaque textures become JPEG; anything with alpha is PNG.

import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const JPEG_QUALITY = 85;

export function chooseMipLevel(width, height, mipLevelCount, maxSize) {
  let level = 0;
  while (level < mipLevelCount - 1 && Math.max(width >> level, height >> level) > maxSize) level += 1;
  return level;
}

export function hasTransparency(rgba) {
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] < 255) return true;
  }
  return false;
}

export function encodeTexture(blpBuffer, maxSize) {
  const blp = new Blp().load(new Uint8Array(blpBuffer.buffer, blpBuffer.byteOffset, blpBuffer.byteLength));
  const level = chooseMipLevel(blp.width, blp.height, blp.mipLevelCount, maxSize);
  const image = blp.getImage(level, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
  const rgba = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const transparent = blp.alphaSize > 0 && hasTransparency(rgba);
  if (transparent) {
    return {
      mimeType: 'image/png',
      data: PNG.sync.write({ width: image.width, height: image.height, data: rgba }),
      transparent,
    };
  }
  return {
    mimeType: 'image/jpeg',
    data: jpeg.encode({ width: image.width, height: image.height, data: rgba }, JPEG_QUALITY).data,
    transparent,
  };
}

// Decodes a BLP to RGBA at the first mip level no larger than maxSize.
export function decodeBlp(blpBuffer, maxSize = Infinity) {
  const blp = new Blp().load(new Uint8Array(blpBuffer.buffer, blpBuffer.byteOffset, blpBuffer.byteLength));
  const level = chooseMipLevel(blp.width, blp.height, blp.mipLevelCount, maxSize);
  const image = blp.getImage(level, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
  return {
    width: image.width,
    height: image.height,
    rgba: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength).slice(),
  };
}

// Encodes an RGBA image as for encodeTexture: JPEG unless it has transparency.
export function encodeRgba({ width, height, rgba }) {
  const data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (hasTransparency(data)) return { mimeType: 'image/png', data: PNG.sync.write({ width, height, data }), transparent: true };
  return { mimeType: 'image/jpeg', data: jpeg.encode({ width, height, data }, JPEG_QUALITY).data, transparent: false };
}

// Draws `source` over `target` into the given rectangle, scaling with
// bilinear filtering and blending by the source's alpha.
export function drawImage(target, source, x, y, width, height) {
  for (let row = 0; row < height; row += 1) {
    const targetY = y + row;
    if (targetY < 0 || targetY >= target.height) continue;
    const sourceY = Math.min(source.height - 1, Math.max(0, ((row + 0.5) * source.height) / height - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let column = 0; column < width; column += 1) {
      const targetX = x + column;
      if (targetX < 0 || targetX >= target.width) continue;
      const sourceX = Math.min(source.width - 1, Math.max(0, ((column + 0.5) * source.width) / width - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const sample = (channel) => {
        const at = (sx, sy) => source.rgba[(sy * source.width + sx) * 4 + channel];
        return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
      };
      const alpha = sample(3) / 255;
      if (alpha <= 0) continue;
      const index = (targetY * target.width + targetX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        target.rgba[index + channel] = Math.round(sample(channel) * alpha + target.rgba[index + channel] * (1 - alpha));
      }
      target.rgba[index + 3] = Math.round(Math.max(target.rgba[index + 3], alpha * 255));
    }
  }
}

/**
 * Generate a project-screen PNG snapshot with real tile/object sprites.
 */

import sharp from 'sharp';

const MAX_SIDE = 360;
const MAX_CELL = 24;
const MIN_CELL = 2;
const PREVIEW_VERSION = 2;

export { PREVIEW_VERSION };

function tileRgb(type) {
  if (!Number.isFinite(type) || type < 0) return [14, 20, 28, 255];
  const n = (Math.trunc(type) * 2654435761) >>> 0;
  return [40 + (n & 0x7f), 40 + ((n >> 8) & 0x7f), 40 + ((n >> 16) & 0x7f), 255];
}

function fillRect(buf, stride, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * stride + x) * 4;
      buf[i] = rgba[0];
      buf[i + 1] = rgba[1];
      buf[i + 2] = rgba[2];
      buf[i + 3] = rgba[3];
    }
  }
}

function strokeRect(buf, stride, x0, y0, w, h, rgba) {
  for (let x = x0; x < x0 + w; x++) {
    setPx(buf, stride, x, y0, rgba);
    setPx(buf, stride, x, y0 + h - 1, rgba);
  }
  for (let y = y0; y < y0 + h; y++) {
    setPx(buf, stride, x0, y, rgba);
    setPx(buf, stride, x0 + w - 1, y, rgba);
  }
}

function setPx(buf, stride, x, y, rgba) {
  if (x < 0 || y < 0 || x >= stride) return;
  const i = (y * stride + x) * 4;
  if (i < 0 || i + 3 >= buf.length) return;
  buf[i] = rgba[0];
  buf[i + 1] = rgba[1];
  buf[i + 2] = rgba[2];
  buf[i + 3] = rgba[3];
}

/**
 * @param {object} doc
 * @param {{
 *   textures?: { cropSprite: (file: string, index: number) => Promise<Buffer|null> },
 *   tileByType?: Record<string, { textureFile?: string, textureIndex?: number }>,
 *   objectByType?: Record<string, { textureFile?: string, textureIndex?: number, size?: number }>,
 * }} [options]
 */
export async function renderMapPreviewPng(doc, options = {}) {
  const textures = options.textures || null;
  const tileByType = options.tileByType || {};
  const objectByType = options.objectByType || {};

  const mapW = Math.max(1, Math.trunc(Number(doc.width) || 1));
  const mapH = Math.max(1, Math.trunc(Number(doc.height) || 1));

  const grid = new Int32Array(mapW * mapH);
  grid.fill(-1);
  let minX = mapW;
  let minY = mapH;
  let maxX = -1;
  let maxY = -1;

  function touch(x, y) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  for (const t of Array.isArray(doc.tiles) ? doc.tiles : []) {
    const x = Math.trunc(Number(t.x));
    const y = Math.trunc(Number(t.y));
    if (x < 0 || y < 0 || x >= mapW || y >= mapH) continue;
    grid[y * mapW + x] = Number(t.type);
    touch(x, y);
  }

  const objects = Array.isArray(doc.objects) ? doc.objects : [];
  for (const o of objects) {
    const x = Math.floor(Number(o.x));
    const y = Math.floor(Number(o.y));
    if (x < 0 || y < 0 || x >= mapW || y >= mapH) continue;
    touch(x, y);
  }

  if (doc.start && Number.isFinite(Number(doc.start.x)) && Number.isFinite(Number(doc.start.y))) {
    const sx = Math.floor(Number(doc.start.x));
    const sy = Math.floor(Number(doc.start.y));
    if (sx >= 0 && sy >= 0 && sx < mapW && sy < mapH) touch(sx, sy);
  }

  // Focus on content for sparse/large maps so tiles aren't a single speck.
  let viewX0 = 0;
  let viewY0 = 0;
  let viewW = mapW;
  let viewH = mapH;
  if (maxX >= minX && maxY >= minY) {
    const pad = 2;
    viewX0 = Math.max(0, minX - pad);
    viewY0 = Math.max(0, minY - pad);
    const viewX1 = Math.min(mapW - 1, maxX + pad);
    const viewY1 = Math.min(mapH - 1, maxY + pad);
    viewW = viewX1 - viewX0 + 1;
    viewH = viewY1 - viewY0 + 1;
    // If nearly full, keep whole map
    if (viewW * viewH > mapW * mapH * 0.85) {
      viewX0 = 0;
      viewY0 = 0;
      viewW = mapW;
      viewH = mapH;
    }
  }

  const cell = Math.max(
    MIN_CELL,
    Math.min(MAX_CELL, Math.floor(Math.min(MAX_SIDE / viewW, MAX_SIDE / viewH))),
  );
  const outW = viewW * cell;
  const outH = viewH * cell;
  const buf = Buffer.alloc(outW * outH * 4, 0);

  // Checker background
  for (let ty = 0; ty < viewH; ty++) {
    for (let tx = 0; tx < viewW; tx++) {
      const odd = ((tx + ty) & 1) !== 0;
      fillRect(
        buf,
        outW,
        tx * cell,
        ty * cell,
        cell,
        cell,
        odd ? [18, 24, 32, 255] : [12, 16, 22, 255],
      );
    }
  }

  const spriteCache = new Map();

  async function getSpritePng(file, index, size) {
    if (!textures || !file || index < 0 || size < 1) return null;
    const key = `${file}:${index}:${size}`;
    if (spriteCache.has(key)) return spriteCache.get(key);
    let png = null;
    try {
      const cropped = await textures.cropSprite(file, index);
      if (cropped) {
        png = await sharp(cropped)
          .resize(size, size, { kernel: sharp.kernel.nearest, fit: 'fill' })
          .png()
          .toBuffer();
      }
    } catch {
      png = null;
    }
    spriteCache.set(key, png);
    return png;
  }

  const composites = [];

  for (let vy = 0; vy < viewH; vy++) {
    for (let vx = 0; vx < viewW; vx++) {
      const mx = viewX0 + vx;
      const my = viewY0 + vy;
      const type = grid[my * mapW + mx];
      if (type < 0) continue;

      const def = tileByType[String(type >>> 0)];
      let drew = false;
      if (def && def.textureFile && def.textureIndex >= 0) {
        const sprite = await getSpritePng(def.textureFile, def.textureIndex, cell);
        if (sprite) {
          composites.push({
            input: sprite,
            left: vx * cell,
            top: vy * cell,
          });
          drew = true;
        }
      }
      if (!drew) {
        fillRect(buf, outW, vx * cell, vy * cell, cell, cell, tileRgb(type));
      }
    }
  }

  // Objects on top
  const sortedObjs = objects.slice().sort((a, b) => Number(a.y) - Number(b.y));
  for (const o of sortedObjs) {
    const mx = Math.floor(Number(o.x));
    const my = Math.floor(Number(o.y));
    if (mx < viewX0 || my < viewY0 || mx >= viewX0 + viewW || my >= viewY0 + viewH) continue;
    const vx = mx - viewX0;
    const vy = my - viewY0;
    const def = objectByType[String(o.type >>> 0)];
    const sizeMul = def && def.size > 0 ? Math.min(2, def.size / 100) : 1;
    const objSize = Math.max(MIN_CELL, Math.round(cell * sizeMul));
    let drew = false;
    if (def && def.textureFile && def.textureIndex >= 0) {
      const sprite = await getSpritePng(def.textureFile, def.textureIndex, objSize);
      if (sprite) {
        composites.push({
          input: sprite,
          left: Math.round(vx * cell + (cell - objSize) / 2),
          top: Math.round(vy * cell + (cell - objSize) / 2),
        });
        drew = true;
      }
    }
    if (!drew) {
      const pad = Math.max(1, Math.floor(cell * 0.2));
      fillRect(
        buf,
        outW,
        vx * cell + pad,
        vy * cell + pad,
        cell - pad * 2,
        cell - pad * 2,
        [240, 193, 75, 255],
      );
    }
  }

  // Start marker
  if (doc.start && Number.isFinite(Number(doc.start.x)) && Number.isFinite(Number(doc.start.y))) {
    const sx = Math.floor(Number(doc.start.x));
    const sy = Math.floor(Number(doc.start.y));
    if (sx >= viewX0 && sy >= viewY0 && sx < viewX0 + viewW && sy < viewY0 + viewH) {
      const vx = sx - viewX0;
      const vy = sy - viewY0;
      strokeRect(
        buf,
        outW,
        vx * cell + 1,
        vy * cell + 1,
        cell - 2,
        cell - 2,
        [88, 166, 255, 255],
      );
    }
  }

  let image = sharp(buf, {
    raw: { width: outW, height: outH, channels: 4 },
  });

  if (composites.length) {
    // sharp composite batches; chunk to avoid huge single calls
    const CHUNK = 200;
    for (let i = 0; i < composites.length; i += CHUNK) {
      const chunk = composites.slice(i, i + CHUNK);
      const intermediate = await image.composite(chunk).png().toBuffer();
      image = sharp(intermediate);
    }
  }

  return image.png().toBuffer();
}

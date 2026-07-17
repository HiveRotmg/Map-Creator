/**
 * Map format aligned with Headless pathfinding fixtures
 * (PathfindingMapFixture in headless-client/test/helpers/pathfinding-map-generator.ts):
 *   width, height, start:{x,y}, tiles:[{x,y,type}], objects:[{id,type,x,y}]
 *
 * Start position uses world coordinates at tile centers (e.g. 0.5, 2.5),
 * matching the existing fixture convention.
 */

export const MAP_FORMAT = 'hive-map-v1';
export const MIN_SIZE = 1;
export const MAX_SIZE = 512;

export function tileCenter(tx, ty) {
  return { x: tx + 0.5, y: ty + 0.5 };
}

export function worldToTile(x, y) {
  return { x: Math.floor(Number(x)), y: Math.floor(Number(y)) };
}

export function createBlankMap({ name, width, height, defaultTile = -1, startX = 0, startY = 0 }) {
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  validateDimensions(w, h);
  const fill = Number(defaultTile);
  const tiles = [];
  if (Number.isFinite(fill) && fill >= 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        tiles.push({ x, y, type: fill >>> 0 });
      }
    }
  }
  const sx = Math.max(0, Math.min(w - 1, Math.trunc(startX)));
  const sy = Math.max(0, Math.min(h - 1, Math.trunc(startY)));
  return {
    format: MAP_FORMAT,
    name: String(name || 'Untitled Map').trim() || 'Untitled Map',
    width: w,
    height: h,
    defaultTile: Number.isFinite(fill) ? fill : -1,
    start: tileCenter(sx, sy),
    tiles,
    objects: [],
  };
}

export function validateDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Width and height must be integers');
  }
  if (width < MIN_SIZE || height < MIN_SIZE) {
    throw new Error(`Map dimensions must be at least ${MIN_SIZE}×${MIN_SIZE}`);
  }
  if (width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Map dimensions cannot exceed ${MAX_SIZE}×${MAX_SIZE}`);
  }
}

/**
 * Validate a map document before save/load.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateMap(doc, catalogs = {}) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['Map document is missing or invalid'], warnings };
  }

  const name = String(doc.name || '').trim();
  if (!name) warnings.push('Map name is empty');

  const width = Number(doc.width);
  const height = Number(doc.height);
  try {
    validateDimensions(Math.trunc(width), Math.trunc(height));
  } catch (err) {
    errors.push(err.message);
  }

  if (!doc.start || !Number.isFinite(Number(doc.start.x)) || !Number.isFinite(Number(doc.start.y))) {
    warnings.push('No start tile is set');
  } else {
    const st = worldToTile(doc.start.x, doc.start.y);
    if (st.x < 0 || st.y < 0 || st.x >= width || st.y >= height) {
      errors.push(`Start tile (${st.x}, ${st.y}) is outside map bounds`);
    }
  }

  const tileTypes = catalogs.tileTypes instanceof Set ? catalogs.tileTypes : null;
  const objectTypes = catalogs.objectTypes instanceof Set ? catalogs.objectTypes : null;

  const tiles = Array.isArray(doc.tiles) ? doc.tiles : [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const x = Number(t?.x);
    const y = Number(t?.y);
    const type = Number(t?.type);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isFinite(type)) {
      errors.push(`Tile entry ${i} is malformed`);
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      errors.push(`Tile at (${x}, ${y}) is outside map bounds`);
    }
    if (tileTypes && !tileTypes.has(type >>> 0) && type >= 0) {
      warnings.push(`Unresolved tile type 0x${(type >>> 0).toString(16)} at (${x}, ${y})`);
    }
  }

  const objects = Array.isArray(doc.objects) ? doc.objects : [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const type = Number(o?.type);
    const x = Number(o?.x);
    const y = Number(o?.y);
    if (!Number.isFinite(type) || !Number.isFinite(x) || !Number.isFinite(y)) {
      errors.push(`Object entry ${i} is malformed`);
      continue;
    }
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) {
      errors.push(`Object ${o.id ?? i} at (${tx}, ${ty}) is outside map bounds`);
    }
    if (objectTypes && !objectTypes.has(type >>> 0)) {
      warnings.push(`Unresolved object type 0x${(type >>> 0).toString(16)} (id ${o.id ?? i})`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function normalizeMap(raw) {
  const width = Math.trunc(Number(raw.width));
  const height = Math.trunc(Number(raw.height));
  validateDimensions(width, height);

  const tiles = [];
  const seen = new Set();
  for (const t of Array.isArray(raw.tiles) ? raw.tiles : []) {
    const x = Math.trunc(Number(t.x));
    const y = Math.trunc(Number(t.y));
    const type = Number(t.type);
    if (!Number.isFinite(type) || x < 0 || y < 0 || x >= width || y >= height) continue;
    const key = (x << 16) | y;
    if (seen.has(key)) continue;
    seen.add(key);
    tiles.push({ x, y, type: type >>> 0 });
  }

  const objects = [];
  let nextId = 1;
  for (const o of Array.isArray(raw.objects) ? raw.objects : []) {
    const type = Number(o.type);
    const x = Number(o.x);
    const y = Number(o.y);
    if (!Number.isFinite(type) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
    const id = Number.isFinite(Number(o.id)) ? Math.trunc(Number(o.id)) : nextId++;
    nextId = Math.max(nextId, id + 1);
    objects.push({
      id,
      type: type >>> 0,
      x: Number.isInteger(x) ? x + 0.5 : x,
      y: Number.isInteger(y) ? y + 0.5 : y,
    });
  }

  let start;
  if (raw.start && Number.isFinite(Number(raw.start.x)) && Number.isFinite(Number(raw.start.y))) {
    const st = worldToTile(raw.start.x, raw.start.y);
    const sx = Math.max(0, Math.min(width - 1, st.x));
    const sy = Math.max(0, Math.min(height - 1, st.y));
    start = tileCenter(sx, sy);
  } else {
    start = tileCenter(0, 0);
  }

  return {
    format: MAP_FORMAT,
    name: String(raw.name || 'Untitled Map').trim() || 'Untitled Map',
    width,
    height,
    defaultTile: Number.isFinite(Number(raw.defaultTile)) ? Number(raw.defaultTile) : -1,
    start,
    tiles,
    objects,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : undefined,
  };
}

export function serializeMap(doc) {
  const normalized = normalizeMap(doc);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function parseMapJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Map file is not valid JSON');
  }
  return normalizeMap(raw);
}

/**
 * Slim catalog builder over bundled RotMG XML (data/objects.xml + data/tiles.xml).
 * Field shapes match Headless Manager GameDataLoader / Game Wiki catalogs.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';

function readFirstTextureFile(textureNode) {
  if (textureNode == null) return '';
  if (Array.isArray(textureNode)) {
    for (const item of textureNode) {
      const file = readFirstTextureFile(item);
      if (file) return file;
    }
    return '';
  }
  if (typeof textureNode !== 'object') return '';
  const file = textureNode.File;
  return typeof file === 'string' ? file.trim() : '';
}

function readFirstTextureIndex(textureNode) {
  if (textureNode == null) return -1;
  if (Array.isArray(textureNode)) {
    for (const item of textureNode) {
      const index = readFirstTextureIndex(item);
      if (index >= 0) return index;
    }
    return -1;
  }
  if (typeof textureNode !== 'object') return -1;
  const index = Number(textureNode.Index);
  return Number.isFinite(index) ? index : -1;
}

function readableId(id) {
  if (!id) return '';
  return String(id)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

function objectCategory(def) {
  const c = (def.objectClass || '').toLowerCase();
  if (def.isPlayer) return 'Player';
  if (def.isEnemy || c === 'character') return 'Enemy';
  if (def.isContainer || c === 'container') return 'Container';
  if (c.includes('portal')) return 'Portal';
  if (c === 'projectile') return 'Projectile';
  if (def.isPet || c === 'pet') return 'Pet';
  if (c === 'gameobject' && !def.occupySquare) return 'VisualOnly';
  return 'Other';
}

export function loadCatalog(dataDir) {
  const objectsPath = join(dataDir, 'objects.xml');
  const tilesPath = join(dataDir, 'tiles.xml');
  if (!existsSync(objectsPath)) throw new Error(`Missing objects.xml at ${objectsPath}`);
  if (!existsSync(tilesPath)) throw new Error(`Missing tiles.xml at ${tilesPath}`);

  const objects = parseObjects(readFileSync(objectsPath, 'utf8'));
  const tiles = parseTiles(readFileSync(tilesPath, 'utf8'));

  return {
    objects,
    tiles,
    objectTypes: new Set(objects.map((o) => o.type)),
    tileTypes: new Set(tiles.map((t) => t.type)),
    objectByType: Object.fromEntries(objects.map((o) => [String(o.type), o])),
    tileByType: Object.fromEntries(tiles.map((t) => [String(t.type), t])),
  };
}

function parseObjects(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'Object',
  });
  const parsed = parser.parse(xml);
  const list = parsed.Objects?.Object ?? [];
  const out = [];

  for (const obj of list) {
    const typeStr = obj['@_type'];
    if (!typeStr) continue;
    const type = parseInt(String(typeStr), 16);
    if (!Number.isFinite(type)) continue;
    const id = String(obj['@_id'] ?? '');
    const displayId = String(obj.DisplayId ?? '').trim();
    const objectClass = String(obj.Class ?? '');
    const textureNode = obj.Texture ?? obj.AnimatedTexture ?? obj.RandomTexture?.Texture;
    const textureFile = readFirstTextureFile(textureNode);
    const textureIndex = readFirstTextureIndex(textureNode);
    const def = {
      type,
      typeHex: `0x${type.toString(16)}`,
      id,
      displayId: displayId || id,
      objectClass,
      textureFile,
      textureIndex,
      size: Number(obj.Size ?? obj.MinSize ?? 100) || 100,
      occupySquare: obj.OccupySquare !== undefined,
      isEnemy: obj.Enemy !== undefined,
      isPlayer: obj.Player !== undefined,
      isContainer: obj.Container !== undefined,
      isPet: obj.Pet !== undefined,
      dungeonName: String(obj.DungeonName ?? '').trim(),
    };
    def.category = objectCategory(def);
    out.push(def);
  }

  out.sort((a, b) => a.type - b.type);
  return out;
}

function parseTiles(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'Ground' || name === 'Texture',
  });
  const parsed = parser.parse(xml);
  const grounds = parsed.GroundTypes?.Ground ?? [];
  const out = [];

  for (const ground of grounds) {
    const typeStr = ground['@_type'];
    if (!typeStr) continue;
    const type = parseInt(String(typeStr), 16);
    if (!Number.isFinite(type)) continue;
    const id = String(ground['@_id'] ?? '');
    const textureNode = ground.Texture ?? ground.RandomTexture?.Texture;
    const textureFile = readFirstTextureFile(textureNode);
    const textureIndex = readFirstTextureIndex(textureNode);
    const noWalk = ground.NoWalk !== undefined;
    const sink = ground.Sink !== undefined;
    const speed = Number(ground.Speed ?? 1);
    const minDmg = Number(ground.MinDamage ?? 0);
    const maxDmg = Number(ground.MaxDamage ?? 0);
    const damagePerTick = Math.max(minDmg, maxDmg) || undefined;
    const hasPush = ground.Push !== undefined || ground.Animate !== undefined;

    let tileBucket = 'Other';
    if (noWalk) tileBucket = 'NoWalk';
    else if (sink) tileBucket = 'Sink';
    else if (Number.isFinite(speed) && speed !== 1) tileBucket = 'Speed';
    else if (damagePerTick) tileBucket = 'Damaging';
    else if (hasPush) tileBucket = 'Push';

    out.push({
      type,
      typeHex: `0x${type.toString(16)}`,
      id: readableId(id) || id || `0x${type.toString(16)}`,
      rawId: id,
      noWalk,
      sink,
      speed: Number.isFinite(speed) ? speed : 1,
      damagePerTick,
      hasPush,
      tileBucket,
      textureFile,
      textureIndex,
    });
  }

  out.sort((a, b) => a.type - b.type);
  return out;
}

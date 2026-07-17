/**
 * Texture crop serving adapted from Manager/src/dev/server/DevServer.ts
 * (parseWikiSpritesheetXml / tryServeExtractorWikiSprite / wiki-texture-file).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';

const WIKI_EXTRACT_ATLAS_BASES = ['groundTiles', 'characters', 'characters_masks', 'mapObjects'];

export class TextureServer {
  constructor(gameDataDir) {
    this.gameDataDir = gameDataDir;
    this.cache = null;
  }

  mapWikiAtlasRawToSheetIndex(rawAtlasId) {
    const a = Math.trunc(rawAtlasId) - 1;
    if (a < 0 || a >= WIKI_EXTRACT_ATLAS_BASES.length) return -1;
    return a;
  }

  parseWikiSpritesheetXml(xml) {
    const out = new Map();
    let parsed;
    try {
      parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml);
    } catch {
      return out;
    }
    const root = parsed?.DecompiledSpriteSheet;
    if (!root?.SpriteGroups) return out;
    let groups = root.SpriteGroups.SpriteGroup;
    if (groups == null) return out;
    if (!Array.isArray(groups)) groups = [groups];
    for (const g of groups) {
      const name = String(g['@_Name'] ?? '').trim();
      if (!name) continue;
      let sprites = g.Sprite;
      const inner = new Map();
      if (sprites != null) {
        if (!Array.isArray(sprites)) sprites = [sprites];
        for (const s of sprites) {
          const idx = Number(s['@_Index']);
          const atlasId = Number(s['@_AtlasId']);
          const x = Number(s['@_X']);
          const y = Number(s['@_Y']);
          const w = Number(s['@_W']);
          const h = Number(s['@_H']);
          if (!Number.isFinite(idx) || !Number.isFinite(atlasId)) continue;
          inner.set(idx, {
            atlasId,
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            w: Number.isFinite(w) ? w : 0,
            h: Number.isFinite(h) ? h : 0,
          });
        }
      }
      out.set(name.toLowerCase(), inner);
    }
    return out;
  }

  ensureLoaded() {
    const sheetPath = join(this.gameDataDir, 'spritesheet.xml');
    if (!existsSync(sheetPath)) return;
    const mtime = statSync(sheetPath).mtimeMs;
    if (this.cache && this.cache.sheetMtime === mtime) return;
    const xml = readFileSync(sheetPath, 'utf8');
    this.cache = {
      sheetMtime: mtime,
      byGroup: this.parseWikiSpritesheetXml(xml),
    };
    console.log(`[textures] loaded spritesheet (${this.cache.byGroup.size} groups)`);
  }

  findCaseInsensitivePng(dir, base) {
    if (!existsSync(dir)) return null;
    const want = `${base}.png`.toLowerCase();
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase() === want) return join(dir, name);
    }
    return null;
  }

  lookupFrame(fileBase, index) {
    this.ensureLoaded();
    if (!this.cache) return null;
    const g = this.cache.byGroup.get(String(fileBase).toLowerCase());
    if (!g) return null;
    return g.get(index) ?? null;
  }

  async cropSprite(fileBase, index) {
    const frame = this.lookupFrame(fileBase, index);
    if (!frame || frame.w <= 0 || frame.h <= 0) return null;
    const sheetIdx = this.mapWikiAtlasRawToSheetIndex(frame.atlasId);
    if (sheetIdx < 0) return null;
    const atlasBase = WIKI_EXTRACT_ATLAS_BASES[sheetIdx];
    const atlasPath = this.findCaseInsensitivePng(join(this.gameDataDir, 'images'), atlasBase);
    if (!atlasPath) return null;

    const meta = await sharp(atlasPath).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (frame.x < 0 || frame.y < 0 || frame.x + frame.w > iw || frame.y + frame.h > ih) {
      return null;
    }
    return sharp(atlasPath)
      .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
      .png()
      .toBuffer();
  }

  findLooseSheet(fileBase) {
    const images = join(this.gameDataDir, 'images');
    const hit = this.findCaseInsensitivePng(images, fileBase);
    if (hit) return hit;
    const parent = dirname(this.gameDataDir);
    return (
      this.findCaseInsensitivePng(join(this.gameDataDir, 'spritesheets'), fileBase)
      || this.findCaseInsensitivePng(join(parent, 'images'), fileBase)
      || this.findCaseInsensitivePng(join(parent, 'spritesheets'), fileBase)
    );
  }

  /**
   * Handle GET /api/wiki-texture-file?file=&index=
   * Same URL contract as Manager DevServer.
   */
  async handleRequest(url, res) {
    if (!url.pathname.startsWith('/api/wiki-texture-file')) return false;
    const rawFile = String(url.searchParams.get('file') || '').trim();
    const safe = rawFile.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe || safe.length > 80) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad_file');
      return true;
    }

    const rawIndex = url.searchParams.get('index');
    let index = null;
    if (rawIndex != null && rawIndex !== '') {
      const hex = /^0x/i.test(String(rawIndex).trim());
      const n = parseInt(String(rawIndex).trim().replace(/^0x/i, ''), hex ? 16 : 10);
      index = Number.isFinite(n) ? n : null;
    }

    try {
      if (index !== null) {
        const buf = await this.cropSprite(safe, index);
        if (buf) {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
            'X-Wiki-Sprite-Cropped': '1',
          });
          res.end(buf);
          return true;
        }
      }
      const loose = this.findLooseSheet(safe);
      if (loose) {
        const buf = readFileSync(loose);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
        return true;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not_found');
      return true;
    } catch (err) {
      console.warn('[textures]', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('error');
      }
      return true;
    }
  }
}

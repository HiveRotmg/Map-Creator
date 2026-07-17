/**
 * Standalone map-editor server.
 * Uses bundled game data under ./data (objects.xml, tiles.xml, spritesheet.xml, images/).
 */

import http from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, extname, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { loadCatalog } from './lib/catalog.mjs';
import { TextureServer } from './lib/textures.mjs';
import { renderMapPreviewPng, PREVIEW_VERSION } from './lib/preview.mjs';
import {
  createBlankMap,
  parseMapJson,
  serializeMap,
  validateMap,
  MAP_FORMAT,
  worldToTile,
} from './lib/map-format.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC_DIR = join(ROOT, 'public');
const MAPS_DIR = join(ROOT, 'maps');
const PREVIEWS_DIR = join(MAPS_DIR, '.previews');

const DEFAULT_DATA_DIR = resolve(ROOT, 'data');
const DATA_DIR = resolve(process.env.MAP_EDITOR_DATA_DIR || process.env.HIVE_DATA_DIR || DEFAULT_DATA_DIR);
const PORT = Number(process.env.PORT || 4173);

mkdirSync(MAPS_DIR, { recursive: true });
mkdirSync(PREVIEWS_DIR, { recursive: true });

if (!existsSync(join(DATA_DIR, 'objects.xml')) || !existsSync(join(DATA_DIR, 'tiles.xml'))) {
  console.error(`[map-editor] Bundled game data not found at ${DATA_DIR}`);
  console.error('Expected data/objects.xml and data/tiles.xml next to server.mjs.');
  process.exit(1);
}

console.log(`[map-editor] Loading catalog from ${DATA_DIR} ...`);
const catalog = loadCatalog(DATA_DIR);
const textures = new TextureServer(DATA_DIR);
textures.ensureLoaded();
console.log(`[map-editor] Catalog ready: ${catalog.objects.length} objects, ${catalog.tiles.length} tiles`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeMapFileName(name) {
  const base = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!base) return null;
  return base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
}

function previewPathFor(file) {
  return join(PREVIEWS_DIR, `${basename(file, '.json')}.v${PREVIEW_VERSION}.png`);
}

async function writePreviewForMap(file, doc) {
  try {
    const png = await renderMapPreviewPng(doc, {
      textures,
      tileByType: catalog.tileByType,
      objectByType: catalog.objectByType,
    });
    writeFileSync(previewPathFor(file), png);
  } catch (err) {
    console.warn('[map-editor] preview failed:', err.message);
  }
}

function listMaps() {
  if (!existsSync(MAPS_DIR)) return [];
  return readdirSync(MAPS_DIR)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => {
      const p = join(MAPS_DIR, n);
      const st = statSync(p);
      let meta = {};
      try {
        const doc = JSON.parse(readFileSync(p, 'utf8'));
        const start = doc.start
          ? worldToTile(doc.start.x, doc.start.y)
          : null;
        meta = {
          name: doc.name || n,
          width: doc.width,
          height: doc.height,
          format: doc.format || MAP_FORMAT,
          tileCount: Array.isArray(doc.tiles) ? doc.tiles.length : 0,
          objectCount: Array.isArray(doc.objects) ? doc.objects.length : 0,
          start,
          hasPreview: existsSync(previewPathFor(n)),
        };
      } catch {
        meta = { name: n, hasPreview: false };
      }
      return {
        file: n,
        ...meta,
        mtime: st.mtimeMs,
        size: st.size,
        previewUrl: `/api/maps/${encodeURIComponent(n)}/preview?v=${PREVIEW_VERSION}&t=${Math.trunc(st.mtimeMs)}`,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('bad path');
    return true;
  }
  const filePath = join(PUBLIC_DIR, rel.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
  });
  res.end(readFileSync(filePath));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (await textures.handleRequest(url, res)) return;

    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      sendJson(res, 200, {
        objects: catalog.objects,
        tiles: catalog.tiles,
        dataDir: DATA_DIR,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/maps') {
      sendJson(res, 200, { maps: listMaps() });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/maps/') && url.pathname.endsWith('/preview')) {
      const raw = decodeURIComponent(url.pathname.slice('/api/maps/'.length, -'/preview'.length));
      const file = safeMapFileName(raw);
      if (!file) {
        sendJson(res, 400, { error: 'Invalid map name' });
        return;
      }
      const mapPath = join(MAPS_DIR, file);
      if (!existsSync(mapPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not_found');
        return;
      }
      const prevPath = previewPathFor(file);
      try {
        if (!existsSync(prevPath) || statSync(prevPath).mtimeMs < statSync(mapPath).mtimeMs) {
          const doc = parseMapJson(readFileSync(mapPath, 'utf8'));
          await writePreviewForMap(file, doc);
        }
        const buf = readFileSync(prevPath);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/maps/')) {
      const file = safeMapFileName(decodeURIComponent(url.pathname.slice('/api/maps/'.length)));
      if (!file) {
        sendJson(res, 400, { error: 'Invalid map name' });
        return;
      }
      const path = join(MAPS_DIR, file);
      if (!existsSync(path)) {
        sendJson(res, 404, { error: 'Map not found' });
        return;
      }
      unlinkSync(path);
      const prev = previewPathFor(file);
      if (existsSync(prev)) unlinkSync(prev);
      sendJson(res, 200, { ok: true, file });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/maps/')) {
      const file = safeMapFileName(decodeURIComponent(url.pathname.slice('/api/maps/'.length)));
      if (!file) {
        sendJson(res, 400, { error: 'Invalid map name' });
        return;
      }
      const path = join(MAPS_DIR, file);
      if (!existsSync(path)) {
        sendJson(res, 404, { error: 'Map not found' });
        return;
      }
      try {
        const doc = parseMapJson(readFileSync(path, 'utf8'));
        sendJson(res, 200, { file, map: doc });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/maps/validate') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = validateMap(body.map || body, {
        tileTypes: catalog.tileTypes,
        objectTypes: catalog.objectTypes,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/maps') {
      const body = JSON.parse(await readBody(req) || '{}');
      const file = safeMapFileName(body.file || body.map?.name);
      if (!file) {
        sendJson(res, 400, { error: 'Missing map file/name' });
        return;
      }
      const doc = typeof body.map === 'string' ? parseMapJson(body.map) : parseMapJson(JSON.stringify(body.map));
      const validation = validateMap(doc, {
        tileTypes: catalog.tileTypes,
        objectTypes: catalog.objectTypes,
      });
      if (!validation.ok && !body.force) {
        sendJson(res, 400, { error: 'Validation failed', validation });
        return;
      }
      const path = join(MAPS_DIR, file);
      if (existsSync(path) && !body.overwrite && !body.force) {
        sendJson(res, 409, { error: 'Map already exists', file, validation });
        return;
      }
      writeFileSync(path, serializeMap(doc), 'utf8');
      await writePreviewForMap(file, doc);
      sendJson(res, 200, { ok: true, file, validation, map: doc });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/maps/new') {
      const body = JSON.parse(await readBody(req) || '{}');
      try {
        const map = createBlankMap({
          name: body.name,
          width: Number(body.width),
          height: Number(body.height),
          defaultTile: body.defaultTile,
          startX: body.startX,
          startY: body.startY,
        });
        sendJson(res, 200, { map });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'GET' && serveStatic(url.pathname, res)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    console.error('[map-editor]', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || 'Server error' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`[map-editor] http://localhost:${PORT}`);
  console.log(`[map-editor] Maps directory: ${MAPS_DIR}`);
});

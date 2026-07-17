(function () {
  'use strict';

  // ── DOM ──────────────────────────────────────────────────────────────
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const emptyState = document.getElementById('empty-state');
  const assetList = document.getElementById('asset-list');
  const assetSearch = document.getElementById('asset-search');
  const assetFilter = document.getElementById('asset-filter');
  const assetStatus = document.getElementById('asset-status');
  const propsBody = document.getElementById('props-body');
  const brushPreview = document.getElementById('brush-preview');
  const mapTitleEl = document.getElementById('map-title');
  const cursorInfo = document.getElementById('cursor-info');
  const startInfo = document.getElementById('start-info');
  const zoomLabel = document.getElementById('zoom-label');
  const toastEl = document.getElementById('toast');
  const dlgNew = document.getElementById('dlg-new');
  const dlgOpen = document.getElementById('dlg-open');
  const dlgSaveAs = document.getElementById('dlg-save-as');
  const openList = document.getElementById('open-list');
  const openFileInput = document.getElementById('open-file');
  const btnOpenConfirm = document.getElementById('btn-open-confirm');

  // ── State ────────────────────────────────────────────────────────────
  let catalog = { objects: [], tiles: [], objectByType: {}, tileByType: {} };
  let catalogSection = 'tiles';
  let filteredAssets = [];
  let selectedTileType = null;
  let selectedObjectType = null;
  let selectedAssetIndex = -1;
  let searchTimer = null;
  let listRenderRaf = null;

  let map = null;
  let mapFile = null;
  let dirty = false;
  /** Dense tile grid: Int32Array length width*height; -1 = empty */
  let tileGrid = null;
  /** @type {{id:number,type:number,x:number,y:number}[]} */
  let objects = [];
  let nextObjectId = 1;
  let startTile = { x: 0, y: 0 };
  let hoverTile = null;
  let selectedCell = null;
  let selectedObjectId = null;

  let tool = 'select';
  let showGrid = true;
  let camera = { x: 0, y: 0, zoom: 1 };
  const BASE_TILE = 32;

  let painting = false;
  let panning = false;
  let panLast = null;
  let spaceDown = false;
  let rectAnchor = null;
  let strokeChanges = null;

  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 100;

  const textureCache = new Map();
  let needsRedraw = true;
  let toastTimer = null;
  let openSelection = null;

  // ── Helpers ──────────────────────────────────────────────────────────
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.add('hidden');
    }, 4200);
  }

  function hexType(n) {
    return '0x' + (n >>> 0).toString(16);
  }

  function tileKey(x, y) {
    return (x << 16) | (y & 0xffff);
  }

  function inBounds(x, y) {
    return map && x >= 0 && y >= 0 && x < map.width && y < map.height;
  }

  function getTile(x, y) {
    if (!tileGrid || !inBounds(x, y)) return -1;
    return tileGrid[y * map.width + x];
  }

  function setTileRaw(x, y, type) {
    if (!tileGrid || !inBounds(x, y)) return false;
    const i = y * map.width + x;
    const prev = tileGrid[i];
    if (prev === type) return false;
    tileGrid[i] = type;
    return true;
  }

  function worldToTile(wx, wy) {
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  function tileCenter(tx, ty) {
    return { x: tx + 0.5, y: ty + 0.5 };
  }

  function markDirty() {
    dirty = true;
    updateChrome();
    needsRedraw = true;
  }

  function updateChrome() {
    if (!map) {
      mapTitleEl.textContent = 'No map';
      startInfo.textContent = 'Start: —';
      emptyState.classList.remove('hidden');
    } else {
      mapTitleEl.textContent = (dirty ? '● ' : '') + map.name + (mapFile ? ' (' + mapFile + ')' : '');
      startInfo.textContent = 'Start: (' + startTile.x + ', ' + startTile.y + ')';
      emptyState.classList.add('hidden');
    }
    zoomLabel.textContent = Math.round(camera.zoom * 100) + '%';
    document.getElementById('btn-undo').disabled = undoStack.length === 0;
    document.getElementById('btn-redo').disabled = redoStack.length === 0;
  }

  function textureUrl(file, index) {
    if (!file || index < 0) return null;
    return '/api/wiki-texture-file?file=' + encodeURIComponent(file)
      + '&index=' + encodeURIComponent(String(index));
  }

  function getTexture(file, index) {
    const key = file + ':' + index;
    let entry = textureCache.get(key);
    if (entry) return entry;
    const url = textureUrl(file, index);
    entry = { img: null, loaded: false, failed: false };
    textureCache.set(key, entry);
    if (!url) {
      entry.failed = true;
      return entry;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      entry.loaded = true;
      needsRedraw = true;
      scheduleAssetList();
    };
    img.onerror = function () {
      entry.failed = true;
      scheduleAssetList();
    };
    img.src = url;
    entry.img = img;
    return entry;
  }

  // ── Catalog UI (Game Wiki–style search) ──────────────────────────────
  const TILE_FILTERS = ['all', 'NoWalk', 'Sink', 'Speed', 'Damaging', 'Push', 'Other'];
  const OBJ_FILTERS = ['all', 'Enemy', 'Portal', 'Container', 'Player', 'Pet', 'VisualOnly', 'Other'];

  function rebuildFilterOptions() {
    const opts = catalogSection === 'tiles' ? TILE_FILTERS : OBJ_FILTERS;
    assetFilter.innerHTML = '';
    opts.forEach(function (v) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'all' ? 'All' : v;
      assetFilter.appendChild(o);
    });
  }

  function rebuildFiltered() {
    const q = (assetSearch.value || '').trim().toLowerCase();
    const filter = assetFilter.value || 'all';
    filteredAssets = [];
    if (catalogSection === 'tiles') {
      for (let i = 0; i < catalog.tiles.length; i++) {
        const t = catalog.tiles[i];
        if (filter !== 'all' && t.tileBucket !== filter) continue;
        if (q) {
          const hit = (t.id && t.id.toLowerCase().indexOf(q) >= 0)
            || (t.typeHex && t.typeHex.toLowerCase().indexOf(q) >= 0)
            || String(t.type).indexOf(q) >= 0
            || (t.tileBucket && t.tileBucket.toLowerCase().indexOf(q) >= 0);
          if (!hit) continue;
        }
        filteredAssets.push(t);
      }
    } else {
      for (let i = 0; i < catalog.objects.length; i++) {
        const o = catalog.objects[i];
        if (filter !== 'all' && o.category !== filter) continue;
        if (q) {
          const hit = (o.id && o.id.toLowerCase().indexOf(q) >= 0)
            || (o.displayId && String(o.displayId).toLowerCase().indexOf(q) >= 0)
            || (o.typeHex && o.typeHex.toLowerCase().indexOf(q) >= 0)
            || String(o.type).indexOf(q) >= 0
            || (o.objectClass && String(o.objectClass).toLowerCase().indexOf(q) >= 0)
            || (o.category && String(o.category).toLowerCase().indexOf(q) >= 0)
            || (o.dungeonName && o.dungeonName.toLowerCase().indexOf(q) >= 0);
          if (!hit) continue;
        }
        filteredAssets.push(o);
      }
    }
    selectedAssetIndex = -1;
    if (catalogSection === 'tiles' && selectedTileType != null) {
      selectedAssetIndex = filteredAssets.findIndex(function (a) { return a.type === selectedTileType; });
    }
    if (catalogSection === 'objects' && selectedObjectType != null) {
      selectedAssetIndex = filteredAssets.findIndex(function (a) { return a.type === selectedObjectType; });
    }
    assetStatus.textContent = filteredAssets.length + ' / '
      + (catalogSection === 'tiles' ? catalog.tiles.length + ' tiles' : catalog.objects.length + ' objects');
    scheduleAssetList();
  }

  function scheduleAssetList() {
    if (listRenderRaf) cancelAnimationFrame(listRenderRaf);
    listRenderRaf = requestAnimationFrame(renderAssetList);
  }

  function renderAssetList() {
    listRenderRaf = null;
    const scrollTop = assetList.scrollTop;
    const frag = document.createDocumentFragment();
    const max = Math.min(filteredAssets.length, 400);
    for (let i = 0; i < max; i++) {
      const item = filteredAssets[i];
      const row = document.createElement('div');
      row.className = 'asset-row' + (i === selectedAssetIndex ? ' selected' : '');
      row.dataset.index = String(i);

      let thumb;
      if (item.textureFile && item.textureIndex >= 0) {
        const tex = getTexture(item.textureFile, item.textureIndex);
        if (tex.loaded && tex.img) {
          thumb = document.createElement('img');
          thumb.className = 'asset-thumb';
          thumb.src = tex.img.src;
          thumb.alt = '';
        } else {
          thumb = document.createElement('div');
          thumb.className = 'asset-thumb missing';
          thumb.textContent = tex.failed ? '—' : '…';
        }
      } else {
        thumb = document.createElement('div');
        thumb.className = 'asset-thumb missing';
        thumb.textContent = '—';
      }

      const meta = document.createElement('div');
      meta.className = 'asset-meta';
      const name = document.createElement('div');
      name.className = 'asset-name';
      name.textContent = catalogSection === 'tiles' ? item.id : (item.displayId || item.id);
      const sub = document.createElement('div');
      sub.className = 'asset-sub';
      sub.textContent = item.typeHex
        + (catalogSection === 'tiles'
          ? ' · ' + (item.tileBucket || '')
          : ' · ' + (item.category || item.objectClass || ''));
      meta.appendChild(name);
      meta.appendChild(sub);
      row.appendChild(thumb);
      row.appendChild(meta);
      frag.appendChild(row);
    }
    if (filteredAssets.length > max) {
      const more = document.createElement('div');
      more.className = 'asset-status';
      more.textContent = 'Showing first ' + max + ' — refine search for more';
      frag.appendChild(more);
    }
    assetList.innerHTML = '';
    assetList.appendChild(frag);
    assetList.scrollTop = scrollTop;
  }

  function selectAsset(index) {
    const item = filteredAssets[index];
    if (!item) return;
    selectedAssetIndex = index;
    if (catalogSection === 'tiles') {
      selectedTileType = item.type;
      if (tool === 'select' || tool === 'object') setTool('tile');
    } else {
      selectedObjectType = item.type;
      if (tool === 'select' || tool === 'tile' || tool === 'fill' || tool === 'rect') setTool('object');
    }
    updateBrushPreview();
    scheduleAssetList();
  }

  function updateBrushPreview() {
    brushPreview.innerHTML = '';
    let item = null;
    if (tool === 'object' || (tool === 'erase' && selectedObjectType != null && catalogSection === 'objects')) {
      item = catalog.objectByType[String(selectedObjectType)];
    } else if (selectedTileType != null) {
      item = catalog.tileByType[String(selectedTileType)];
    }
    if (!item) {
      brushPreview.classList.add('muted');
      brushPreview.textContent = 'None selected — pick from the catalog';
      return;
    }
    brushPreview.classList.remove('muted');
    if (item.textureFile && item.textureIndex >= 0) {
      const tex = getTexture(item.textureFile, item.textureIndex);
      if (tex.loaded && tex.img) {
        const img = document.createElement('img');
        img.src = tex.img.src;
        brushPreview.appendChild(img);
      }
    }
    const text = document.createElement('div');
    text.innerHTML = '<strong>' + escapeHtml(item.displayId || item.id) + '</strong><br><span class="muted">'
      + escapeHtml(item.typeHex) + '</span>';
    brushPreview.appendChild(text);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Map document conversion ──────────────────────────────────────────
  function loadMapDocument(doc, fileName) {
    map = {
      format: doc.format || 'hive-map-v1',
      name: doc.name || 'Untitled Map',
      width: doc.width,
      height: doc.height,
      defaultTile: Number.isFinite(doc.defaultTile) ? doc.defaultTile : -1,
    };
    tileGrid = new Int32Array(map.width * map.height);
    tileGrid.fill(-1);
    const tiles = Array.isArray(doc.tiles) ? doc.tiles : [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (inBounds(t.x, t.y)) tileGrid[t.y * map.width + t.x] = t.type >>> 0;
    }
    objects = (Array.isArray(doc.objects) ? doc.objects : []).map(function (o) {
      return {
        id: Number(o.id),
        type: o.type >>> 0,
        x: Number(o.x),
        y: Number(o.y),
      };
    });
    nextObjectId = 1;
    objects.forEach(function (o) { nextObjectId = Math.max(nextObjectId, o.id + 1); });
    if (doc.start) {
      const st = worldToTile(doc.start.x, doc.start.y);
      startTile = {
        x: Math.max(0, Math.min(map.width - 1, st.x)),
        y: Math.max(0, Math.min(map.height - 1, st.y)),
      };
    } else {
      startTile = { x: 0, y: 0 };
    }
    mapFile = fileName || null;
    dirty = false;
    undoStack.length = 0;
    redoStack.length = 0;
    selectedCell = null;
    selectedObjectId = null;
    hoverTile = null;
    camera.zoom = 1;
    centerCamera();
    updateChrome();
    updateProps();
    needsRedraw = true;
  }

  function buildMapDocument() {
    const tiles = [];
    if (tileGrid && map) {
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const type = tileGrid[y * map.width + x];
          if (type >= 0) tiles.push({ x: x, y: y, type: type >>> 0 });
        }
      }
    }
    return {
      format: 'hive-map-v1',
      name: map.name,
      width: map.width,
      height: map.height,
      defaultTile: map.defaultTile,
      start: tileCenter(startTile.x, startTile.y),
      tiles: tiles,
      objects: objects.map(function (o) {
        return { id: o.id, type: o.type >>> 0, x: o.x, y: o.y };
      }),
    };
  }

  function centerCamera() {
    if (!map) return;
    resizeCanvas();
    const tw = map.width * BASE_TILE * camera.zoom;
    const th = map.height * BASE_TILE * camera.zoom;
    camera.x = (canvas.width / (window.devicePixelRatio || 1) - tw) / 2;
    camera.y = (canvas.height / (window.devicePixelRatio || 1) - th) / 2;
  }

  // ── Undo / redo ──────────────────────────────────────────────────────
  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateChrome();
  }

  function beginStroke(kind) {
    strokeChanges = { kind: kind, tiles: [], objects: [], start: null };
  }

  function endStroke() {
    if (!strokeChanges) return;
    const has = strokeChanges.tiles.length || strokeChanges.objects.length || strokeChanges.start;
    if (has) pushUndo(strokeChanges);
    strokeChanges = null;
  }

  function recordTileChange(x, y, from, to) {
    if (!strokeChanges) return;
    strokeChanges.tiles.push({ x: x, y: y, from: from, to: to });
  }

  function applyTileChange(x, y, type, record) {
    if (!inBounds(x, y)) return;
    const prev = getTile(x, y);
    if (prev === type) return;
    setTileRaw(x, y, type);
    if (record && strokeChanges) recordTileChange(x, y, prev, type);
    markDirty();
  }

  function objectsOnTile(tx, ty) {
    return objects.filter(function (o) {
      return Math.floor(o.x) === tx && Math.floor(o.y) === ty;
    });
  }

  function placeObjectAt(tx, ty, type, record) {
    if (!inBounds(tx, ty) || type == null) return;
    const existing = objectsOnTile(tx, ty);
    const removed = existing.slice();
    objects = objects.filter(function (o) {
      return !(Math.floor(o.x) === tx && Math.floor(o.y) === ty);
    });
    const obj = { id: nextObjectId++, type: type >>> 0, x: tx + 0.5, y: ty + 0.5 };
    objects.push(obj);
    if (record && strokeChanges) {
      strokeChanges.objects.push({ op: 'replace', tx: tx, ty: ty, removed: removed, added: obj });
    }
    selectedObjectId = obj.id;
    markDirty();
  }

  function eraseObjectAt(tx, ty, record) {
    const existing = objectsOnTile(tx, ty);
    if (!existing.length) return;
    objects = objects.filter(function (o) {
      return !(Math.floor(o.x) === tx && Math.floor(o.y) === ty);
    });
    if (record && strokeChanges) {
      strokeChanges.objects.push({ op: 'erase', tx: tx, ty: ty, removed: existing, added: null });
    }
    if (selectedObjectId != null && existing.some(function (o) { return o.id === selectedObjectId; })) {
      selectedObjectId = null;
    }
    markDirty();
  }

  function setStartAt(tx, ty, record) {
    if (!inBounds(tx, ty)) return;
    if (startTile.x === tx && startTile.y === ty) return;
    const prev = { x: startTile.x, y: startTile.y };
    startTile = { x: tx, y: ty };
    if (record && strokeChanges) strokeChanges.start = { from: prev, to: { x: tx, y: ty } };
    markDirty();
    updateChrome();
  }

  function applyAction(action, reverse) {
    const tiles = action.tiles || [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      setTileRaw(t.x, t.y, reverse ? t.from : t.to);
    }
    const ops = action.objects || [];
    const walk = reverse ? ops.slice().reverse() : ops;
    for (let i = 0; i < walk.length; i++) {
      const op = walk[i];
      objects = objects.filter(function (o) {
        return !(Math.floor(o.x) === op.tx && Math.floor(o.y) === op.ty);
      });
      if (reverse) {
        if (op.removed && op.removed.length) {
          objects = objects.concat(op.removed);
        }
      } else if (op.added) {
        objects.push(op.added);
      } else if (op.op === 'erase') {
        // already removed
      }
    }
    if (action.start) {
      const s = reverse ? action.start.from : action.start.to;
      startTile = { x: s.x, y: s.y };
    }
    markDirty();
    updateProps();
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return;
    applyAction(action, true);
    redoStack.push(action);
    updateChrome();
  }

  function redo() {
    const action = redoStack.pop();
    if (!action) return;
    applyAction(action, false);
    undoStack.push(action);
    updateChrome();
  }

  // ── Tools ────────────────────────────────────────────────────────────
  function setTool(name) {
    tool = name;
    document.querySelectorAll('#tool-buttons [data-tool]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === name);
    });
    rectAnchor = null;
    updateBrushPreview();
    needsRedraw = true;
  }

  function floodFill(sx, sy, newType) {
    if (!inBounds(sx, sy) || newType == null) return;
    const target = getTile(sx, sy);
    if (target === newType) return;
    beginStroke('fill');
    const stack = [[sx, sy]];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      const x = cur[0];
      const y = cur[1];
      const k = tileKey(x, y);
      if (seen.has(k) || !inBounds(x, y)) continue;
      if (getTile(x, y) !== target) continue;
      seen.add(k);
      applyTileChange(x, y, newType, true);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    endStroke();
  }

  function paintRect(x0, y0, x1, y1, type) {
    const minX = Math.max(0, Math.min(x0, x1));
    const maxX = Math.min(map.width - 1, Math.max(x0, x1));
    const minY = Math.max(0, Math.min(y0, y1));
    const maxY = Math.min(map.height - 1, Math.max(y0, y1));
    beginStroke('rect');
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        applyTileChange(x, y, type, true);
      }
    }
    endStroke();
  }

  function applyToolAt(tx, ty, isDrag) {
    if (!map || !inBounds(tx, ty)) return;
    if (tool === 'tile') {
      if (selectedTileType == null) return;
      if (!painting) beginStroke('paint');
      painting = true;
      applyTileChange(tx, ty, selectedTileType >>> 0, true);
    } else if (tool === 'erase') {
      if (!painting) beginStroke('erase');
      painting = true;
      if (objectsOnTile(tx, ty).length) eraseObjectAt(tx, ty, true);
      else applyTileChange(tx, ty, -1, true);
    } else if (tool === 'object') {
      if (isDrag) return;
      if (selectedObjectType == null) return;
      beginStroke('object');
      placeObjectAt(tx, ty, selectedObjectType, true);
      endStroke();
    } else if (tool === 'start') {
      if (isDrag) return;
      beginStroke('start');
      setStartAt(tx, ty, true);
      endStroke();
    } else if (tool === 'fill') {
      if (isDrag) return;
      if (selectedTileType == null) return;
      floodFill(tx, ty, selectedTileType >>> 0);
    } else if (tool === 'select') {
      if (isDrag) return;
      selectedCell = { x: tx, y: ty };
      const onTile = objectsOnTile(tx, ty);
      selectedObjectId = onTile.length ? onTile[onTile.length - 1].id : null;
      updateProps();
      needsRedraw = true;
    }
  }

  // ── Properties panel ─────────────────────────────────────────────────
  function updateProps() {
    if (!map || !selectedCell) {
      propsBody.innerHTML = '<p class="muted">Select a cell, tile, or object to inspect it.</p>';
      return;
    }
    const tx = selectedCell.x;
    const ty = selectedCell.y;
    const type = getTile(tx, ty);
    const tileDef = type >= 0 ? catalog.tileByType[String(type)] : null;
    const onTile = objectsOnTile(tx, ty);
    const isStart = startTile.x === tx && startTile.y === ty;
    let html = '';
    html += propRow('Coordinates', '(' + tx + ', ' + ty + ')');
    html += propRow('Start tile', isStart ? 'Yes' : 'No');
    if (type >= 0) {
      html += propRow('Tile name', tileDef ? (tileDef.id || '—') : '(unknown)');
      html += propRow('Tile type', hexType(type) + ' (' + type + ')');
      if (tileDef) {
        html += propRow('Bucket', tileDef.tileBucket || '—');
        html += propRow('NoWalk', tileDef.noWalk ? 'Yes' : 'No');
      }
    } else {
      html += propRow('Tile', '(empty)');
    }
    if (onTile.length) {
      onTile.forEach(function (o, idx) {
        const def = catalog.objectByType[String(o.type)];
        html += '<div style="margin-top:10px;color:var(--text-muted);font-size:11px;text-transform:uppercase;">Object '
          + (idx + 1) + '</div>';
        html += propRow('Name', def ? (def.displayId || def.id) : '(unknown)');
        html += propRow('Type', hexType(o.type) + ' (' + o.type + ')');
        html += propRow('Instance id', String(o.id));
        html += propRow('World pos', o.x.toFixed(2) + ', ' + o.y.toFixed(2));
        if (def) {
          html += propRow('Class', def.objectClass || '—');
          html += propRow('Category', def.category || '—');
          html += propRow('OccupySquare', def.occupySquare ? 'Yes' : 'No');
        }
      });
    } else {
      html += propRow('Object', '(none)');
    }
    propsBody.innerHTML = html;
  }

  function propRow(k, v) {
    return '<div class="row"><span class="k">' + escapeHtml(k)
      + '</span><span class="v">' + escapeHtml(String(v)) + '</span></div>';
  }

  // ── Camera / rendering ───────────────────────────────────────────────
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsRedraw = true;
  }

  function screenToWorld(sx, sy) {
    const ts = BASE_TILE * camera.zoom;
    return {
      x: (sx - camera.x) / ts,
      y: (sy - camera.y) / ts,
    };
  }

  function canvasPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function tileColor(type) {
    // Deterministic fallback color when texture missing (viewer-style).
    const n = (type * 2654435761) >>> 0;
    const r = 40 + (n & 0x7f);
    const g = 40 + ((n >> 8) & 0x7f);
    const b = 40 + ((n >> 16) & 0x7f);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function render() {
    needsRedraw = false;
    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const cssH = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = false;

    if (!map || !tileGrid) return;

    const ts = BASE_TILE * camera.zoom;
    const x0 = Math.max(0, Math.floor(-camera.x / ts) - 1);
    const y0 = Math.max(0, Math.floor(-camera.y / ts) - 1);
    const x1 = Math.min(map.width - 1, Math.ceil((cssW - camera.x) / ts) + 1);
    const y1 = Math.min(map.height - 1, Math.ceil((cssH - camera.y) / ts) + 1);

    // Map boundary fill
    ctx.fillStyle = '#05080c';
    ctx.fillRect(camera.x, camera.y, map.width * ts, map.height * ts);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const type = tileGrid[y * map.width + x];
        const sx = camera.x + x * ts;
        const sy = camera.y + y * ts;
        if (type < 0) {
          ctx.fillStyle = ((x + y) & 1) ? '#121820' : '#0e141c';
          ctx.fillRect(sx, sy, ts, ts);
          continue;
        }
        ctx.fillStyle = tileColor(type);
        ctx.fillRect(sx, sy, ts, ts);
        const def = catalog.tileByType[String(type)];
        if (def && def.textureFile && def.textureIndex >= 0) {
          const tex = getTexture(def.textureFile, def.textureIndex);
          if (tex.loaded && tex.img) {
            ctx.drawImage(tex.img, sx, sy, ts, ts);
          }
        }
      }
    }

    // Objects (Y-sorted, like viewer)
    const visibleObjs = objects.filter(function (o) {
      const tx = Math.floor(o.x);
      const ty = Math.floor(o.y);
      return tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1;
    }).sort(function (a, b) { return a.y - b.y; });

    for (let i = 0; i < visibleObjs.length; i++) {
      const o = visibleObjs[i];
      const def = catalog.objectByType[String(o.type)];
      const sx = camera.x + (o.x - 0.5) * ts;
      const sy = camera.y + (o.y - 0.5) * ts;
      const sizeMul = def && def.size > 0 ? def.size / 100 : 1;
      const dw = ts * sizeMul;
      const dh = ts * sizeMul;
      const ox = sx + (ts - dw) / 2;
      const oy = sy + (ts - dh) / 2;
      if (def && def.textureFile && def.textureIndex >= 0) {
        const tex = getTexture(def.textureFile, def.textureIndex);
        if (tex.loaded && tex.img) {
          ctx.drawImage(tex.img, ox, oy, dw, dh);
        } else {
          ctx.fillStyle = 'rgba(220,180,80,0.7)';
          ctx.fillRect(ox, oy, dw, dh);
        }
      } else {
        ctx.fillStyle = 'rgba(220,180,80,0.7)';
        ctx.fillRect(ox, oy, dw, dh);
      }
      if (selectedObjectId === o.id) {
        ctx.strokeStyle = '#f0c14b';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox + 1, oy + 1, dw - 2, dh - 2);
      }
    }

    if (showGrid && camera.zoom >= 0.45) {
      ctx.strokeStyle = 'rgba(230,237,243,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) {
        const sx = camera.x + x * ts;
        ctx.moveTo(sx + 0.5, camera.y + y0 * ts);
        ctx.lineTo(sx + 0.5, camera.y + (y1 + 1) * ts);
      }
      for (let y = y0; y <= y1 + 1; y++) {
        const sy = camera.y + y * ts;
        ctx.moveTo(camera.x + x0 * ts, sy + 0.5);
        ctx.lineTo(camera.x + (x1 + 1) * ts, sy + 0.5);
      }
      ctx.stroke();
    }

    // Map boundary
    ctx.strokeStyle = '#40916c';
    ctx.lineWidth = 2;
    ctx.strokeRect(camera.x + 1, camera.y + 1, map.width * ts - 2, map.height * ts - 2);

    // Start marker
    {
      const sx = camera.x + startTile.x * ts;
      const sy = camera.y + startTile.y * ts;
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(sx + 2, sy + 2, ts - 4, ts - 4);
      ctx.beginPath();
      ctx.moveTo(sx + ts * 0.5, sy + ts * 0.2);
      ctx.lineTo(sx + ts * 0.5, sy + ts * 0.8);
      ctx.moveTo(sx + ts * 0.28, sy + ts * 0.42);
      ctx.lineTo(sx + ts * 0.5, sy + ts * 0.2);
      ctx.lineTo(sx + ts * 0.72, sy + ts * 0.42);
      ctx.stroke();
    }

    // Hover / selection
    if (hoverTile && inBounds(hoverTile.x, hoverTile.y)) {
      const sx = camera.x + hoverTile.x * ts;
      const sy = camera.y + hoverTile.y * ts;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx + 0.5, sy + 0.5, ts - 1, ts - 1);
    }
    if (selectedCell && inBounds(selectedCell.x, selectedCell.y)) {
      const sx = camera.x + selectedCell.x * ts;
      const sy = camera.y + selectedCell.y * ts;
      ctx.strokeStyle = '#f0c14b';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, ts - 2, ts - 2);
    }

    // Rect preview
    if (tool === 'rect' && rectAnchor && hoverTile) {
      const minX = Math.min(rectAnchor.x, hoverTile.x);
      const maxX = Math.max(rectAnchor.x, hoverTile.x);
      const minY = Math.min(rectAnchor.y, hoverTile.y);
      const maxY = Math.max(rectAnchor.y, hoverTile.y);
      ctx.fillStyle = 'rgba(64,145,108,0.25)';
      ctx.fillRect(
        camera.x + minX * ts,
        camera.y + minY * ts,
        (maxX - minX + 1) * ts,
        (maxY - minY + 1) * ts
      );
    }
  }

  function loop() {
    if (needsRedraw) render();
    requestAnimationFrame(loop);
  }

  // ── Pointer / keyboard ───────────────────────────────────────────────
  function updateCursorInfo(tx, ty) {
    if (!map || tx == null || !inBounds(tx, ty)) {
      cursorInfo.textContent = '—';
      return;
    }
    const type = getTile(tx, ty);
    const tileName = type >= 0
      ? ((catalog.tileByType[String(type)] || {}).id || hexType(type))
      : 'empty';
    cursorInfo.textContent = '(' + tx + ', ' + ty + ') · ' + tileName;
  }

  canvas.addEventListener('pointerdown', function (evt) {
    if (!map) return;
    canvas.setPointerCapture(evt.pointerId);
    const pt = canvasPoint(evt);
    const world = screenToWorld(pt.x, pt.y);
    const tx = Math.floor(world.x);
    const ty = Math.floor(world.y);

    if (evt.button === 1 || evt.button === 2 || (evt.button === 0 && spaceDown)) {
      panning = true;
      panLast = { x: pt.x, y: pt.y };
      return;
    }
    if (evt.button !== 0) return;

    if (tool === 'rect') {
      if (!inBounds(tx, ty)) return;
      if (!rectAnchor) {
        rectAnchor = { x: tx, y: ty };
        hoverTile = { x: tx, y: ty };
        needsRedraw = true;
      } else {
        if (selectedTileType == null) {
          toast('Select a tile from the catalog first', 'warn');
          rectAnchor = null;
          return;
        }
        paintRect(rectAnchor.x, rectAnchor.y, tx, ty, selectedTileType >>> 0);
        rectAnchor = null;
      }
      return;
    }

    applyToolAt(tx, ty, false);
    if (tool === 'tile' || tool === 'erase') painting = true;
    selectedCell = inBounds(tx, ty) ? { x: tx, y: ty } : selectedCell;
    updateProps();
  });

  canvas.addEventListener('pointermove', function (evt) {
    const pt = canvasPoint(evt);
    if (panning && panLast) {
      camera.x += pt.x - panLast.x;
      camera.y += pt.y - panLast.y;
      panLast = { x: pt.x, y: pt.y };
      needsRedraw = true;
      return;
    }
    if (!map) return;
    const world = screenToWorld(pt.x, pt.y);
    const tx = Math.floor(world.x);
    const ty = Math.floor(world.y);
    const next = inBounds(tx, ty) ? { x: tx, y: ty } : null;
    if (!hoverTile || !next || hoverTile.x !== next.x || hoverTile.y !== next.y) {
      hoverTile = next;
      updateCursorInfo(next && next.x, next && next.y);
      needsRedraw = true;
    }
    if (painting && (tool === 'tile' || tool === 'erase') && next) {
      applyToolAt(next.x, next.y, true);
    }
  });

  function endPointer(evt) {
    if (panning) {
      panning = false;
      panLast = null;
    }
    if (painting) {
      painting = false;
      endStroke();
    }
    try { canvas.releasePointerCapture(evt.pointerId); } catch (_) { /* ignore */ }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('wheel', function (evt) {
    evt.preventDefault();
    if (!map) return;
    const pt = canvasPoint(evt);
    const before = screenToWorld(pt.x, pt.y);
    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    camera.zoom = Math.max(0.2, Math.min(4, camera.zoom * factor));
    const ts = BASE_TILE * camera.zoom;
    camera.x = pt.x - before.x * ts;
    camera.y = pt.y - before.y * ts;
    updateChrome();
    needsRedraw = true;
  }, { passive: false });

  window.addEventListener('keydown', function (evt) {
    if (evt.code === 'Space') spaceDown = true;
    const meta = evt.ctrlKey || evt.metaKey;
    const tag = (evt.target && evt.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (meta && (evt.key === 's' || evt.key === 'S')) {
        evt.preventDefault();
        saveMap(false);
      }
      return;
    }
    if (meta && (evt.key === 'z' || evt.key === 'Z')) {
      evt.preventDefault();
      if (evt.shiftKey) redo(); else undo();
      return;
    }
    if (meta && (evt.key === 'y' || evt.key === 'Y')) { evt.preventDefault(); redo(); return; }
    if (meta && (evt.key === 's' || evt.key === 'S')) { evt.preventDefault(); saveMap(false); return; }
    if (meta && (evt.key === 'n' || evt.key === 'N')) { evt.preventDefault(); openNewDialog(); return; }
    if (meta && (evt.key === 'o' || evt.key === 'O')) { evt.preventDefault(); openOpenDialog(); return; }
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      if (selectedCell) {
        beginStroke('erase');
        eraseObjectAt(selectedCell.x, selectedCell.y, true);
        applyTileChange(selectedCell.x, selectedCell.y, -1, true);
        endStroke();
        updateProps();
      }
      return;
    }
    const key = evt.key.toLowerCase();
    if (key === 'v') setTool('select');
    else if (key === 't') setTool('tile');
    else if (key === 'o') setTool('object');
    else if (key === 'e') setTool('erase');
    else if (key === 's' && !meta) setTool('start');
    else if (key === 'f') setTool('fill');
    else if (key === 'r') setTool('rect');
    else if (key === 'g') {
      showGrid = !showGrid;
      document.getElementById('toggle-grid').checked = showGrid;
      needsRedraw = true;
    }
  });

  window.addEventListener('keyup', function (evt) {
    if (evt.code === 'Space') spaceDown = false;
  });

  // ── File / dialogs ───────────────────────────────────────────────────
  function parseDefaultTile(raw) {
    const s = String(raw || '').trim();
    if (!s) return -1;
    if (/^0x/i.test(s)) {
      const n = parseInt(s, 16);
      return Number.isFinite(n) ? n : NaN;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function openNewDialog() {
    dlgNew.showModal();
  }

  dlgNew.addEventListener('close', function () {
    if (dlgNew.returnValue !== 'ok') return;
    const fd = new FormData(document.getElementById('form-new'));
    const name = String(fd.get('name') || 'Untitled Map').trim();
    const width = Number(fd.get('width'));
    const height = Number(fd.get('height'));
    const defaultTile = parseDefaultTile(fd.get('defaultTile'));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 512) {
      toast('Invalid map dimensions (1–512)', 'error');
      return;
    }
    if (Number.isNaN(defaultTile)) {
      toast('Invalid default tile type', 'error');
      return;
    }
    fetch('/api/maps/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, width: width, height: height, defaultTile: defaultTile }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'Failed to create map');
        loadMapDocument(res.j.map, null);
        dirty = true;
        updateChrome();
        toast('Created ' + width + '×' + height + ' map');
      })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  async function openOpenDialog() {
    openSelection = null;
    btnOpenConfirm.disabled = true;
    openList.innerHTML = '<div class="asset-status">Loading…</div>';
    dlgOpen.showModal();
    try {
      const res = await fetch('/api/maps');
      const data = await res.json();
      openList.innerHTML = '';
      if (!data.maps || !data.maps.length) {
        openList.innerHTML = '<div class="asset-status">No saved maps yet</div>';
      } else {
        data.maps.forEach(function (m) {
          const el = document.createElement('div');
          el.className = 'open-item';
          el.innerHTML = '<div class="name">' + escapeHtml(m.name) + '</div>'
            + '<div class="sub">' + escapeHtml(m.file) + ' · '
            + (m.width || '?') + '×' + (m.height || '?') + '</div>';
          el.addEventListener('click', function () {
            openList.querySelectorAll('.open-item').forEach(function (n) { n.classList.remove('selected'); });
            el.classList.add('selected');
            openSelection = m.file;
            btnOpenConfirm.disabled = false;
          });
          openList.appendChild(el);
        });
      }
    } catch (err) {
      openList.innerHTML = '<div class="asset-status">Failed to list maps</div>';
    }
  }

  dlgOpen.addEventListener('close', function () {
    if (dlgOpen.returnValue !== 'ok' || !openSelection) return;
    fetch('/api/maps/' + encodeURIComponent(openSelection))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'Failed to open');
        loadMapDocument(res.j.map, res.j.file);
        toast('Opened ' + res.j.file);
      })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  openFileInput.addEventListener('change', function () {
    const file = openFileInput.files && openFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const doc = JSON.parse(String(reader.result));
        loadMapDocument(doc, file.name);
        dirty = true;
        dlgOpen.close();
        toast('Loaded local file ' + file.name);
      } catch (err) {
        toast('Invalid map JSON: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  });

  function openSaveAsDialog() {
    if (!map) return;
    const input = document.querySelector('#form-save-as input[name="file"]');
    input.value = (mapFile || map.name || 'untitled').replace(/\.json$/i, '');
    dlgSaveAs.showModal();
  }

  dlgSaveAs.addEventListener('close', function () {
    if (dlgSaveAs.returnValue !== 'ok') return;
    const fd = new FormData(document.getElementById('form-save-as'));
    const file = String(fd.get('file') || '').trim();
    const overwrite = !!fd.get('overwrite');
    saveMapToServer(file, overwrite);
  });

  async function saveMapToServer(fileName, overwrite) {
    if (!map) {
      toast('No map to save', 'warn');
      return;
    }
    let file = fileName || mapFile;
    if (!file) {
      openSaveAsDialog();
      return;
    }
    if (!/\.json$/i.test(file)) file += '.json';
    const doc = buildMapDocument();
    try {
      const res = await fetch('/api/maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: file,
          map: doc,
          overwrite: overwrite || (mapFile === file),
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast('Map exists — use Save As and enable overwrite', 'warn');
        return;
      }
      if (!res.ok) {
        const msgs = ((data.validation && data.validation.errors) || []).concat(
          (data.validation && data.validation.warnings) || []
        );
        throw new Error(msgs.join('; ') || data.error || 'Save failed');
      }
      mapFile = data.file;
      dirty = false;
      updateChrome();
      const warns = (data.validation && data.validation.warnings) || [];
      if (warns.length) toast('Saved with warnings: ' + warns.slice(0, 3).join('; '), 'warn');
      else toast('Saved ' + data.file);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function saveMap(forcePrompt) {
    if (!map) {
      toast('No map to save', 'warn');
      return;
    }
    if (forcePrompt || !mapFile) {
      openSaveAsDialog();
      return;
    }
    saveMapToServer(mapFile, true);
  }

  // ── Wire UI ──────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', openNewDialog);
  document.getElementById('btn-empty-new').addEventListener('click', openNewDialog);
  document.getElementById('btn-open').addEventListener('click', openOpenDialog);
  document.getElementById('btn-empty-open').addEventListener('click', openOpenDialog);
  document.getElementById('btn-save').addEventListener('click', function () { saveMap(false); });
  document.getElementById('btn-save-as').addEventListener('click', function () { saveMap(true); });
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.getElementById('btn-zoom-in').addEventListener('click', function () {
    camera.zoom = Math.min(4, camera.zoom * 1.15);
    updateChrome();
    needsRedraw = true;
  });
  document.getElementById('btn-zoom-out').addEventListener('click', function () {
    camera.zoom = Math.max(0.2, camera.zoom / 1.15);
    updateChrome();
    needsRedraw = true;
  });
  document.getElementById('btn-zoom-reset').addEventListener('click', function () {
    camera.zoom = 1;
    centerCamera();
    updateChrome();
    needsRedraw = true;
  });
  document.getElementById('toggle-grid').addEventListener('change', function (e) {
    showGrid = !!e.target.checked;
    needsRedraw = true;
  });

  document.querySelectorAll('#tool-buttons [data-tool]').forEach(function (btn) {
    btn.addEventListener('click', function () { setTool(btn.getAttribute('data-tool')); });
  });

  document.querySelectorAll('.asset-tabs [data-catalog]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      catalogSection = btn.getAttribute('data-catalog');
      document.querySelectorAll('.asset-tabs [data-catalog]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      rebuildFilterOptions();
      rebuildFiltered();
    });
  });

  assetSearch.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(rebuildFiltered, 120);
  });
  assetFilter.addEventListener('change', rebuildFiltered);
  assetList.addEventListener('click', function (evt) {
    const row = evt.target.closest('.asset-row');
    if (!row) return;
    selectAsset(Number(row.dataset.index));
  });

  window.addEventListener('resize', function () {
    resizeCanvas();
    needsRedraw = true;
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────
  async function boot() {
    resizeCanvas();
    updateChrome();
    loop();
    try {
      const res = await fetch('/api/catalog');
      if (!res.ok) throw new Error('Catalog HTTP ' + res.status);
      const data = await res.json();
      catalog.objects = data.objects || [];
      catalog.tiles = data.tiles || [];
      catalog.objectByType = {};
      catalog.tileByType = {};
      catalog.objects.forEach(function (o) { catalog.objectByType[String(o.type)] = o; });
      catalog.tiles.forEach(function (t) { catalog.tileByType[String(t.type)] = t; });
      rebuildFilterOptions();
      rebuildFiltered();
      toast('Catalog loaded (' + catalog.tiles.length + ' tiles, ' + catalog.objects.length + ' objects)');
    } catch (err) {
      assetStatus.textContent = 'Failed to load catalog';
      toast('Failed to load catalog: ' + err.message, 'error');
    }
  }

  boot();
})();

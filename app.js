/* War of Dots — Nations campaign map frontend.
 * Static site; all data comes from the public snapshot API. */
"use strict";

const API = "https://wod-nations-map.moreofdots.workers.dev";
const MASK_URL = "assets/playable-mask.bitset.zlib";
const TERRAIN_URL = "assets/world_map.png";

const RED_RGB = [217, 65, 65];
const BLUE_RGB = [63, 108, 224];
const CACHE_LIMIT = 30; // decoded overlay canvases kept in memory
const POLL_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  errorBanner: $("error-banner"),
  redPct: $("red-pct"),
  bluePct: $("blue-pct"),
  redCount: $("red-count"),
  blueCount: $("blue-count"),
  barRed: $("bar-red"),
  barBlue: $("bar-blue"),
  viewport: $("viewport"),
  stage: $("stage"),
  canvas: $("map-canvas"),
  objectiveOverlay: $("objective-overlay"),
  loading: $("map-loading"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
  overlayAlpha: $("overlay-alpha"),
  showObjectives: $("show-objectives"),
  playBtn: $("play-btn"),
  playSpeed: $("play-speed"),
  slider: $("timeline-slider"),
  timelineLabel: $("timeline-label"),
  timelinePos: $("timeline-pos"),
  loadOlder: $("load-older"),
  newsText: $("news-text"),
};

const state = {
  rows: [], // chronological (oldest first)
  nextBefore: null,
  index: -1,
  playing: false,
  playTimer: null,
  renderToken: 0,
  mask: null,
  terrain: null,
  cache: new Map(), // mapHash -> Promise<{canvas, red, blue}>
  current: null, // {row, entry}
  overlayAlpha: 0.55,
  health: null,
  view: { scale: 1, tx: 0, ty: 0, fit: 1 },
};

/* ---------- Fetch and decode helpers ---------- */

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

async function inflate(resp) {
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const stream = resp.body.pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bit(bytes, index) {
  return (bytes[index >> 3] >> (index & 7)) & 1;
}

/* Compact encoding: one faction bit per playable pixel, LSB-first, row-major.
 * In the live game a set bit is RED territory (the API doc has it reversed). */
function buildCompact(row, ownership, mask) {
  const total = row.width * row.height;
  const rgba = new Uint8ClampedArray(total * 4);
  let ownershipIndex = 0;
  let red = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (!bit(mask, pixel)) continue; // non-playable stays transparent
    const isRed = bit(ownership, ownershipIndex);
    ownershipIndex += 1;
    const rgb = isRed ? RED_RGB : BLUE_RGB;
    red += isRed;
    const o = pixel * 4;
    rgba[o] = rgb[0];
    rgba[o + 1] = rgb[1];
    rgba[o + 2] = rgb[2];
    rgba[o + 3] = 255;
  }
  if (ownershipIndex !== row.playablePixels) {
    throw new Error(`Ownership length mismatch: decoded ${ownershipIndex} pixels.`);
  }
  return { rgba, red, blue: ownershipIndex - red };
}

/* Legacy encoding: one byte per pixel. 1 = red, 0 = blue, 255 = non-playable
 * (same faction flip as the compact encoding, so both render consistently). */
function buildLegacy(row, raw) {
  const total = row.width * row.height;
  if (raw.length !== total) throw new Error("Legacy ownership length mismatch.");
  const rgba = new Uint8ClampedArray(total * 4);
  let red = 0;
  let blue = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const value = raw[pixel];
    if (value !== 0 && value !== 1) continue;
    const rgb = value === 1 ? RED_RGB : BLUE_RGB;
    if (value === 1) red += 1;
    else blue += 1;
    const o = pixel * 4;
    rgba[o] = rgb[0];
    rgba[o + 1] = rgb[1];
    rgba[o + 2] = rgb[2];
    rgba[o + 3] = 255;
  }
  return { rgba, red, blue };
}

/* Decoded overlays are cached as promises keyed by immutable mapHash,
 * so concurrent prefetch and scrub requests share one download. */
function getDecoded(row) {
  const cached = state.cache.get(row.mapHash);
  if (cached) {
    state.cache.delete(row.mapHash);
    state.cache.set(row.mapHash, cached); // LRU refresh
    return cached;
  }
  const promise = (async () => {
    const bytes = await inflate(await fetch(new URL(row.mapUrl, API)));
    let built;
    if (row.encoding === "playable-bitset-zlib-v1") {
      built = buildCompact(row, bytes, state.mask);
    } else if (row.encoding === "raw-u8-zlib-v1") {
      built = buildLegacy(row, bytes);
    } else {
      throw new Error(`Unsupported map encoding: ${row.encoding}`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = row.width;
    canvas.height = row.height;
    canvas.getContext("2d").putImageData(new ImageData(built.rgba, row.width, row.height), 0, 0);
    return { canvas, red: built.red, blue: built.blue };
  })();
  promise.catch(() => state.cache.delete(row.mapHash));
  state.cache.set(row.mapHash, promise);
  while (state.cache.size > CACHE_LIMIT) {
    state.cache.delete(state.cache.keys().next().value);
  }
  return promise;
}

/* ---------- Rendering ---------- */

function drawMap() {
  if (!state.current) return;
  const { row, entry } = state.current;
  const ctx = els.canvas.getContext("2d");
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.drawImage(state.terrain, 0, 0);
  ctx.globalAlpha = state.overlayAlpha;
  ctx.drawImage(entry.canvas, 0, 0);
  ctx.globalAlpha = 1;
  drawObjectives(row.objectives);
}

function drawObjectives(objectives) {
  els.objectiveOverlay.replaceChildren();
  if (!els.showObjectives.checked || !Array.isArray(objectives)) return;

  // Objective pairs are [y, x]: x values exceed the map height of 1080.
  // The first objective is the Blue Republic's, the second the Red Empire's.
  const colors = ["#3f6ce0", "#d94141"];
  const svgNamespace = "http://www.w3.org/2000/svg";
  objectives.forEach((objective, index) => {
    if (!Array.isArray(objective)
        || !Number.isFinite(objective[0])
        || !Number.isFinite(objective[1])) return;
    const star = document.createElementNS(svgNamespace, "path");
    star.setAttribute("class", "objective-marker");
    star.setAttribute("d", starPath(objective[1], objective[0], 14));
    star.setAttribute("fill", colors[index % colors.length]);
    els.objectiveOverlay.append(star);
  });
}

function starPath(x, y, radius) {
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(`${x + Math.cos(angle) * r},${y + Math.sin(angle) * r}`);
  }
  return `M${points.join("L")}Z`;
}

function updateObjectiveView() {
  const { scale, tx, ty } = state.view;
  const rect = els.viewport.getBoundingClientRect();
  if (scale <= 0 || rect.width <= 0 || rect.height <= 0) return;
  els.objectiveOverlay.setAttribute(
    "viewBox",
    `${-tx / scale} ${-ty / scale} ${rect.width / scale} ${rect.height / scale}`,
  );
}

function formatPct(value) {
  return `${(value * 100).toFixed(3)}%`;
}

function updateStats(entry) {
  const claimed = entry.red + entry.blue;
  if (claimed === 0) return;
  const redShare = entry.red / claimed;
  els.redPct.textContent = formatPct(redShare);
  els.bluePct.textContent = formatPct(1 - redShare);
  els.redCount.textContent = `${entry.red.toLocaleString()} px`;
  els.blueCount.textContent = `${entry.blue.toLocaleString()} px`;
  els.barRed.style.width = `${redShare * 100}%`;
  els.barBlue.style.width = `${(1 - redShare) * 100}%`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

function updatePanels(row) {
  const captured = new Date(row.capturedAt * 1000);
  els.timelineLabel.textContent = timeFormat.format(captured);
  els.timelinePos.textContent = `Snapshot ${state.index + 1} of ${state.rows.length}`;
  if (els.newsText.textContent !== row.news) els.newsText.textContent = row.news || "No dispatches.";
}

async function setIndex(rawIndex) {
  if (state.rows.length === 0) return;
  const index = Math.max(0, Math.min(state.rows.length - 1, rawIndex));
  state.index = index;
  const row = state.rows[index];
  els.slider.value = String(index);
  updatePanels(row);
  const token = ++state.renderToken;
  const loadingTimer = setTimeout(() => { els.loading.hidden = false; }, 150);
  try {
    const entry = await getDecoded(row);
    if (token !== state.renderToken) return;
    state.current = { row, entry };
    drawMap();
    updateStats(entry);
    clearError();
  } catch (error) {
    if (token === state.renderToken) showError(`Could not load snapshot #${row.id}: ${error.message}`);
  } finally {
    clearTimeout(loadingTimer);
    if (token === state.renderToken) els.loading.hidden = true;
  }
}

function prefetch(fromIndex, count) {
  for (let i = fromIndex; i < Math.min(fromIndex + count, state.rows.length); i += 1) {
    getDecoded(state.rows[i]).catch(() => {});
  }
}

/* ---------- Timeline playback ---------- */

function setPlaying(playing) {
  state.playing = playing;
  els.playBtn.textContent = playing ? "⏸" : "▶";
  els.playBtn.title = playing ? "Pause (Space)" : "Play timeline (Space)";
  clearTimeout(state.playTimer);
  if (playing) playbackTick();
}

async function playbackTick() {
  if (!state.playing) return;
  const next = state.index + 1;
  if (next >= state.rows.length) {
    setPlaying(false);
    return;
  }
  await setIndex(next);
  prefetch(next + 1, 3);
  if (state.playing) {
    state.playTimer = setTimeout(playbackTick, Number(els.playSpeed.value));
  }
}

function togglePlay() {
  if (!state.playing && state.index >= state.rows.length - 1) {
    setIndex(0).then(() => setPlaying(true));
    return;
  }
  setPlaying(!state.playing);
}

async function loadOlder() {
  if (!state.nextBefore) return;
  els.loadOlder.disabled = true;
  try {
    const page = await fetchJSON(`${API}/v1/timeline?before=${state.nextBefore}&limit=336`);
    const older = page.rows.slice().reverse();
    state.rows = older.concat(state.rows);
    state.nextBefore = page.nextBefore;
    state.index += older.length;
    els.slider.max = String(state.rows.length - 1);
    els.slider.value = String(state.index);
    updatePanels(state.rows[state.index]);
    els.loadOlder.hidden = !state.nextBefore;
  } catch (error) {
    showError(`Could not load older snapshots: ${error.message}`);
  } finally {
    els.loadOlder.disabled = false;
  }
}

/* ---------- Live updates ---------- */

function renderStatus() {
  if (!state.health) return;
  const { latestCapturedAt, stale } = state.health;
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - latestCapturedAt) / 60));
  const ago = minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  els.statusDot.className = `status-dot ${stale ? "stale" : "live"}`;
  els.statusText.textContent = stale ? `Stale — last capture ${ago}` : `Live — updated ${ago}`;
}

async function refreshLive() {
  try {
    const [health, latest] = await Promise.all([
      fetchJSON(`${API}/health`),
      fetchJSON(`${API}/v1/snapshots/latest`),
    ]);
    state.health = health;
    renderStatus();
    const lastRow = state.rows[state.rows.length - 1];
    if (lastRow && latest.id !== lastRow.id && latest.capturedAt > lastRow.capturedAt) {
      const wasAtEnd = state.index === state.rows.length - 1;
      state.rows.push(latest);
      els.slider.max = String(state.rows.length - 1);
      if (wasAtEnd && !state.playing) setIndex(state.rows.length - 1);
      else updatePanels(state.rows[state.index]);
    }
  } catch {
    /* transient poll failure — keep showing the last known status */
  }
}

/* ---------- Errors ---------- */

function showError(message) {
  els.errorBanner.textContent = `⚠ ${message}`;
  els.errorBanner.hidden = false;
  els.statusDot.className = "status-dot error";
}

function clearError() {
  els.errorBanner.hidden = true;
}

/* ---------- Pan and zoom ---------- */

const MAP_W = 1920;
const MAP_H = 1080;

function applyView() {
  const { scale, tx, ty } = state.view;
  els.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  updateObjectiveView();
}

function fitView() {
  const rect = els.viewport.getBoundingClientRect();
  const fit = Math.min(rect.width / MAP_W, rect.height / MAP_H);
  state.view.fit = fit;
  state.view.scale = fit;
  state.view.tx = (rect.width - MAP_W * fit) / 2;
  state.view.ty = (rect.height - MAP_H * fit) / 2;
  applyView();
}

function clampView() {
  const rect = els.viewport.getBoundingClientRect();
  const view = state.view;
  const w = MAP_W * view.scale;
  const h = MAP_H * view.scale;
  // Keep the map covering the viewport (or centered when smaller).
  view.tx = w <= rect.width
    ? (rect.width - w) / 2
    : Math.min(0, Math.max(rect.width - w, view.tx));
  view.ty = h <= rect.height
    ? (rect.height - h) / 2
    : Math.min(0, Math.max(rect.height - h, view.ty));
}

function zoomAt(clientX, clientY, factor) {
  const rect = els.viewport.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const view = state.view;
  const nextScale = Math.max(view.fit, Math.min(view.fit * 12, view.scale * factor));
  const applied = nextScale / view.scale;
  view.tx = px - (px - view.tx) * applied;
  view.ty = py - (py - view.ty) * applied;
  view.scale = nextScale;
  clampView();
  applyView();
}

function zoomCenter(factor) {
  const rect = els.viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function setupViewport() {
  const pointers = new Map();
  let pinchDistance = 0;

  els.viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0016));
  }, { passive: false });

  els.viewport.addEventListener("pointerdown", (event) => {
    els.viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
    els.viewport.classList.add("dragging");
  });

  els.viewport.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);
    if (pointers.size === 1) {
      state.view.tx += current.x - previous.x;
      state.view.ty += current.y - previous.y;
      clampView();
      applyView();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, distance / pinchDistance);
      }
      pinchDistance = distance;
    }
  });

  const releasePointer = (event) => {
    pointers.delete(event.pointerId);
    pinchDistance = 0;
    if (pointers.size === 0) els.viewport.classList.remove("dragging");
  };
  els.viewport.addEventListener("pointerup", releasePointer);
  els.viewport.addEventListener("pointercancel", releasePointer);

  els.viewport.addEventListener("dblclick", fitView);
  els.zoomIn.addEventListener("click", () => zoomCenter(1.5));
  els.zoomOut.addEventListener("click", () => zoomCenter(1 / 1.5));
  els.zoomReset.addEventListener("click", fitView);

  new ResizeObserver(() => {
    const view = state.view;
    const atFit = Math.abs(view.scale - view.fit) < 0.001;
    const rect = els.viewport.getBoundingClientRect();
    view.fit = Math.min(rect.width / MAP_W, rect.height / MAP_H);
    if (atFit || view.scale < view.fit) fitView();
    else { clampView(); applyView(); }
  }).observe(els.viewport);
}

/* ---------- Wiring ---------- */

function setupControls() {
  els.slider.addEventListener("input", () => {
    setPlaying(false);
    setIndex(Number(els.slider.value));
  });
  els.playBtn.addEventListener("click", togglePlay);
  els.loadOlder.addEventListener("click", loadOlder);
  els.overlayAlpha.addEventListener("input", () => {
    state.overlayAlpha = Number(els.overlayAlpha.value) / 100;
    drawMap();
  });
  els.showObjectives.addEventListener("change", drawMap);

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowLeft") {
      setPlaying(false);
      setIndex(state.index - 1);
    } else if (event.key === "ArrowRight") {
      setPlaying(false);
      setIndex(state.index + 1);
    }
  });
}

async function loadTerrain() {
  const image = new Image();
  image.src = TERRAIN_URL;
  await image.decode();
  return image;
}

async function init() {
  if (typeof DecompressionStream === "undefined") {
    showError("This browser does not support DecompressionStream, which is needed to decode the map. Please use a current browser.");
    return;
  }
  setupViewport();
  setupControls();
  fitView();
  try {
    const [terrain, mask, timeline, health] = await Promise.all([
      loadTerrain(),
      (async () => inflate(await fetch(MASK_URL)))(),
      fetchJSON(`${API}/v1/timeline?limit=336`),
      fetchJSON(`${API}/health`),
    ]);
    state.terrain = terrain;
    state.mask = mask;
    state.health = health;
    renderStatus();
    state.rows = timeline.rows.slice().reverse();
    state.nextBefore = timeline.nextBefore;
    els.loadOlder.hidden = !state.nextBefore;
    if (state.rows.length === 0) {
      showError("No snapshots have been captured yet. Check back soon!");
      return;
    }
    els.slider.max = String(state.rows.length - 1);
    await setIndex(state.rows.length - 1);
    prefetch(Math.max(0, state.rows.length - 4), 3);
  } catch (error) {
    showError(`Could not reach the map service: ${error.message}`);
    return;
  }
  setInterval(refreshLive, POLL_MS);
  setInterval(renderStatus, 30 * 1000);
}

init();

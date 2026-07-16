/* War of Dots — Nations campaign map frontend. */
"use strict";

const API = "https://wod-nations-map.moreofdots.workers.dev";
const MASK_URL = "assets/playable-mask.bitset.zlib";
const TERRAIN_URL = "assets/world_map.png";
const CITY_DATA_URL = "assets/city-points.json";

const RED_RGB = [217, 65, 65];
const BLUE_RGB = [63, 108, 224];
const CACHE_LIMIT = 30; // decoded overlay canvases kept in memory
const POLL_MS = 5 * 60 * 1000;
const SESSION_KEY = "wod-nations-access-session";

let accessToken = readSessionToken();
let appStarted = false;

const $ = (id) => document.getElementById(id);

const els = {
  accessGate: $("access-gate"),
  accessForm: $("access-form"),
  accessCode: $("access-code"),
  accessSubmit: $("access-submit"),
  accessError: $("access-error"),
  logoutBtn: $("logout-btn"),
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
  battleCanvas: $("battle-overlay"),
  cityOverlay: $("city-overlay"),
  objectiveOverlay: $("objective-overlay"),
  regionOverlay: $("region-overlay"),
  loading: $("map-loading"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
  overlayAlpha: $("overlay-alpha"),
  showCities: $("show-cities"),
  showObjectives: $("show-objectives"),
  showPerimeters: $("show-perimeters"),
  regionSelect: $("region-select"),
  regionIntel: $("region-intel"),
  regionStatus: $("region-status"),
  regionStats: $("region-stats"),
  regionRedPixels: $("region-red-pixels"),
  regionBluePixels: $("region-blue-pixels"),
  regionRedCities: $("region-red-cities"),
  regionBlueCities: $("region-blue-cities"),
  regionObjectives: $("region-objectives"),
  playBtn: $("play-btn"),
  playSpeed: $("play-speed"),
  slider: $("timeline-slider"),
  timelineLabel: $("timeline-label"),
  timelinePos: $("timeline-pos"),
  loadOlder: $("load-older"),
  newsText: $("news-text"),
  chartStatus: $("chart-status"),
  chartWrap: $("chart-wrap"),
  chartSvg: $("chart-svg"),
  chartTooltip: $("chart-tooltip"),
  snapTbody: $("snap-tbody"),
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
  cityData: null,
  cityMarkers: [],
  cityOwnershipIndices: new Map(), // dimensions -> city index in compact ownership bitset
  cache: new Map(), // mapHash -> Promise<{canvas, red, blue}>
  stats: new Map(), // mapHash -> pixel and city counts for the chart and log
  current: null, // {row, entry}
  overlayAlpha: 0.55,
  health: null,
  view: { scale: 1, tx: 0, ty: 0, fit: 1 },
  region: { selecting: false, pointerId: null, start: null, bounds: null },
  renderedFronts: null,
  frontImage: null,
  frontGlowScale: null,
};

/* ---------- Fetch and decode helpers ---------- */

function readSessionToken() {
  try { return localStorage.getItem(SESSION_KEY) ?? ""; } catch { return ""; }
}

function saveSessionToken(token) {
  accessToken = token;
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage may be unavailable; the in-memory session still works */ }
}

function showAccessGate(message = "") {
  saveSessionToken("");
  document.body.classList.add("auth-locked");
  els.accessGate.hidden = false;
  els.accessError.textContent = message;
  els.accessError.hidden = !message;
  els.accessCode.value = "";
  setTimeout(() => els.accessCode.focus(), 0);
}

function hideAccessGate() {
  document.body.classList.remove("auth-locked");
  els.accessGate.hidden = true;
  els.accessError.hidden = true;
}

async function authenticatedFetch(url, init = {}) {
  const target = new URL(url, location.href);
  const headers = new Headers(init.headers);
  if (target.origin === new URL(API).origin && accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  const resp = await fetch(target, { ...init, headers });
  if (resp.status === 401 && target.origin === new URL(API).origin) {
    showAccessGate("Your access session expired. Enter the code again.");
  }
  return resp;
}

async function fetchJSON(url) {
  const resp = await authenticatedFetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${resp.status} for ${url}`);
  }
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

function sampleCityOwners(row, rgba) {
  const { worldSize, cities } = state.cityData;
  const scaleX = row.width / worldSize.width;
  const scaleY = row.height / worldSize.height;
  const owners = new Uint8Array(cities.length);
  cities.forEach(([x, y], index) => {
    const px = Math.min(row.width - 1, Math.max(0, Math.floor(x * scaleX)));
    const py = Math.min(row.height - 1, Math.max(0, Math.floor(y * scaleY)));
    const offset = (py * row.width + px) * 4;
    owners[index] = rgba[offset + 3] === 0 ? 255 : Number(rgba[offset] === RED_RGB[0]);
  });
  return owners;
}

function countCityOwners(owners) {
  let cityRed = 0;
  let cityBlue = 0;
  for (const owner of owners) {
    if (owner === 1) cityRed += 1;
    else if (owner === 0) cityBlue += 1;
  }
  return { cityRed, cityBlue };
}

function getCityOwnershipIndices(row) {
  const key = `${row.width}x${row.height}`;
  const cached = state.cityOwnershipIndices.get(key);
  if (cached) return cached;

  const { worldSize, cities } = state.cityData;
  const targets = new Map();
  const ownershipIndices = new Int32Array(cities.length).fill(-1);
  cities.forEach(([x, y], cityIndex) => {
    const px = Math.min(row.width - 1, Math.max(0, Math.floor((x * row.width) / worldSize.width)));
    const py = Math.min(row.height - 1, Math.max(0, Math.floor((y * row.height) / worldSize.height)));
    const pixel = py * row.width + px;
    const atPixel = targets.get(pixel);
    if (atPixel) atPixel.push(cityIndex);
    else targets.set(pixel, [cityIndex]);
  });

  let ownershipIndex = 0;
  for (let pixel = 0; pixel < row.width * row.height; pixel += 1) {
    const cityIndexes = targets.get(pixel);
    if (bit(state.mask, pixel)) {
      if (cityIndexes) {
        for (const cityIndex of cityIndexes) ownershipIndices[cityIndex] = ownershipIndex;
      }
      ownershipIndex += 1;
    }
  }
  state.cityOwnershipIndices.set(key, ownershipIndices);
  return ownershipIndices;
}

function countCompactCities(row, ownership) {
  const ownershipIndices = getCityOwnershipIndices(row);
  let cityRed = 0;
  let cityBlue = 0;
  for (const ownershipIndex of ownershipIndices) {
    if (ownershipIndex < 0) continue;
    if (bit(ownership, ownershipIndex)) cityRed += 1;
    else cityBlue += 1;
  }
  return { cityRed, cityBlue };
}

function countLegacyCities(row, ownership) {
  const { worldSize, cities } = state.cityData;
  let cityRed = 0;
  let cityBlue = 0;
  for (const [x, y] of cities) {
    const px = Math.min(row.width - 1, Math.max(0, Math.floor((x * row.width) / worldSize.width)));
    const py = Math.min(row.height - 1, Math.max(0, Math.floor((y * row.height) / worldSize.height)));
    const owner = ownership[py * row.width + px];
    if (owner === 1) cityRed += 1;
    else if (owner === 0) cityBlue += 1;
  }
  return { cityRed, cityBlue };
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

/* A front pixel is an enemy-owned conversion target touching the attacker's
 * territory. Encoded values store (pixel index * 2 + attacking faction), where
 * 1 is Red and 0 is Blue. Checking each edge once marks both sides of a front. */
function buildBattlefronts(row, rgba) {
  const total = row.width * row.height;
  const marked = new Uint8Array(total);

  function markOpposingPair(pixel, neighbor) {
    const offset = pixel * 4;
    const neighborOffset = neighbor * 4;
    if (rgba[offset + 3] === 0 || rgba[neighborOffset + 3] === 0) return;
    if (rgba[offset] === rgba[neighborOffset]) return;
    marked[pixel] = 1;
    marked[neighbor] = 1;
  }

  for (let y = 0; y < row.height; y += 1) {
    const rowStart = y * row.width;
    for (let x = 0; x < row.width; x += 1) {
      const pixel = rowStart + x;
      if (x + 1 < row.width) markOpposingPair(pixel, pixel + 1);
      if (y + 1 < row.height) markOpposingPair(pixel, pixel + row.width);
    }
  }

  let count = 0;
  for (const value of marked) count += value;
  const fronts = new Uint32Array(count);
  let frontIndex = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (!marked[pixel]) continue;
    const isRedTarget = rgba[pixel * 4] === RED_RGB[0];
    const attacker = isRedTarget ? 0 : 1;
    fronts[frontIndex] = pixel * 2 + attacker;
    frontIndex += 1;
  }
  return fronts;
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
    const bytes = await inflate(await authenticatedFetch(new URL(row.mapUrl, API)));
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
    const fronts = buildBattlefronts(row, built.rgba);
    const cityOwners = sampleCityOwners(row, built.rgba);
    setStat(row.mapHash, built.red, built.blue, countCityOwners(cityOwners));
    return { canvas, red: built.red, blue: built.blue, cityOwners, fronts };
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
  drawFighting(entry.fronts, row.width, row.height);
  drawCities(entry.cityOwners);
  drawObjectives(row.objectives, entry.fronts, row.width, row.height);
  renderRegionOutline();
}

function buildCityMarkers() {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const { worldSize, cities } = state.cityData;
  const fragment = document.createDocumentFragment();
  state.cityMarkers = cities.map(([x, y], index) => {
    const marker = document.createElementNS(svgNamespace, "use");
    marker.setAttribute("href", "#city-flag");
    marker.setAttribute(
      "transform",
      `translate(${(x * MAP_W) / worldSize.width} ${(y * MAP_H) / worldSize.height})`,
    );
    marker.setAttribute("class", "city-marker city-blue");
    marker.dataset.cityId = String(index);
    fragment.append(marker);
    return marker;
  });
  els.cityOverlay.append(fragment);
}

function drawCities(owners) {
  const visible = els.showCities.checked;
  els.cityOverlay.classList.toggle("is-hidden", !visible);
  if (!visible || !owners) return;
  state.cityMarkers.forEach((marker, index) => {
    const owner = owners[index];
    marker.style.display = owner === 255 ? "none" : "";
    marker.classList.toggle("city-red", owner === 1);
    marker.classList.toggle("city-blue", owner === 0);
  });
}

function objectivePerimeters(objectives, fronts, width, height) {
  return objectives.map(({ objective, index }) => {
    const perimeter = {
      index,
      x: objective[1],
      y: objective[0],
      faction: index % 2,
      distanceSquared: Infinity,
    };
    const distances = [];
    for (const encoded of fronts) {
      if ((encoded & 1) !== perimeter.faction) continue;
      const pixel = encoded >> 1;
      const x = ((pixel % width) * MAP_W) / width;
      const y = (Math.floor(pixel / width) * MAP_H) / height;
      const dx = x - perimeter.x;
      const dy = y - perimeter.y;
      distances.push(dx * dx + dy * dy);
    }
    distances.sort((a, b) => a - b);
    // Ignore the 50 closest pixels so isolated frontline specks do not collapse the perimeter.
    // Very small fronts still use their farthest available pixel instead of hiding the circle.
    perimeter.distanceSquared = distances[Math.min(50, distances.length - 1)] ?? Infinity;
    return perimeter;
  });
}

function createObjectivePerimeter(svgNamespace, index, faction) {
  const group = document.createElementNS(svgNamespace, "g");
  group.setAttribute("class", `objective-perimeter-group objective-perimeter-group-${faction}`);
  group.dataset.objectiveIndex = String(index);
  group.classList.add("is-snapping");
  const layers = [["ring", 0]];
  for (const [layer, radiusOffset] of layers) {
    const circle = document.createElementNS(svgNamespace, "circle");
    circle.setAttribute("class", `objective-perimeter objective-perimeter-${layer} objective-perimeter-${layer}-${faction}`);
    circle.dataset.radiusOffset = String(radiusOffset);
    group.append(circle);
  }
  return group;
}

function updateObjectivePerimeter(group, perimeter) {
  const x = String(perimeter.x);
  const y = String(perimeter.y);
  const locationChanged = group.dataset.objectiveX !== x || group.dataset.objectiveY !== y;
  if (locationChanged) group.classList.add("is-snapping");
  group.dataset.objectiveX = x;
  group.dataset.objectiveY = y;

  const radius = Math.sqrt(perimeter.distanceSquared);
  for (const circle of group.querySelectorAll("circle")) {
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    const radiusOffset = Number(circle.dataset.radiusOffset || 0);
    circle.style.setProperty("r", `${Math.max(0, radius + radiusOffset)}px`);
  }

  if (locationChanged) {
    // Commit the new center and radius together before restoring eased radius updates.
    group.getBoundingClientRect();
    group.classList.remove("is-snapping");
  }
}

function clearObjectiveGraphics() {
  for (const element of els.objectiveOverlay.querySelectorAll(".objective-marker, .objective-perimeter-group")) {
    element.remove();
  }
}

function drawObjectives(objectives, fronts, width, height) {
  for (const marker of els.objectiveOverlay.querySelectorAll(".objective-marker")) marker.remove();
  if (!Array.isArray(objectives)) {
    clearObjectiveGraphics();
    return;
  }
  const showMarkers = els.showObjectives.checked;
  const showPerimeters = els.showPerimeters.checked;
  if (!showMarkers && !showPerimeters) {
    clearObjectiveGraphics();
    return;
  }

  // Objective pairs are [y, x]: x values exceed the map height of 1080.
  // The first objective is the Blue Republic's, the second the Red Empire's.
  const colors = ["#3f6ce0", "#d94141"];
  const svgNamespace = "http://www.w3.org/2000/svg";
  const validObjectives = objectives
    .map((objective, index) => ({ objective, index }))
    .filter(({ objective }) => Array.isArray(objective)
      && Number.isFinite(objective[0])
      && Number.isFinite(objective[1]));

  if (showPerimeters) {
    const perimeters = objectivePerimeters(validObjectives, fronts, width, height);
    const existing = new Map(
      [...els.objectiveOverlay.querySelectorAll(".objective-perimeter-group")]
        .map((group) => [Number(group.dataset.objectiveIndex), group]),
    );
    const active = new Set();
    perimeters.forEach((perimeter) => {
      if (!Number.isFinite(perimeter.distanceSquared)) return;
      const faction = perimeter.faction === 1 ? "red" : "blue";
      let group = existing.get(perimeter.index);
      if (!group) {
        group = createObjectivePerimeter(svgNamespace, perimeter.index, faction);
        els.objectiveOverlay.append(group);
      }
      active.add(perimeter.index);
      updateObjectivePerimeter(group, perimeter);
    });
    for (const [index, group] of existing) {
      if (!active.has(index)) group.remove();
    }
  } else {
    for (const group of els.objectiveOverlay.querySelectorAll(".objective-perimeter-group")) group.remove();
  }

  if (!showMarkers) return;
  validObjectives.forEach(({ objective, index }) => {
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

function updateOverlayViews() {
  const { scale, tx, ty } = state.view;
  const rect = els.viewport.getBoundingClientRect();
  if (scale <= 0 || rect.width <= 0 || rect.height <= 0) return;
  const viewBox = `${-tx / scale} ${-ty / scale} ${rect.width / scale} ${rect.height / scale}`;
  els.cityOverlay.setAttribute("viewBox", viewBox);
  els.objectiveOverlay.setAttribute("viewBox", viewBox);
  els.regionOverlay.setAttribute("viewBox", viewBox);
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

function drawFighting(fronts, width, height) {
  const canvas = els.battleCanvas;
  const ctx = canvas.getContext("2d");
  const visible = els.showObjectives.checked;
  canvas.classList.toggle("is-hidden", !visible);
  if (!visible) return;

  if (!state.frontImage || state.frontImage.width !== width || state.frontImage.height !== height) {
    canvas.width = width;
    canvas.height = height;
    state.frontImage = ctx.createImageData(width, height);
    state.renderedFronts = null;
  }

  const pixels = state.frontImage.data;
  if (state.renderedFronts) {
    for (const encoded of state.renderedFronts) {
      pixels[(encoded >> 1) * 4 + 3] = 0;
    }
  }

  for (const encoded of fronts) {
    const offset = (encoded >> 1) * 4;
    const redAttacker = (encoded & 1) === 1;
    pixels[offset] = redAttacker ? 255 : 38;
    pixels[offset + 1] = redAttacker ? 48 : 154;
    pixels[offset + 2] = redAttacker ? 30 : 255;
    pixels[offset + 3] = 255;
  }
  ctx.putImageData(state.frontImage, 0, 0);
  state.renderedFronts = fronts;
}

function normalizedRegion(start, end) {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

function regionPoint(event) {
  const rect = els.viewport.getBoundingClientRect();
  const { scale, tx, ty } = state.view;
  return {
    x: Math.max(0, Math.min(MAP_W, (event.clientX - rect.left - tx) / scale)),
    y: Math.max(0, Math.min(MAP_H, (event.clientY - rect.top - ty) / scale)),
  };
}

function renderRegionOutline() {
  const { bounds } = state.region;
  els.regionOverlay.replaceChildren();
  if (!bounds) return;
  const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  outline.setAttribute("class", "region-outline");
  outline.setAttribute("x", bounds.left);
  outline.setAttribute("y", bounds.top);
  outline.setAttribute("width", bounds.right - bounds.left);
  outline.setAttribute("height", bounds.bottom - bounds.top);
  els.regionOverlay.append(outline);
}

function updateRegionStats() {
  const { bounds } = state.region;
  const current = state.current;
  els.regionIntel.classList.toggle("has-selection", Boolean(bounds));
  els.regionIntel.classList.toggle("is-selecting", state.region.selecting && !bounds);
  els.regionStats.hidden = !bounds;
  if (!bounds) {
    els.regionStatus.textContent = state.region.selecting ? "Drag on map" : "No selection";
    return;
  }
  if (!current) return;

  const canvasLeft = Math.floor((bounds.left * current.entry.canvas.width) / MAP_W);
  const canvasTop = Math.floor((bounds.top * current.entry.canvas.height) / MAP_H);
  const canvasRight = Math.ceil((bounds.right * current.entry.canvas.width) / MAP_W);
  const canvasBottom = Math.ceil((bounds.bottom * current.entry.canvas.height) / MAP_H);
  const pixels = current.entry.canvas.getContext("2d")
    .getImageData(canvasLeft, canvasTop, canvasRight - canvasLeft, canvasBottom - canvasTop).data;
  let red = 0;
  let blue = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    if (pixels[i] === RED_RGB[0]) red += 1;
    else blue += 1;
  }

  let cityRed = 0;
  let cityBlue = 0;
  const { worldSize, cities } = state.cityData;
  cities.forEach(([x, y], index) => {
    const mapX = (x * MAP_W) / worldSize.width;
    const mapY = (y * MAP_H) / worldSize.height;
    if (mapX < bounds.left || mapX > bounds.right || mapY < bounds.top || mapY > bounds.bottom) return;
    if (current.entry.cityOwners[index] === 1) cityRed += 1;
    else if (current.entry.cityOwners[index] === 0) cityBlue += 1;
  });

  let objectiveRed = 0;
  let objectiveBlue = 0;
  if (Array.isArray(current.row.objectives)) {
    current.row.objectives.forEach((objective, index) => {
      if (!Array.isArray(objective)) return;
      const [y, x] = objective;
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      if (index % 2 === 0) objectiveBlue += 1;
      else objectiveRed += 1;
    });
  }

  const total = red + blue;
  const redShare = total > 0 ? (red / total) * 100 : null;
  els.regionStatus.textContent = `${Math.round(bounds.right - bounds.left)} × ${Math.round(bounds.bottom - bounds.top)} px`;
  els.regionRedPixels.textContent = redShare === null ? "0 px" : `${red.toLocaleString()} px (${redShare.toFixed(1)}%)`;
  els.regionBluePixels.textContent = redShare === null ? "0 px" : `${blue.toLocaleString()} px (${(100 - redShare).toFixed(1)}%)`;
  els.regionRedCities.textContent = cityRed.toLocaleString();
  els.regionBlueCities.textContent = cityBlue.toLocaleString();
  els.regionObjectives.textContent = `R ${objectiveRed} · B ${objectiveBlue}`;
}

function setRegionSelection(selecting) {
  state.region.selecting = selecting;
  els.regionSelect.classList.toggle("is-active", selecting);
  els.regionSelect.setAttribute("aria-pressed", String(selecting));
  els.regionSelect.textContent = selecting ? "Clear" : "Select region";
  els.regionSelect.title = selecting ? "Clear the selected region" : "Draw a region on the map";
  els.viewport.classList.toggle("selecting-region", selecting);
  els.regionIntel.classList.toggle("is-selecting", selecting && !state.region.bounds);
  if (!state.region.bounds) els.regionStatus.textContent = selecting ? "Drag on map" : "No selection";
}

function clearRegion() {
  state.region.bounds = null;
  state.region.start = null;
  state.region.pointerId = null;
  renderRegionOutline();
  updateRegionStats();
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
  scheduleAnalytics(); // keep the chart marker and log highlight in sync
  const token = ++state.renderToken;
  const loadingTimer = setTimeout(() => { els.loading.hidden = false; }, 150);
  try {
    const entry = await getDecoded(row);
    if (token !== state.renderToken) return;
    state.current = { row, entry };
    drawMap();
    updateStats(entry);
    updateRegionStats();
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
    queueStats(older);
    scheduleAnalytics();
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
      queueStats([latest]);
      scheduleAnalytics();
      if (wasAtEnd && !state.playing) setIndex(state.rows.length - 1);
      else updatePanels(state.rows[state.index]);
    }
  } catch {
    /* transient poll failure — keep showing the last known status */
  }
}

/* ---------- Snapshot analytics (momentum chart + snapshot log) ----------
 * Timeline rows do not carry territory counts; those live in each snapshot's
 * ownership bitmap. Workers download every snapshot in the background and
 * popcount it (no canvas), so the chart and log fill in progressively.
 * Counts are immutable per mapHash and persisted in localStorage. */

const STATS_KEY = "wod-stats-v2";
const STATS_CONCURRENCY = 4;
const SVG_NS_CHART = "http://www.w3.org/2000/svg";

const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i += 1) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

const statsQueue = [];
const statsQueued = new Set();
let statsActive = 0;
let statsPersistTimer = null;
let analyticsTimer = 0;
let chartHit = null; // chart points and transient hover/drag SVG elements
let chartDrag = null; // { pointerId, start, current }

function shareOf(stats) {
  const total = stats.red + stats.blue;
  return total > 0 ? (stats.red / total) * 100 : null;
}

function cityShareOf(stats) {
  const total = stats.cityRed + stats.cityBlue;
  return total > 0 ? (stats.cityRed / total) * 100 : null;
}

function loadPersistedStats() {
  try {
    const stored = JSON.parse(localStorage.getItem(STATS_KEY) || "{}");
    for (const [hash, value] of Object.entries(stored)) {
      if (Array.isArray(value)
          && Number.isFinite(value[0])
          && Number.isFinite(value[1])
          && Number.isFinite(value[2])
          && Number.isFinite(value[3])) {
        state.stats.set(hash, {
          red: value[0],
          blue: value[1],
          cityRed: value[2],
          cityBlue: value[3],
        });
      }
    }
  } catch { /* corrupt or unavailable storage — recompute from the API */ }
}

function persistStats() {
  clearTimeout(statsPersistTimer);
  statsPersistTimer = setTimeout(() => {
    try {
      const out = {};
      for (const [hash, stats] of state.stats) {
        out[hash] = [stats.red, stats.blue, stats.cityRed, stats.cityBlue];
      }
      localStorage.setItem(STATS_KEY, JSON.stringify(out));
    } catch { /* storage full or blocked — stats simply recompute next visit */ }
  }, 800);
}

function setStat(mapHash, red, blue, cityCounts) {
  const next = { red, blue, ...cityCounts };
  const current = state.stats.get(mapHash);
  if (current
      && current.red === next.red
      && current.blue === next.blue
      && current.cityRed === next.cityRed
      && current.cityBlue === next.cityBlue) return;
  state.stats.set(mapHash, next);
  persistStats();
  scheduleAnalytics();
}

function countCompact(row, bytes) {
  const total = row.playablePixels;
  const fullBytes = total >> 3;
  let red = 0;
  for (let i = 0; i < fullBytes; i += 1) red += POPCOUNT[bytes[i]];
  for (let index = fullBytes * 8; index < total; index += 1) red += bit(bytes, index);
  return { red, blue: total - red };
}

function countLegacy(bytes) {
  let red = 0;
  let blue = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 1) red += 1;
    else if (bytes[i] === 0) blue += 1;
  }
  return { red, blue };
}

async function computeStats(row) {
  const decoded = state.cache.get(row.mapHash);
  if (decoded) {
    try {
      const entry = await decoded;
      setStat(row.mapHash, entry.red, entry.blue, countCityOwners(entry.cityOwners));
      return;
    } catch { /* decode failed — fall through to a direct fetch */ }
  }
  const bytes = await inflate(await authenticatedFetch(new URL(row.mapUrl, API)));
  if (row.encoding === "playable-bitset-zlib-v1") {
    const { red, blue } = countCompact(row, bytes);
    setStat(row.mapHash, red, blue, countCompactCities(row, bytes));
  } else if (row.encoding === "raw-u8-zlib-v1") {
    const { red, blue } = countLegacy(bytes);
    setStat(row.mapHash, red, blue, countLegacyCities(row, bytes));
  }
}

function queueStats(rows) {
  const missing = rows
    .filter((row) => !state.stats.has(row.mapHash) && !statsQueued.has(row.mapHash))
    .sort((a, b) => b.capturedAt - a.capturedAt); // newest first, so the chart fills from the right
  for (const row of missing) {
    statsQueued.add(row.mapHash);
    statsQueue.push(row);
  }
  pumpStats();
}

function pumpStats() {
  while (statsActive < STATS_CONCURRENCY && statsQueue.length > 0) {
    const row = statsQueue.shift();
    if (state.stats.has(row.mapHash)) {
      statsQueued.delete(row.mapHash);
      continue;
    }
    statsActive += 1;
    computeStats(row)
      .catch(() => {}) // transient failure — the snapshot stays a gap in the chart
      .finally(() => {
        statsActive -= 1;
        statsQueued.delete(row.mapHash);
        pumpStats();
      });
  }
}

/* setTimeout rather than requestAnimationFrame so the chart and log still
 * fill in while the tab is hidden; the delay coalesces bursts of updates. */
function scheduleAnalytics() {
  if (analyticsTimer) return;
  analyticsTimer = setTimeout(() => {
    analyticsTimer = 0;
    renderChart();
    renderTable();
  }, 60);
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS_CHART, name);
  for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key]);
  return el;
}

function formatChartSpan(seconds) {
  const hours = seconds / 3600;
  if (hours >= 48 && Math.abs(hours / 24 - Math.round(hours / 24)) < 0.08) {
    return `${Math.round(hours / 24)} d`;
  }
  if (hours >= 1) return `${Math.round(hours)} h`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function factionSpan(text, faction, className) {
  const span = document.createElement("span");
  span.className = `${className} ${className}-${faction}`;
  span.textContent = text;
  return span;
}

function chartTrendBaseline(points) {
  const latest = points[points.length - 1];
  const target = latest.t - 24 * 3600;
  let baseline = points[0];
  for (const point of points) {
    if (Math.abs(point.t - target) < Math.abs(baseline.t - target)) baseline = point;
  }
  return baseline;
}

function renderChartStatus(points) {
  const el = els.chartStatus;
  el.replaceChildren();
  const total = state.rows.length;
  if (total === 0 || points.length === 0) {
    el.className = "chart-status";
    return;
  }
  if (points.length < total) {
    el.textContent = `Analyzing ${points.length} / ${total} snapshots…`;
    el.className = "chart-status";
    return;
  }
  const latest = points[points.length - 1];
  const margin = latest.share - (100 - latest.share);
  el.className = "chart-status";
  if (Math.abs(margin) < 0.005) {
    el.append("Dead heat");
  } else {
    const faction = margin > 0 ? "red" : "blue";
    const name = faction === "red" ? "Red Empire" : "Blue Republic";
    el.append(factionSpan(`${name} leads by ${Math.abs(margin).toFixed(2)} pp`, faction, "chart-leader"));
  }

  const baseline = chartTrendBaseline(points);
  if (latest.t > baseline.t) {
    const change = latest.share - baseline.share;
    const span = formatChartSpan(latest.t - baseline.t);
    el.append(" · ");
    if (Math.abs(change) >= 0.005) {
      const faction = change > 0 ? "red" : "blue";
      const name = faction === "red" ? "Red" : "Blue";
      el.append(factionSpan(`${name} +${Math.abs(change).toFixed(2)} pp in ${span}`, faction, "chart-change"));
    } else {
      el.append(`No change in ${span}`);
    }
  }
}

function renderChart() {
  const svg = els.chartSvg;
  const width = Math.max(300, Math.floor(els.chartWrap.getBoundingClientRect().width) || 300);
  const height = 250;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));
  svg.replaceChildren();
  chartHit = null;

  const rows = state.rows;
  const points = [];
  for (let i = 0; i < rows.length; i += 1) {
    const stats = state.stats.get(rows[i].mapHash);
    const share = stats ? shareOf(stats) : null;
    if (share !== null) {
      points.push({
        i,
        t: rows[i].capturedAt,
        share,
        red: stats.red,
        blue: stats.blue,
        cityShare: cityShareOf(stats),
        cityRed: stats.cityRed,
        cityBlue: stats.cityBlue,
      });
    }
  }
  renderChartStatus(points);
  if (points.length < 2) {
    const message = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart-empty" });
    message.textContent = rows.length === 0 ? "Waiting for snapshots…" : "Analyzing snapshots…";
    svg.append(message);
    return;
  }

  const pad = { top: 32, right: 66, bottom: 26, left: 12 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const xOf = (t) => (t1 === t0 ? pad.left + plotW / 2 : pad.left + ((t - t0) / (t1 - t0)) * plotW);

  // Y domain covers both lines, always includes the 50% battle line.
  let lo = 49.5;
  let hi = 50.5;
  for (const p of points) {
    lo = Math.min(lo, p.share, 100 - p.share);
    hi = Math.max(hi, p.share, 100 - p.share);
    if (p.cityShare !== null) {
      lo = Math.min(lo, p.cityShare, 100 - p.cityShare);
      hi = Math.max(hi, p.cityShare, 100 - p.cityShare);
    }
  }
  const padY = Math.max(0.3, (hi - lo) * 0.12);
  lo = Math.max(0, lo - padY);
  hi = Math.min(100, hi + padY);
  const yOf = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;

  let redLine = "";
  let blueLine = "";
  let cityRedLine = "";
  let cityBlueLine = "";
  let citySegment = 0;
  for (let k = 0; k < points.length; k += 1) {
    const p = points[k];
    const x = xOf(p.t).toFixed(1);
    redLine += `${k === 0 ? "M" : "L"}${x},${yOf(p.share).toFixed(1)}`;
    blueLine += `${k === 0 ? "M" : "L"}${x},${yOf(100 - p.share).toFixed(1)}`;
    if (p.cityShare === null) {
      citySegment = 0;
    } else {
      cityRedLine += `${citySegment === 0 ? "M" : "L"}${x},${yOf(p.cityShare).toFixed(1)}`;
      cityBlueLine += `${citySegment === 0 ? "M" : "L"}${x},${yOf(100 - p.cityShare).toFixed(1)}`;
      citySegment += 1;
    }
  }
  const bottom = (pad.top + plotH).toFixed(1);
  const firstX = xOf(points[0].t).toFixed(1);
  const lastX = xOf(points[points.length - 1].t).toFixed(1);
  svg.append(
    svgEl("path", { d: `${redLine}L${lastX},${bottom}L${firstX},${bottom}Z`, class: "chart-area chart-area-red" }),
    svgEl("path", { d: `${blueLine}L${lastX},${bottom}L${firstX},${bottom}Z`, class: "chart-area chart-area-blue" }),
  );

  // Gridlines with a step that yields a handful of lines.
  let step = 20;
  for (const candidate of [0.25, 0.5, 1, 2, 5, 10, 20]) {
    if ((hi - lo) / candidate <= 6) {
      step = candidate;
      break;
    }
  }
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    if (Math.abs(v - 50) < 1e-9) continue; // the battle line is drawn separately
    const y = yOf(v).toFixed(1);
    svg.append(svgEl("line", { x1: pad.left, x2: pad.left + plotW, y1: y, y2: y, class: "chart-grid" }));
    const label = svgEl("text", { x: pad.left + 2, y: yOf(v) - 4, class: "chart-grid-label" });
    label.textContent = `${step < 1 ? v.toFixed(2) : Math.round(v)}%`;
    svg.append(label);
  }
  if (lo <= 50 && hi >= 50) {
    const y = yOf(50).toFixed(1);
    svg.append(svgEl("line", { x1: pad.left, x2: pad.left + plotW, y1: y, y2: y, class: "chart-mid" }));
    const label = svgEl("text", { x: pad.left + 2, y: yOf(50) - 4, class: "chart-grid-label" });
    label.textContent = "50%";
    svg.append(label);
  }

  const landKey = svgEl("line", { x1: pad.left, x2: pad.left + 22, y1: 12, y2: 12, class: "chart-line chart-line-red" });
  const landKeyLabel = svgEl("text", { x: pad.left + 28, y: 16, class: "chart-series-label" });
  landKeyLabel.textContent = "Land";
  const cityKey = svgEl("line", { x1: pad.left + 78, x2: pad.left + 100, y1: 12, y2: 12, class: "chart-line chart-line-red chart-line-city" });
  const cityKeyLabel = svgEl("text", { x: pad.left + 106, y: 16, class: "chart-series-label" });
  cityKeyLabel.textContent = "Cities";
  svg.append(landKey, landKeyLabel, cityKey, cityKeyLabel);

  // Time axis.
  const spanSeconds = t1 - t0;
  const tickFormat = new Intl.DateTimeFormat(
    undefined,
    spanSeconds > 3 * 86400
      ? { month: "short", day: "numeric" }
      : { weekday: "short", hour: "2-digit", minute: "2-digit" },
  );
  const tickCount = width < 520 ? 3 : 5;
  for (let k = 0; k < tickCount; k += 1) {
    const t = t0 + (spanSeconds * k) / (tickCount - 1);
    const anchor = k === 0 ? "start" : k === tickCount - 1 ? "end" : "middle";
    const label = svgEl("text", { x: xOf(t).toFixed(1), y: height - 8, "text-anchor": anchor, class: "chart-axis-label" });
    label.textContent = tickFormat.format(new Date(t * 1000));
    svg.append(label);
  }

  // Marker for the snapshot currently shown on the map.
  const currentRow = rows[state.index];
  if (currentRow && currentRow.capturedAt >= t0 && currentRow.capturedAt <= t1) {
    const x = xOf(currentRow.capturedAt).toFixed(1);
    svg.append(svgEl("line", { x1: x, x2: x, y1: pad.top, y2: pad.top + plotH, class: "chart-marker" }));
    const currentPoint = points.find((p) => p.i === state.index);
    if (currentPoint) {
      const markers = [
        svgEl("circle", { cx: x, cy: yOf(currentPoint.share).toFixed(1), r: 4, class: "chart-dot chart-dot-red" }),
        svgEl("circle", { cx: x, cy: yOf(100 - currentPoint.share).toFixed(1), r: 4, class: "chart-dot chart-dot-blue" }),
      ];
      if (currentPoint.cityShare !== null) {
        markers.push(
          svgEl("rect", { x: Number(x) - 3.5, y: yOf(currentPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-red" }),
          svgEl("rect", { x: Number(x) - 3.5, y: yOf(100 - currentPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-blue" }),
        );
      }
      svg.append(...markers);
    }
  }

  svg.append(
    svgEl("path", { d: redLine, class: "chart-line chart-line-red" }),
    svgEl("path", { d: blueLine, class: "chart-line chart-line-blue" }),
    svgEl("path", { d: cityRedLine, class: "chart-line chart-line-red chart-line-city" }),
    svgEl("path", { d: cityBlueLine, class: "chart-line chart-line-blue chart-line-city" }),
  );

  // Live endpoints: pulsing dots plus the current share, election-night style.
  const endPoint = points[points.length - 1];
  const endX = xOf(endPoint.t);
  const yRed = yOf(endPoint.share);
  const yBlue = yOf(100 - endPoint.share);
  svg.append(
    svgEl("circle", { cx: endX, cy: yRed, r: 8, class: "chart-pulse chart-pulse-red" }),
    svgEl("circle", { cx: endX, cy: yBlue, r: 8, class: "chart-pulse chart-pulse-blue" }),
    svgEl("circle", { cx: endX, cy: yRed, r: 3.5, class: "chart-dot chart-dot-red" }),
    svgEl("circle", { cx: endX, cy: yBlue, r: 3.5, class: "chart-dot chart-dot-blue" }),
  );
  if (endPoint.cityShare !== null) {
    svg.append(
      svgEl("rect", { x: endX - 3.5, y: yOf(endPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-red chart-city-end" }),
      svgEl("rect", { x: endX - 3.5, y: yOf(100 - endPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-blue chart-city-end" }),
    );
  }
  let labelYRed = yRed;
  let labelYBlue = yBlue;
  if (Math.abs(labelYRed - labelYBlue) < 16) {
    const mid = (labelYRed + labelYBlue) / 2;
    const sign = labelYRed <= labelYBlue ? 1 : -1;
    labelYRed = mid - 8 * sign;
    labelYBlue = mid + 8 * sign;
  }
  const redLabel = svgEl("text", { x: endX + 8, y: labelYRed + 4, class: "chart-end-label red" });
  redLabel.textContent = `${endPoint.share.toFixed(2)}%`;
  const blueLabel = svgEl("text", { x: endX + 8, y: labelYBlue + 4, class: "chart-end-label blue" });
  blueLabel.textContent = `${(100 - endPoint.share).toFixed(2)}%`;
  svg.append(redLabel, blueLabel);

  const dragRange = svgEl("rect", {
    x: 0, y: pad.top, width: 0, height: plotH, class: "chart-drag-range",
  });
  const dragStartLine = svgEl("line", {
    x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH, class: "chart-drag-marker",
  });
  const dragEndLine = svgEl("line", {
    x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH, class: "chart-drag-marker",
  });
  const hoverLine = svgEl("line", { x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH, class: "chart-hover-line" });
  for (const element of [dragRange, dragStartLine, dragEndLine, hoverLine]) {
    element.style.visibility = "hidden";
  }
  svg.append(dragRange, dragStartLine, dragEndLine, hoverLine);
  chartHit = {
    points: points.map((p) => ({ ...p, x: xOf(p.t) })),
    hoverLine,
    dragRange,
    dragStartLine,
    dragEndLine,
  };
}

function chartPointFromEvent(event) {
  if (!chartHit || chartHit.points.length === 0) return null;
  const rect = els.chartSvg.getBoundingClientRect();
  const x = event.clientX - rect.left;
  let best = chartHit.points[0];
  for (const p of chartHit.points) {
    if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  }
  return best;
}

function positionChartTooltip(x) {
  const tooltip = els.chartTooltip;
  tooltip.hidden = false;
  const wrapWidth = els.chartWrap.getBoundingClientRect().width;
  const left = x + 14 + tooltip.offsetWidth > wrapWidth
    ? x - 14 - tooltip.offsetWidth
    : x + 14;
  tooltip.style.left = `${Math.max(0, left)}px`;
}

function renderChartPointTooltip(point) {
  const tooltip = els.chartTooltip;
  tooltip.replaceChildren();
  const when = document.createElement("div");
  when.className = "tt-time";
  when.textContent = timeFormat.format(new Date(point.t * 1000));
  const red = document.createElement("div");
  red.className = "tt-red";
  red.textContent = `Land · Red ${point.share.toFixed(3)}%`;
  const blue = document.createElement("div");
  blue.className = "tt-blue";
  blue.textContent = `Land · Blue ${(100 - point.share).toFixed(3)}%`;
  tooltip.append(when, red, blue);
  if (point.cityShare !== null) {
    const cities = document.createElement("div");
    cities.className = "tt-cities";
    cities.textContent = `Cities · R ${point.cityRed} (${point.cityShare.toFixed(1)}%) / B ${point.cityBlue} (${(100 - point.cityShare).toFixed(1)}%)`;
    tooltip.append(cities);
  }
  const hint = document.createElement("div");
  hint.className = "tt-change";
  hint.textContent = "Press and drag to compare snapshots";
  tooltip.append(hint);
  positionChartTooltip(point.x);
}

function changeLine(label, change, gained, unit) {
  const line = document.createElement("div");
  const faction = change > 0 ? "red" : change < 0 ? "blue" : null;
  line.className = faction ? `tt-change-value tt-${faction}` : "tt-change-value";
  if (!faction) {
    line.textContent = `${label} · No change`;
    return line;
  }
  const name = faction === "red" ? "Red" : "Blue";
  const count = Math.abs(gained);
  const countUnit = unit === "city" && count !== 1 ? "cities" : unit;
  line.textContent = `${label} · ${name} +${Math.abs(change).toFixed(2)}% (+${count.toLocaleString()} ${countUnit})`;
  return line;
}

function renderChartDragTooltip(first, second) {
  const [start, end] = first.t <= second.t ? [first, second] : [second, first];
  const tooltip = els.chartTooltip;
  tooltip.replaceChildren();
  const range = document.createElement("div");
  range.className = "tt-time tt-range-time";
  range.textContent = `${timeFormat.format(new Date(start.t * 1000))} → ${timeFormat.format(new Date(end.t * 1000))}`;
  const duration = document.createElement("div");
  duration.className = "tt-duration";
  duration.textContent = start.i === end.i ? "Drag to another snapshot" : formatChartSpan(end.t - start.t);
  const landChange = end.share - start.share;
  const landGained = landChange >= 0 ? end.red - start.red : end.blue - start.blue;
  tooltip.append(range, duration, changeLine("Land", landChange, landGained, "px"));
  if (start.cityShare !== null && end.cityShare !== null) {
    const cityChange = end.cityShare - start.cityShare;
    const citiesGained = cityChange >= 0
      ? end.cityRed - start.cityRed
      : end.cityBlue - start.cityBlue;
    tooltip.append(changeLine("Cities", cityChange, citiesGained, "city"));
  }
  positionChartTooltip(second.x);
}

function updateChartDrag(point) {
  if (!chartDrag || !chartHit) return;
  chartDrag.current = point;
  const startX = chartDrag.start.x;
  const endX = point.x;
  chartHit.hoverLine.style.visibility = "hidden";
  chartHit.dragRange.setAttribute("x", Math.min(startX, endX));
  chartHit.dragRange.setAttribute("width", Math.abs(endX - startX));
  chartHit.dragStartLine.setAttribute("x1", startX);
  chartHit.dragStartLine.setAttribute("x2", startX);
  chartHit.dragEndLine.setAttribute("x1", endX);
  chartHit.dragEndLine.setAttribute("x2", endX);
  for (const element of [chartHit.dragRange, chartHit.dragStartLine, chartHit.dragEndLine]) {
    element.style.visibility = "visible";
  }
  renderChartDragTooltip(chartDrag.start, point);
}

function chartPointerDown(event) {
  if (event.button !== 0 || !chartHit) return;
  const point = chartPointFromEvent(event);
  if (!point) return;
  chartDrag = { pointerId: event.pointerId, start: point, current: point };
  els.chartWrap.setPointerCapture(event.pointerId);
  updateChartDrag(point);
  event.preventDefault();
}

function chartPointerMove(event) {
  const point = chartPointFromEvent(event);
  if (!point) return;
  if (chartDrag && event.pointerId === chartDrag.pointerId) {
    updateChartDrag(point);
    return;
  }
  chartHit.hoverLine.setAttribute("x1", point.x);
  chartHit.hoverLine.setAttribute("x2", point.x);
  chartHit.hoverLine.style.visibility = "visible";
  renderChartPointTooltip(point);
}

function resetChartDrag(event) {
  if (!chartDrag || (event && event.pointerId !== chartDrag.pointerId)) return;
  const pointerId = chartDrag.pointerId;
  chartDrag = null;
  if (els.chartWrap.hasPointerCapture(pointerId)) els.chartWrap.releasePointerCapture(pointerId);
  if (chartHit) {
    for (const element of [chartHit.dragRange, chartHit.dragStartLine, chartHit.dragEndLine]) {
      element.style.visibility = "hidden";
    }
  }
  chartLeave();
}

function chartLeave() {
  if (chartDrag) return;
  els.chartTooltip.hidden = true;
  if (chartHit) chartHit.hoverLine.style.visibility = "hidden";
}

function addCell(tr, className, text) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  tr.append(td);
}

function factionCell(tr, value, formatted) {
  if (value === 0) {
    addCell(tr, "num cell-flat", "±0");
  } else {
    addCell(tr, `num ${value > 0 ? "cell-red" : "cell-blue"}`, `${value > 0 ? "R" : "B"}+${formatted}`);
  }
}

function splitFactionCell(tr, redValue, blueValue, format) {
  if (!Number.isFinite(redValue) || !Number.isFinite(blueValue)) {
    addCell(tr, "num cell-flat", "…");
    return;
  }
  const td = document.createElement("td");
  td.className = "num split-faction-cell";
  const red = document.createElement("span");
  red.className = "cell-red";
  red.textContent = format(redValue);
  const separator = document.createElement("span");
  separator.className = "cell-flat";
  separator.textContent = " / ";
  const blue = document.createElement("span");
  blue.className = "cell-blue";
  blue.textContent = format(blueValue);
  td.append(red, separator, blue);
  tr.append(td);
}

function renderTable() {
  const rows = state.rows;
  const frag = document.createDocumentFragment();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const stats = state.stats.get(row.mapHash);
    const share = stats ? shareOf(stats) : null;
    const prevStats = i > 0 ? state.stats.get(rows[i - 1].mapHash) : undefined;
    const prevShare = prevStats ? shareOf(prevStats) : null;

    const tr = document.createElement("tr");
    tr.dataset.index = String(i);
    if (i === state.index) tr.classList.add("is-current");

    addCell(tr, "num cell-flat", `#${row.id}`);
    addCell(tr, "", timeFormat.format(new Date(row.capturedAt * 1000)));
    splitFactionCell(
      tr,
      share,
      share === null ? NaN : 100 - share,
      (value) => `${value.toFixed(3)}%`,
    );

    if (share === null) {
      addCell(tr, "num cell-flat", "…");
    } else {
      const margin = share - (100 - share);
      factionCell(tr, margin, Math.abs(margin).toFixed(3));
    }

    if (i === 0) {
      // Oldest loaded snapshot has nothing loaded to compare against.
      addCell(tr, "num cell-flat", "—");
    } else if (share === null || prevShare === null) {
      addCell(tr, "num cell-flat", "…");
    } else {
      const deltaPx = stats.red - prevStats.red;
      factionCell(tr, deltaPx, Math.abs(deltaPx).toLocaleString());
    }

    const hasCities = stats
      && Number.isFinite(stats.cityRed)
      && Number.isFinite(stats.cityBlue);
    splitFactionCell(
      tr,
      hasCities ? stats.cityRed : NaN,
      hasCities ? stats.cityBlue : NaN,
      (value) => value.toLocaleString(),
    );
    if (!hasCities) {
      addCell(tr, "num cell-flat", "…");
    } else {
      factionCell(tr, stats.cityRed - stats.cityBlue, Math.abs(stats.cityRed - stats.cityBlue).toLocaleString());
    }
    if (i === 0) {
      addCell(tr, "num cell-flat", "—");
    } else if (!stats || !prevStats
               || !Number.isFinite(stats.cityRed)
               || !Number.isFinite(prevStats.cityRed)) {
      addCell(tr, "num cell-flat", "…");
    } else {
      const deltaCities = stats.cityRed - prevStats.cityRed;
      factionCell(tr, deltaCities, Math.abs(deltaCities).toLocaleString());
    }
    frag.append(tr);
  }
  els.snapTbody.replaceChildren(frag);
}

function setupAnalytics() {
  loadPersistedStats();
  els.chartWrap.addEventListener("pointerdown", chartPointerDown);
  els.chartWrap.addEventListener("pointermove", chartPointerMove);
  els.chartWrap.addEventListener("pointerup", resetChartDrag);
  els.chartWrap.addEventListener("pointercancel", resetChartDrag);
  els.chartWrap.addEventListener("pointerleave", chartLeave);
  els.snapTbody.addEventListener("click", (event) => {
    const tr = event.target.closest("tr[data-index]");
    if (!tr) return;
    setPlaying(false);
    setIndex(Number(tr.dataset.index));
  });
  new ResizeObserver(scheduleAnalytics).observe(els.chartWrap);
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
  // The battle canvas is transformed with the map, so compensate its filter
  // radii to keep the fighting glow prominent at every zoom level.
  if (state.frontGlowScale !== scale) {
    const glowScale = 1 / Math.max(scale, 0.01);
    els.battleCanvas.style.setProperty("--front-glow-core", `${4 * glowScale}px`);
    els.battleCanvas.style.setProperty("--front-glow-near", `${9 * glowScale}px`);
    els.battleCanvas.style.setProperty("--front-glow-mid", `${18 * glowScale}px`);
    els.battleCanvas.style.setProperty("--front-glow-far", `${30 * glowScale}px`);
    state.frontGlowScale = scale;
  }
  updateOverlayViews();
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
    if (state.region.selecting && event.button === 0 && pointers.size === 0) {
      els.viewport.setPointerCapture(event.pointerId);
      state.region.pointerId = event.pointerId;
      state.region.start = regionPoint(event);
      state.region.bounds = normalizedRegion(state.region.start, state.region.start);
      renderRegionOutline();
      return;
    }
    els.viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
    els.viewport.classList.add("dragging");
  });

  els.viewport.addEventListener("pointermove", (event) => {
    if (state.region.pointerId === event.pointerId && state.region.start) {
      state.region.bounds = normalizedRegion(state.region.start, regionPoint(event));
      renderRegionOutline();
      return;
    }
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
    if (state.region.pointerId === event.pointerId) {
      const bounds = state.region.bounds;
      state.region.pointerId = null;
      state.region.start = null;
      if (bounds && (bounds.right - bounds.left < 4 || bounds.bottom - bounds.top < 4)) clearRegion();
      else updateRegionStats();
      return;
    }
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
  els.showCities.addEventListener("change", drawMap);
  els.showObjectives.addEventListener("change", drawMap);
  els.showPerimeters.addEventListener("change", drawMap);
  els.regionSelect.addEventListener("click", () => {
    if (state.region.selecting) {
      clearRegion();
      setRegionSelection(false);
      return;
    }
    setRegionSelection(true);
  });

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
  // onload rather than decode(): decode() can stall forever in background tabs.
  await new Promise((resolve, reject) => {
    if (image.complete && image.naturalWidth > 0) {
      resolve();
      return;
    }
    image.onload = resolve;
    image.onerror = () => reject(new Error("Could not load the terrain image."));
  });
  return image;
}

function setupAccessControls() {
  els.accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    els.accessSubmit.disabled = true;
    els.accessSubmit.textContent = "Checking…";
    els.accessError.hidden = true;
    try {
      const resp = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: els.accessCode.value }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        let message = body.error || "Could not verify the access code.";
        if (resp.status === 401 && Number.isInteger(body.attemptsRemaining)) {
          message += ` ${body.attemptsRemaining} attempt${body.attemptsRemaining === 1 ? "" : "s"} remaining.`;
        } else if (resp.status === 429 && Number.isFinite(body.retryAfter)) {
          const minutes = Math.max(1, Math.ceil(body.retryAfter / 60));
          message += ` Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
        }
        throw new Error(message);
      }
      saveSessionToken(body.token);
      hideAccessGate();
      if (appStarted) {
        location.reload();
        return;
      }
      appStarted = true;
      await init();
    } catch (error) {
      els.accessError.textContent = error.message || "Could not verify the access code.";
      els.accessError.hidden = false;
      els.accessCode.select();
    } finally {
      els.accessSubmit.disabled = false;
      els.accessSubmit.textContent = "Unlock map";
    }
  });

  els.logoutBtn.addEventListener("click", async () => {
    try {
      await authenticatedFetch(`${API}/auth/logout`, { method: "POST" });
    } finally {
      saveSessionToken("");
      location.reload();
    }
  });
}

async function bootstrap() {
  setupAccessControls();
  if (!accessToken) {
    showAccessGate();
    return;
  }
  try {
    await fetchJSON(`${API}/auth/session`);
    hideAccessGate();
    appStarted = true;
    await init();
  } catch (error) {
    showAccessGate(error.message === "A valid access session is required."
      ? "Your access session expired. Enter the code again."
      : "Could not verify your saved session. Enter the code again.");
  }
}

async function init() {
  if (typeof DecompressionStream === "undefined") {
    showError("This browser does not support DecompressionStream, which is needed to decode the map. Please use a current browser.");
    return;
  }
  setupViewport();
  setupControls();
  setupAnalytics();
  fitView();
  try {
    const [terrain, mask, cityData, timeline, latest, health] = await Promise.all([
      loadTerrain(),
      (async () => inflate(await fetch(MASK_URL)))(),
      fetchJSON(CITY_DATA_URL),
      fetchJSON(`${API}/v1/timeline?limit=336`),
      fetchJSON(`${API}/v1/snapshots/latest`),
      fetchJSON(`${API}/health`),
    ]);
    state.terrain = terrain;
    state.mask = mask;
    state.cityData = cityData;
    buildCityMarkers();
    state.health = health;
    renderStatus();
    state.rows = timeline.rows.slice().reverse();
    if (!state.rows.some((row) => row.id === latest.id)) {
      state.rows.push(latest);
      state.rows.sort((a, b) => a.capturedAt - b.capturedAt);
    }
    state.nextBefore = timeline.nextBefore;
    els.loadOlder.hidden = !state.nextBefore;
    if (state.rows.length === 0) {
      showError("No snapshots have been captured yet. Check back soon!");
      return;
    }
    els.slider.max = String(state.rows.length - 1);
    queueStats(state.rows);
    scheduleAnalytics();
    await setIndex(state.rows.length - 1);
    prefetch(Math.max(0, state.rows.length - 4), 3);
  } catch (error) {
    showError(`Could not reach the map service: ${error.message}`);
    return;
  }
  setInterval(refreshLive, POLL_MS);
  setInterval(renderStatus, 30 * 1000);
}

bootstrap();

/* War of Dots — Nations campaign map frontend. */
"use strict";

const API = "https://wod-nations-map.moreofdots.workers.dev";
const MASK_URL = "assets/playable-mask.bitset.zlib";
const TERRAIN_URL = "assets/world_map.png";
const CITY_DATA_URL = "assets/city-points.json";
const PLAYER_COLORS_URL = "assets/player-colors.json";

const RED_RGB = [217, 65, 65];
const BLUE_RGB = [63, 108, 224];
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const MEMORY_CONSTRAINED = IS_IOS
  || (Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4);
const CACHE_LIMIT = MEMORY_CONSTRAINED ? 1 : 8; // each decoded 1920x1080 canvas is about 8 MiB
const OWNERSHIP_CACHE_LIMIT = MEMORY_CONSTRAINED ? 2 : 12;
const PREFETCH_COUNT = MEMORY_CONSTRAINED ? 0 : 3;
const EMPTY_FRONTS = new Uint32Array(0);
const POLL_MS = 5 * 60 * 1000;
const SESSION_KEY = "wod-nations-access-session";

if (IS_IOS) document.documentElement.classList.add("ios");
if (MEMORY_CONSTRAINED) document.documentElement.classList.add("memory-constrained");

let accessToken = readSessionToken();
let appStarted = false;
let accessGateActive = false;

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
  overlayAlpha: $("overlay-alpha"),
  showCities: $("show-cities"),
  showObjectives: $("show-objectives"),
  showPerimeters: $("show-perimeters"),
  showCityDensity: $("show-city-density"),
  densityOverlay: $("density-overlay"),
  regionSelect: $("region-select"),
  regionIntel: $("region-intel"),
  regionStatus: $("region-status"),
  regionStats: $("region-stats"),
  regionRedPixels: $("region-red-pixels"),
  regionBluePixels: $("region-blue-pixels"),
  regionRedCities: $("region-red-cities"),
  regionBlueCities: $("region-blue-cities"),
  regionCityDensity: $("region-city-density"),
  playBtn: $("play-btn"),
  playSpeed: $("play-speed"),
  slider: $("timeline-slider"),
  timelineLabel: $("timeline-label"),
  timelinePos: $("timeline-pos"),
  loadOlder: $("load-older"),
  newsText: $("news-text"),
  chartStatus: $("chart-status"),
  chartDescription: $("chart-description"),
  chartModeButtons: document.querySelectorAll("[data-chart-mode]"),
  chartSeriesButtons: document.querySelectorAll("[data-chart-series]"),
  chartRangeButtons: document.querySelectorAll("[data-chart-range]"),
  chartWrap: $("chart-wrap"),
  chartSvg: $("chart-svg"),
  chartTooltip: $("chart-tooltip"),
  snapshotNote: $("snapshot-note"),
  snapTbody: $("snap-tbody"),
  islandDetails: $("island-details"),
  islandTableNote: $("island-table-note"),
  islandTbody: $("island-tbody"),
  leaderboardsSection: $("leaderboards"),
  leaderboardStatus: $("leaderboard-status"),
  leaderboardMetricButtons: document.querySelectorAll("[data-leaderboard-metric]"),
  leaderboardGraphDescription: $("leaderboard-graph-description"),
  leaderboardGraphWrap: $("leaderboard-graph-wrap"),
  leaderboardGraph: $("leaderboard-graph"),
  leaderboardTimelineDescription: $("leaderboard-timeline-description"),
  leaderboardTimelineStatus: $("leaderboard-timeline-status"),
  leaderboardTimelineViewButtons: document.querySelectorAll("[data-leaderboard-timeline-view]"),
  leaderboardTimelineRangeButtons: document.querySelectorAll("[data-leaderboard-timeline-range]"),
  leaderboardTimelineWrap: $("leaderboard-timeline-wrap"),
  leaderboardTimeline: $("leaderboard-timeline"),
  leaderboardTimelineTooltip: $("leaderboard-timeline-tooltip"),
};

const state = {
  rows: [], // chronological (oldest first)
  nextBefore: null,
  index: -1,
  playing: false,
  playTimer: null,
  renderToken: 0,
  activeRender: null,
  queuedRender: null,
  loadingTimer: null,
  mask: null,
  terrain: null,
  cityData: null,
  cityMarkers: [],
  cityOwnershipIndices: new Map(), // dimensions -> city index in compact ownership bitset
  ownershipCache: new Map(), // mapHash -> Promise<Uint8Array>
  cache: new Map(), // mapHash -> Promise<{canvas, red, blue}>
  stats: new Map(), // mapHash -> pixel and city counts for the chart and log
  chartMode: "movement",
  chartSeries: "land",
  chartRange: "all",
  current: null, // {row, entry}
  overlayAlpha: 0.55,
  health: null,
  leaderboards: {
    elo: [],
    world: [],
    playerColors: Object.create(null),
    fetchedAt: null,
    history: [],
    historyFetchedAt: null,
    historyError: null,
    metric: "world",
    highlightedPlayer: null,
    timelineView: "players",
    timelineRange: "all",
  },
  view: { scale: 1, tx: 0, ty: 0, fit: 1 },
  region: {
    selecting: false,
    pointerInside: false,
    lastPointer: null,
    hoveredId: 0,
    selectedId: 0,
    bounds: null,
    pointerId: null,
    start: null,
    dragging: false,
    labels: null,
    islands: null,
    overlayImage: null,
    renderFrame: null,
    scope: null,
    stats: new Map(),
    generation: 0,
  },
  islandDetails: {
    cityIslandIds: null,
    labels: new Map(),
    stats: null,
    statsHash: null,
    renderFrame: null,
    layoutFrame: null,
    sortKey: "area",
    sortDirection: "desc",
  },
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
  const alreadyActive = accessGateActive;
  accessGateActive = true;
  if (accessToken) saveSessionToken("");
  document.documentElement.dataset.accessState = "locked";
  els.accessGate.hidden = false;
  els.accessError.textContent = message;
  els.accessError.hidden = !message;
  if (!alreadyActive) {
    els.accessCode.value = "";
    setTimeout(() => els.accessCode.focus(), 0);
  }
}

function hideAccessGate() {
  accessGateActive = false;
  document.documentElement.dataset.accessState = "authenticated";
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

function getOwnershipBytes(row) {
  const cached = state.ownershipCache.get(row.mapHash);
  if (cached) {
    state.ownershipCache.delete(row.mapHash);
    state.ownershipCache.set(row.mapHash, cached);
    return cached;
  }
  const promise = authenticatedFetch(new URL(row.mapUrl, API)).then(inflate);
  promise.catch(() => {
    if (state.ownershipCache.get(row.mapHash) === promise) state.ownershipCache.delete(row.mapHash);
  });
  state.ownershipCache.set(row.mapHash, promise);
  while (state.ownershipCache.size > OWNERSHIP_CACHE_LIMIT) {
    state.ownershipCache.delete(state.ownershipCache.keys().next().value);
  }
  return promise;
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
    const bytes = await getOwnershipBytes(row);
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
    // Battlefront detection makes several full-map passes and the rendered
    // glow needs another full-size canvas. Both are too costly during iOS
    // startup; objectives and territory remain available without the glow.
    const fronts = MEMORY_CONSTRAINED
      ? EMPTY_FRONTS
      : buildBattlefronts(row, built.rgba);
    const cityOwners = sampleCityOwners(row, built.rgba);
    setStat(row.mapHash, built.red, built.blue, countCityOwners(cityOwners));
    return { canvas, red: built.red, blue: built.blue, cityOwners, fronts };
  })();
  promise.catch(() => state.cache.delete(row.mapHash));
  state.cache.set(row.mapHash, promise);
  while (state.cache.size > CACHE_LIMIT) {
    const evictedHash = state.cache.keys().next().value;
    const evicted = state.cache.get(evictedHash);
    state.cache.delete(evictedHash);
    // WebKit can retain an evicted canvas backing store until its dimensions
    // change. Release it eagerly unless it is still the displayed snapshot.
    evicted.then((entry) => {
      if (!state.cache.has(evictedHash) && state.current?.entry !== entry) {
        entry.canvas.width = 1;
        entry.canvas.height = 1;
      }
    }).catch(() => {});
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
  scheduleIslandDetailsRender();
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
  scheduleDensityLabelLayout();
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
  if (MEMORY_CONSTRAINED) {
    canvas.classList.add("is-hidden");
    if (canvas.width !== 1 || canvas.height !== 1) {
      canvas.width = 1;
      canvas.height = 1;
    }
    return;
  }
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

function regionPoint(event) {
  const rect = els.viewport.getBoundingClientRect();
  const { scale, tx, ty } = state.view;
  return {
    x: Math.max(0, Math.min(MAP_W, (event.clientX - rect.left - tx) / scale)),
    y: Math.max(0, Math.min(MAP_H, (event.clientY - rect.top - ty) / scale)),
  };
}

function buildIslandIndex(mask) {
  const total = MAP_W * MAP_H;
  const labels = new Uint16Array(total);
  const queue = new Uint32Array(total);
  const islands = [null]; // component ids are one-based; zero means ocean

  for (let seed = 0; seed < total; seed += 1) {
    if (labels[seed] !== 0 || !bit(mask, seed)) continue;
    const id = islands.length;
    let head = 0;
    let tail = 0;
    let pixels = 0;
    let minX = MAP_W;
    let minY = MAP_H;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    labels[seed] = id;
    queue[tail++] = seed;

    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % MAP_W;
      const y = Math.floor(pixel / MAP_W);
      pixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;

      if (x > 0 && labels[pixel - 1] === 0 && bit(mask, pixel - 1)) {
        labels[pixel - 1] = id;
        queue[tail++] = pixel - 1;
      }
      if (x + 1 < MAP_W && labels[pixel + 1] === 0 && bit(mask, pixel + 1)) {
        labels[pixel + 1] = id;
        queue[tail++] = pixel + 1;
      }
      if (y > 0 && labels[pixel - MAP_W] === 0 && bit(mask, pixel - MAP_W)) {
        labels[pixel - MAP_W] = id;
        queue[tail++] = pixel - MAP_W;
      }
      if (y + 1 < MAP_H && labels[pixel + MAP_W] === 0 && bit(mask, pixel + MAP_W)) {
        labels[pixel + MAP_W] = id;
        queue[tail++] = pixel + MAP_W;
      }
    }

    islands.push({
      id,
      pixels,
      minX,
      minY,
      maxX,
      maxY,
      centerX: sumX / pixels,
      centerY: sumY / pixels,
      anchorX: minX,
      anchorY: minY,
      anchorDistance: Infinity,
      rank: 0,
      cityIndexes: [],
    });
  }

  // Anchor badges to actual land nearest each component's centroid so labels
  // do not float in bays or holes on irregular islands.
  for (let pixel = 0; pixel < total; pixel += 1) {
    const id = labels[pixel];
    if (!id) continue;
    const island = islands[id];
    const x = pixel % MAP_W;
    const y = Math.floor(pixel / MAP_W);
    const dx = x - island.centerX;
    const dy = y - island.centerY;
    const distance = dx * dx + dy * dy;
    if (distance < island.anchorDistance) {
      island.anchorDistance = distance;
      island.anchorX = x + 0.5;
      island.anchorY = y + 0.5;
    }
  }

  islands.slice(1)
    .sort((a, b) => b.pixels - a.pixels)
    .forEach((island, index) => { island.rank = index + 1; });

  state.region.labels = labels;
  state.region.islands = islands;
}

function islandAtMapPoint(point) {
  const { labels } = state.region;
  if (!labels || point.x < 0 || point.y < 0 || point.x >= MAP_W || point.y >= MAP_H) return 0;
  const x = Math.min(MAP_W - 1, Math.floor(point.x));
  const y = Math.min(MAP_H - 1, Math.floor(point.y));
  return labels[y * MAP_W + x];
}

/* ---------- Island density and landmass details ---------- */

function formatIslandDensity(island) {
  return (island.cityIndexes.length * 10000 / island.pixels).toFixed(1);
}

function buildIslandCityIndex() {
  if (!state.region.islands || !state.cityData) return;
  const { worldSize, cities } = state.cityData;
  const cityIslandIds = new Uint16Array(cities.length);
  for (const island of state.region.islands.slice(1)) island.cityIndexes = [];
  cities.forEach(([x, y], index) => {
    const mapX = Math.min(MAP_W - 1, Math.max(0, Math.floor(x * MAP_W / worldSize.width)));
    const mapY = Math.min(MAP_H - 1, Math.max(0, Math.floor(y * MAP_H / worldSize.height)));
    const islandId = state.region.labels[mapY * MAP_W + mapX];
    cityIslandIds[index] = islandId;
    if (islandId) state.region.islands[islandId].cityIndexes.push(index);
  });
  state.islandDetails.cityIslandIds = cityIslandIds;
}

function buildDensityLabels() {
  els.densityOverlay.replaceChildren();
  state.islandDetails.labels.clear();
  if (!state.region.islands) return;
  const fragment = document.createDocumentFragment();
  const islands = state.region.islands.slice(1).sort((a, b) => a.rank - b.rank);
  const largestCityCount = Math.max(...islands.map((island) => island.cityIndexes.length));
  for (const island of islands) {
    if (island.cityIndexes.length === 0) continue;
    const cityScale = Math.sqrt(island.cityIndexes.length / largestCityCount);
    const fontSize = 9 + cityScale * 8;
    const label = document.createElement("div");
    label.className = "density-label owner-unclaimed";
    label.dataset.islandId = String(island.id);
    label.style.setProperty("--city-label-size", `${fontSize.toFixed(1)}px`);
    label.innerHTML = `
      <span class="density-owner-dot"></span>
      <span class="density-label-copy">
        <span class="density-meta">${formatIslandDensity(island)}</span>
        <span class="density-count">${island.cityIndexes.length.toLocaleString()} cities</span>
      </span>
    `;
    label.title = `Landmass ${island.rank}: ${island.cityIndexes.length.toLocaleString()} cities; density ${formatIslandDensity(island)}`;
    fragment.append(label);
    state.islandDetails.labels.set(island.id, label);
  }
  els.densityOverlay.append(fragment);
}

function ensureIslandIndex() {
  if (!state.mask || !state.cityData) return false;
  if (!state.region.labels) buildIslandIndex(state.mask);
  if (!state.islandDetails.cityIslandIds) {
    buildIslandCityIndex();
    buildDensityLabels();
  }
  return true;
}

function controllerForIsland(stats) {
  const claimed = stats.red + stats.blue;
  if (!claimed) return { key: "unclaimed", label: "Unclaimed", share: 0 };
  if (stats.red === stats.blue) return { key: "mixed", label: "Contested", share: 50 };
  const red = stats.red > stats.blue;
  const share = (Math.max(stats.red, stats.blue) / claimed) * 100;
  return {
    key: red ? "red" : "blue",
    label: red ? "Red Empire" : "Blue Republic",
    share,
  };
}

function computeIslandSnapshotStats() {
  if (!state.current || !ensureIslandIndex()) return null;
  const islands = state.region.islands;
  const length = islands.length;
  const redSamples = new Uint32Array(length);
  const blueSamples = new Uint32Array(length);
  const cityRed = new Uint16Array(length);
  const cityBlue = new Uint16Array(length);
  const { entry } = state.current;
  const { width, height } = entry.canvas;
  const rgba = entry.canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const nativeSize = width === MAP_W && height === MAP_H;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    if (rgba[offset + 3] === 0) continue;
    let islandId;
    if (nativeSize) {
      islandId = state.region.labels[pixel];
    } else {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const mapX = Math.min(MAP_W - 1, Math.floor((x + 0.5) * MAP_W / width));
      const mapY = Math.min(MAP_H - 1, Math.floor((y + 0.5) * MAP_H / height));
      islandId = state.region.labels[mapY * MAP_W + mapX];
    }
    if (!islandId) continue;
    if (rgba[offset] === RED_RGB[0]) redSamples[islandId] += 1;
    else blueSamples[islandId] += 1;
  }

  entry.cityOwners.forEach((owner, cityIndex) => {
    const islandId = state.islandDetails.cityIslandIds[cityIndex];
    if (!islandId) return;
    if (owner === 1) cityRed[islandId] += 1;
    else if (owner === 0) cityBlue[islandId] += 1;
  });

  return islands.map((island, islandId) => {
    if (!island) return null;
    const sampleTotal = redSamples[islandId] + blueSamples[islandId];
    const scale = sampleTotal ? island.pixels / sampleTotal : 0;
    return {
      red: Math.round(redSamples[islandId] * scale),
      blue: Math.round(blueSamples[islandId] * scale),
      cityRed: cityRed[islandId],
      cityBlue: cityBlue[islandId],
    };
  });
}

function updateDensityLabelOwnership(stats) {
  if (!stats) return;
  for (const island of state.region.islands.slice(1)) {
    const label = state.islandDetails.labels.get(island.id);
    if (!label) continue;
    const controller = controllerForIsland(stats[island.id]);
    label.classList.remove("owner-red", "owner-blue", "owner-mixed", "owner-unclaimed");
    label.classList.add(`owner-${controller.key}`);
    label.title = `Landmass ${island.rank}: ${island.cityIndexes.length.toLocaleString()} cities; density ${formatIslandDensity(island)}; ${controller.label} controls ${controller.share.toFixed(1)}%`;
  }
}

function islandSortValue(island, value, key) {
  if (key === "rank") return island.rank;
  if (key === "cities") return island.cityIndexes.length;
  if (key === "land") return value.red + value.blue;
  if (key === "density") return island.cityIndexes.length * 10000 / island.pixels;
  if (key === "control") return controllerForIsland(value).share;
  return island.pixels;
}

function updateIslandSortHeaders() {
  for (const button of document.querySelectorAll("[data-island-sort]")) {
    const active = button.dataset.islandSort === state.islandDetails.sortKey;
    button.classList.toggle("is-active", active);
    button.closest("th").setAttribute(
      "aria-sort",
      active ? (state.islandDetails.sortDirection === "asc" ? "ascending" : "descending") : "none",
    );
  }
}

function formatIslandFactionSplit(red, blue) {
  if (red > 0 && blue > 0) {
    return `<span class="cell-red">${red.toLocaleString()}</span> / <span class="cell-blue">${blue.toLocaleString()}</span>`;
  }
  if (red > 0) return `<span class="cell-red">${red.toLocaleString()}</span>`;
  if (blue > 0) return `<span class="cell-blue">${blue.toLocaleString()}</span>`;
  return "0";
}

function renderIslandTable(stats) {
  if (!stats || !state.current) return;
  const fragment = document.createDocumentFragment();
  const direction = state.islandDetails.sortDirection === "asc" ? 1 : -1;
  const islands = state.region.islands.slice(1)
    .filter((island) => island.cityIndexes.length > 0)
    .sort((a, b) => {
    const aValue = islandSortValue(a, stats[a.id], state.islandDetails.sortKey);
    const bValue = islandSortValue(b, stats[b.id], state.islandDetails.sortKey);
    return (aValue - bValue) * direction || a.rank - b.rank;
    });
  const largestLandArea = Math.max(...islands.map((island) => island.pixels));
  for (const island of islands) {
    const value = stats[island.id];
    const controller = controllerForIsland(value);
    const claimed = value.red + value.blue;
    const redShare = claimed ? value.red / claimed * 100 : 50;
    const landScale = Math.pow(island.pixels / largestLandArea, 0.65);
    const controlWidth = 12 + landScale * 248;
    const row = document.createElement("tr");
    row.dataset.islandId = String(island.id);
    row.tabIndex = 0;
    row.title = `Select landmass ${island.rank} on the map`;
    row.classList.toggle("is-current", state.region.selectedId === island.id);
    row.innerHTML = `
      <td class="num">${island.rank}</td>
      <td class="num split-faction-cell">${formatIslandFactionSplit(value.cityRed, value.cityBlue)}</td>
      <td class="num split-faction-cell">${formatIslandFactionSplit(value.red, value.blue)}</td>
      <td>
        <div class="control-slider owner-${controller.key}" style="--control-width:${controlWidth.toFixed(1)}px" title="${controller.label} ${controller.share.toFixed(1)}% · ${island.pixels.toLocaleString()} land px">
          <span class="control-slider-track">
            <i class="control-slider-red" style="width:${redShare}%"></i>
            <i class="control-slider-blue" style="width:${100 - redShare}%"></i>
          </span>
          <span class="control-slider-label">${controller.label}<small>${controller.share ? ` ${controller.share.toFixed(1)}%` : ""}</small></span>
        </div>
      </td>
      <td class="num">${formatIslandDensity(island)} <small>/ 10k px</small></td>
      <td class="num">${island.pixels.toLocaleString()} px</td>
    `;
    fragment.append(row);
  }
  els.islandTbody.replaceChildren(fragment);
  updateIslandSortHeaders();
  const captured = new Date(state.current.row.capturedAt * 1000);
  const sortLabels = { rank: "#", cities: "cities", land: "land", control: "control", density: "density", area: "land area" };
  const arrow = state.islandDetails.sortDirection === "asc" ? "↑" : "↓";
  els.islandTableNote.textContent = `${islands.length.toLocaleString()} inhabited landmasses · snapshot ${state.index + 1} · ${timeFormat.format(captured)} · sorted by ${sortLabels[state.islandDetails.sortKey]} ${arrow}`;
}

function scheduleIslandDetailsRender() {
  if (!els.showCityDensity.checked || !state.region.labels || !state.current
      || state.islandDetails.renderFrame !== null) return;
  state.islandDetails.renderFrame = requestAnimationFrame(() => {
    state.islandDetails.renderFrame = null;
    if (!state.current) return;
    if (state.islandDetails.statsHash === state.current.row.mapHash && state.islandDetails.stats) {
      scheduleDensityLabelLayout();
      return;
    }
    const stats = computeIslandSnapshotStats();
    if (!stats) return;
    state.islandDetails.stats = stats;
    state.islandDetails.statsHash = state.current.row.mapHash;
    updateDensityLabelOwnership(stats);
    renderIslandTable(stats);
    scheduleDensityLabelLayout();
  });
}

function layoutDensityLabels() {
  state.islandDetails.layoutFrame = null;
  const enabled = Boolean(els.showCityDensity?.checked && state.region.islands);
  els.densityOverlay.classList.toggle("is-hidden", !enabled);
  if (!enabled) return;
  const { scale, tx, ty } = state.view;
  const rect = els.viewport.getBoundingClientRect();
  const islands = state.region.islands.slice(1).sort((a, b) => a.rank - b.rank);

  for (const island of islands) {
    const label = state.islandDetails.labels.get(island.id);
    if (!label) continue;
    const x = island.anchorX * scale + tx;
    const y = island.anchorY * scale + ty;
    label.hidden = x < 0 || x > rect.width || y < 0 || y > rect.height;
    if (label.hidden) continue;
    label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }
}

function scheduleDensityLabelLayout() {
  if (state.islandDetails.layoutFrame !== null) return;
  state.islandDetails.layoutFrame = requestAnimationFrame(layoutDensityLabels);
}

function initializeIslandFeatures() {
  if (!ensureIslandIndex()) return;
  scheduleIslandDetailsRender();
  scheduleDensityLabelLayout();
}

function normalizedRegion(start, end) {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

function paintIsland(image, islandId, fill, edge) {
  const { labels, islands } = state.region;
  const island = islands?.[islandId];
  if (!labels || !island) return;

  const data = image.data;
  for (let y = island.minY; y <= island.maxY; y += 1) {
    const row = y * MAP_W;
    for (let x = island.minX; x <= island.maxX; x += 1) {
      const pixel = row + x;
      if (labels[pixel] !== islandId) continue;
      const coastline = x < 2 || x >= MAP_W - 2 || y < 2 || y >= MAP_H - 2
        || labels[pixel - 1] !== islandId
        || labels[pixel + 1] !== islandId
        || labels[pixel - MAP_W] !== islandId
        || labels[pixel + MAP_W] !== islandId
        || labels[pixel - 2] !== islandId
        || labels[pixel + 2] !== islandId
        || labels[pixel - MAP_W * 2] !== islandId
        || labels[pixel + MAP_W * 2] !== islandId;
      const color = coastline ? edge : fill;
      const offset = pixel * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color[3];
    }
  }
}

function drawRegionOverlay() {
  state.region.renderFrame = null;
  const { selectedId, hoveredId, bounds } = state.region;
  const hasIslandHighlight = Boolean(selectedId || hoveredId);
  const hadHighlight = els.regionOverlay.classList.contains("has-highlight");
  if (!hasIslandHighlight && !bounds && !state.region.overlayImage && !hadHighlight) {
    els.regionOverlay.classList.remove("has-highlight", "is-hovering");
    return;
  }

  const ctx = els.regionOverlay.getContext("2d");
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  if (hasIslandHighlight) {
    if (!state.region.overlayImage) {
      state.region.overlayImage = ctx.createImageData(MAP_W, MAP_H);
    }
    const image = state.region.overlayImage;
    image.data.fill(0);
    if (selectedId) {
      paintIsland(image, selectedId, [240, 169, 46, 60], [255, 253, 246, 245]);
    }
    if (hoveredId) {
      paintIsland(image, hoveredId, [255, 210, 92, 82], [255, 245, 199, 255]);
    }
    ctx.putImageData(image, 0, 0);
  }

  if (bounds) {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    ctx.fillStyle = "rgba(240, 169, 46, 0.18)";
    ctx.fillRect(bounds.left, bounds.top, width, height);
    ctx.strokeStyle = "#fffdf6";
    ctx.lineWidth = Math.max(2, 4 / Math.max(state.view.scale, 0.01));
    ctx.strokeRect(bounds.left, bounds.top, width, height);
  }

  els.regionOverlay.classList.toggle("has-highlight", Boolean(selectedId || hoveredId || bounds));
  els.regionOverlay.classList.toggle("is-hovering", Boolean(hoveredId));
}

function renderRegionOutline() {
  if (state.region.renderFrame !== null) return;
  state.region.renderFrame = requestAnimationFrame(drawRegionOverlay);
}

function setHoveredIsland(islandId) {
  if (islandId === state.region.hoveredId) return;
  state.region.hoveredId = islandId;
  els.viewport.classList.toggle("island-hover", Boolean(islandId));
  renderRegionOutline();
}

function refreshRegionHover() {
  const region = state.region;
  if (!region.selecting || region.pointerId !== null || !region.pointerInside || !region.lastPointer) {
    setHoveredIsland(0);
    return;
  }
  setHoveredIsland(islandAtMapPoint(regionPoint(region.lastPointer)));
}

function setRegionSelection(active) {
  state.region.selecting = active;
  els.regionSelect.classList.toggle("is-active", active);
  els.regionSelect.setAttribute("aria-pressed", String(active));
  els.regionSelect.textContent = active ? "Clear selection" : "Select region";
  els.regionSelect.title = active
    ? "Clear the selected region"
    : "Click an island or drag a rectangular region on the map";
  els.viewport.classList.toggle("selecting-region", active);
  refreshRegionHover();
}

function regionContainsMapPoint(scope, x, y) {
  if (scope.islandId) {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
    return state.region.labels[Math.floor(y) * MAP_W + Math.floor(x)] === scope.islandId;
  }
  const { bounds } = scope;
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function buildRegionScope() {
  const islandId = state.region.selectedId;
  const island = state.region.islands?.[islandId];
  const bounds = state.region.bounds;
  if ((!island && !bounds) || !state.mask || !state.cityData) return null;

  const pixelIndexes = [];
  const ownershipIndexes = [];
  let ownershipIndex = 0;
  for (let pixel = 0; pixel < MAP_W * MAP_H; pixel += 1) {
    if (!bit(state.mask, pixel)) continue;
    const x = pixel % MAP_W;
    const y = Math.floor(pixel / MAP_W);
    const selected = island
      ? state.region.labels[pixel] === islandId
      : x + 0.5 >= bounds.left && x + 0.5 <= bounds.right
        && y + 0.5 >= bounds.top && y + 0.5 <= bounds.bottom;
    if (selected) {
      pixelIndexes.push(pixel);
      ownershipIndexes.push(ownershipIndex);
    }
    ownershipIndex += 1;
  }

  const { worldSize, cities } = state.cityData;
  const cityIndexes = [];
  cities.forEach(([x, y], index) => {
    const mapX = (x * MAP_W) / worldSize.width;
    const mapY = (y * MAP_H) / worldSize.height;
    if (regionContainsMapPoint({ islandId, bounds }, mapX, mapY)) cityIndexes.push(index);
  });

  return {
    generation: state.region.generation,
    islandId,
    bounds: bounds ? { ...bounds } : null,
    mapBounds: island
      ? { left: island.minX, top: island.minY, right: island.maxX + 1, bottom: island.maxY + 1 }
      : { ...bounds },
    pixelIndexes: Uint32Array.from(pixelIndexes),
    ownershipIndexes: Uint32Array.from(ownershipIndexes),
    cityIndexes: Uint32Array.from(cityIndexes),
  };
}

function updateAnalyticsScopeCopy() {
  const regional = Boolean(state.region.scope);
  const baseNote = "Newest first · Δ columns compare with the previous snapshot · click a row to view it";
  els.snapshotNote.textContent = regional ? `Selected region only · ${baseNote}` : baseNote;
  const description = state.chartMode === "movement"
    ? "Movement zooms in on faction advantage across the available polls: up is Blue, down is Red. Solid is land/pixels; dotted is cities."
    : "Control shows Red and Blue shares: solid lines are land, dashed lines are cities. Press and drag to compare.";
  els.chartDescription.textContent = regional ? `Selected region only. ${description}` : description;
}

function commitRegionAnalytics() {
  state.region.generation += 1;
  state.region.scope = buildRegionScope();
  if (state.region.scope) state.region.scope.generation = state.region.generation;
  state.region.stats.clear();
  restartRegionStats(state.region.scope);
  updateAnalyticsScopeCopy();
  scheduleAnalytics();
}

function clearRegionAnalytics() {
  state.region.generation += 1;
  state.region.scope = null;
  state.region.stats.clear();
  restartRegionStats(null);
  updateAnalyticsScopeCopy();
  scheduleAnalytics();
}

function selectIsland(islandId) {
  if (!state.region.islands?.[islandId]) return;
  state.region.selectedId = islandId;
  state.region.bounds = null;
  commitRegionAnalytics();
  renderRegionOutline();
  updateRegionStats();
  for (const row of els.islandTbody.querySelectorAll("tr[data-island-id]")) {
    row.classList.toggle("is-current", Number(row.dataset.islandId) === islandId);
  }
}

function updateRegionStats() {
  const islandId = state.region.selectedId;
  const island = state.region.islands?.[islandId];
  const bounds = state.region.bounds;
  const hasSelection = Boolean(island || bounds);
  const current = state.current;
  els.regionIntel.hidden = !hasSelection;
  els.regionIntel.classList.toggle("has-selection", hasSelection);
  els.regionStats.hidden = !hasSelection;
  if (!hasSelection) {
    els.regionStatus.textContent = "No selection";
    return;
  }
  if (!current) return;

  const width = current.entry.canvas.width;
  const height = current.entry.canvas.height;
  const left = island ? island.minX : bounds.left;
  const top = island ? island.minY : bounds.top;
  const right = island ? island.maxX + 1 : bounds.right;
  const bottom = island ? island.maxY + 1 : bounds.bottom;
  const canvasLeft = Math.floor((left * width) / MAP_W);
  const canvasTop = Math.floor((top * height) / MAP_H);
  const canvasRight = Math.ceil((right * width) / MAP_W);
  const canvasBottom = Math.ceil((bottom * height) / MAP_H);
  const selectionWidth = canvasRight - canvasLeft;
  const selectionHeight = canvasBottom - canvasTop;
  const pixels = current.entry.canvas.getContext("2d")
    .getImageData(canvasLeft, canvasTop, selectionWidth, selectionHeight).data;
  let red = 0;
  let blue = 0;
  for (let y = 0; y < selectionHeight; y += 1) {
    const mapPointY = ((canvasTop + y + 0.5) * MAP_H) / height;
    const mapY = Math.min(MAP_H - 1, Math.floor(mapPointY));
    for (let x = 0; x < selectionWidth; x += 1) {
      const mapPointX = ((canvasLeft + x + 0.5) * MAP_W) / width;
      const mapX = Math.min(MAP_W - 1, Math.floor(mapPointX));
      if (island && state.region.labels[mapY * MAP_W + mapX] !== islandId) continue;
      if (bounds && (mapPointX < bounds.left || mapPointX > bounds.right
          || mapPointY < bounds.top || mapPointY > bounds.bottom)) continue;
      const offset = (y * selectionWidth + x) * 4;
      if (pixels[offset + 3] === 0) continue;
      if (pixels[offset] === RED_RGB[0]) red += 1;
      else blue += 1;
    }
  }

  let cityRed = 0;
  let cityBlue = 0;
  const { worldSize, cities } = state.cityData;
  cities.forEach(([x, y], index) => {
    const mapX = (x * MAP_W) / worldSize.width;
    const mapY = (y * MAP_H) / worldSize.height;
    const selected = island
      ? islandAtMapPoint({ x: mapX, y: mapY }) === islandId
      : mapX >= bounds.left && mapX <= bounds.right && mapY >= bounds.top && mapY <= bounds.bottom;
    if (!selected) return;
    if (current.entry.cityOwners[index] === 1) cityRed += 1;
    else if (current.entry.cityOwners[index] === 0) cityBlue += 1;
  });

  const total = red + blue;
  const redShare = total > 0 ? (red / total) * 100 : null;
  const landArea = island ? island.pixels : total;
  const cityDensity = landArea > 0 ? ((cityRed + cityBlue) * 10000) / landArea : 0;
  els.regionStatus.textContent = island
    ? `${island.pixels.toLocaleString()} land px`
    : `${Math.round(bounds.right - bounds.left)} × ${Math.round(bounds.bottom - bounds.top)} px`;
  els.regionRedPixels.textContent = redShare === null ? "0 px" : `${red.toLocaleString()} px (${redShare.toFixed(1)}%)`;
  els.regionBluePixels.textContent = redShare === null ? "0 px" : `${blue.toLocaleString()} px (${(100 - redShare).toFixed(1)}%)`;
  els.regionRedCities.textContent = cityRed.toLocaleString();
  els.regionBlueCities.textContent = cityBlue.toLocaleString();
  els.regionCityDensity.textContent = `${cityDensity.toFixed(1)} cities / 10k land px`;
  if (state.region.scope) {
    setRegionStat(current.row.mapHash, {
      red,
      blue,
      cityRed,
      cityBlue,
    }, state.region.scope.generation);
  }
}

function clearRegion() {
  state.region.selectedId = 0;
  state.region.bounds = null;
  state.region.pointerId = null;
  state.region.start = null;
  state.region.dragging = false;
  clearRegionAnalytics();
  renderRegionOutline();
  updateRegionStats();
  for (const row of els.islandTbody.querySelectorAll("tr.is-current")) row.classList.remove("is-current");
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

function pumpRenderQueue() {
  if (state.activeRender || !state.queuedRender) return;

  // Decode at most one requested frame at a time. Rapid slider input replaces
  // the queued request below, so work cannot build up behind the pointer.
  const request = state.queuedRender;
  state.queuedRender = null;
  state.activeRender = request;
  state.loadingTimer = setTimeout(() => {
    if (state.activeRender === request && request.token === state.renderToken) {
      els.loading.hidden = false;
    }
  }, 150);

  getDecoded(request.row)
    .then((entry) => {
      if (request.token !== state.renderToken) return;
      const previous = state.current;
      state.current = { row: request.row, entry };
      drawMap();
      updateStats(entry);
      updateRegionStats();
      if (previous && previous.entry !== entry && !state.cache.has(previous.row.mapHash)) {
        previous.entry.canvas.width = 1;
        previous.entry.canvas.height = 1;
      }
      clearError();
    })
    .catch((error) => {
      if (request.token === state.renderToken) {
        showError(`Could not load snapshot #${request.row.id}: ${error.message}`);
      }
    })
    .finally(() => {
      clearTimeout(state.loadingTimer);
      state.loadingTimer = null;
      if (request.token === state.renderToken) els.loading.hidden = true;
      state.activeRender = null;
      request.resolve(request.token === state.renderToken);
      pumpRenderQueue();
    });
}

function setIndex(rawIndex) {
  if (state.rows.length === 0) return Promise.resolve(false);
  const index = Math.max(0, Math.min(state.rows.length - 1, rawIndex));
  state.index = index;
  const row = state.rows[index];
  els.slider.value = String(index);
  updatePanels(row);
  scheduleAnalytics(); // keep the chart marker and log highlight in sync
  const token = ++state.renderToken;
  clearTimeout(state.loadingTimer);
  state.loadingTimer = null;
  els.loading.hidden = true;

  return new Promise((resolve) => {
    if (state.queuedRender) state.queuedRender.resolve(false);
    state.queuedRender = { row, token, resolve };
    pumpRenderQueue();
  });
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
  const rendered = await setIndex(next);
  if (!rendered || !state.playing) return;
  prefetch(next + 1, PREFETCH_COUNT);
  state.playTimer = setTimeout(playbackTick, Number(els.playSpeed.value));
}

function togglePlay() {
  if (!state.playing && state.index >= state.rows.length - 1) {
    setIndex(0).then((rendered) => {
      if (rendered) setPlaying(true);
    });
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
    queueRegionStats(older);
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
      queueRegionStats([latest]);
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
const STATS_CONCURRENCY = MEMORY_CONSTRAINED ? 1 : 4;
const SVG_NS_CHART = "http://www.w3.org/2000/svg";

const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i += 1) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

const statsQueue = [];
const statsQueued = new Set();
let statsActive = 0;
const regionStatsQueue = [];
const regionStatsQueued = new Set();
let regionStatsActive = 0;
let statsPersistTimer = null;
let analyticsTimer = 0;
let analyticsReady = false;
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

function analyticsStatsFor(row) {
  return state.region.scope
    ? state.region.stats.get(row.mapHash)
    : state.stats.get(row.mapHash);
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

function countSelectedCities(owners, scope) {
  let cityRed = 0;
  let cityBlue = 0;
  for (const cityIndex of scope.cityIndexes) {
    if (owners[cityIndex] === 1) cityRed += 1;
    else if (owners[cityIndex] === 0) cityBlue += 1;
  }
  return { cityRed, cityBlue };
}

function countRegionEntry(row, entry, scope) {
  const { width, height } = entry.canvas;
  const canvasLeft = Math.max(0, Math.floor(scope.mapBounds.left * width / MAP_W));
  const canvasTop = Math.max(0, Math.floor(scope.mapBounds.top * height / MAP_H));
  const canvasRight = Math.min(width, Math.ceil(scope.mapBounds.right * width / MAP_W));
  const canvasBottom = Math.min(height, Math.ceil(scope.mapBounds.bottom * height / MAP_H));
  const selectionWidth = canvasRight - canvasLeft;
  const selectionHeight = canvasBottom - canvasTop;
  let red = 0;
  let blue = 0;
  if (selectionWidth > 0 && selectionHeight > 0) {
    const rgba = entry.canvas.getContext("2d")
      .getImageData(canvasLeft, canvasTop, selectionWidth, selectionHeight).data;
    for (let localY = 0; localY < selectionHeight; localY += 1) {
      for (let localX = 0; localX < selectionWidth; localX += 1) {
        const x = (canvasLeft + localX + 0.5) * MAP_W / width;
        const y = (canvasTop + localY + 0.5) * MAP_H / height;
        if (!regionContainsMapPoint(scope, x, y)) continue;
        const offset = (localY * selectionWidth + localX) * 4;
        if (rgba[offset + 3] === 0) continue;
        if (rgba[offset] === RED_RGB[0]) red += 1;
        else blue += 1;
      }
    }
  }
  return { red, blue, ...countSelectedCities(entry.cityOwners, scope) };
}

function countCompactRegion(row, bytes, scope) {
  let red = 0;
  let blue = 0;
  if (row.width === MAP_W && row.height === MAP_H) {
    for (const ownershipIndex of scope.ownershipIndexes) {
      if (bit(bytes, ownershipIndex)) red += 1;
      else blue += 1;
    }
  } else {
    let ownershipIndex = 0;
    for (let pixel = 0; pixel < row.width * row.height; pixel += 1) {
      if (!bit(state.mask, pixel)) continue;
      const x = ((pixel % row.width) + 0.5) * MAP_W / row.width;
      const y = (Math.floor(pixel / row.width) + 0.5) * MAP_H / row.height;
      if (regionContainsMapPoint(scope, x, y)) {
        if (bit(bytes, ownershipIndex)) red += 1;
        else blue += 1;
      }
      ownershipIndex += 1;
    }
  }

  const ownershipIndices = getCityOwnershipIndices(row);
  const owners = new Uint8Array(state.cityData.cities.length).fill(255);
  for (const cityIndex of scope.cityIndexes) {
    const ownershipIndex = ownershipIndices[cityIndex];
    if (ownershipIndex >= 0) owners[cityIndex] = bit(bytes, ownershipIndex);
  }
  return { red, blue, ...countSelectedCities(owners, scope) };
}

function countLegacyRegion(row, bytes, scope) {
  let red = 0;
  let blue = 0;
  if (row.width === MAP_W && row.height === MAP_H) {
    for (const pixel of scope.pixelIndexes) {
      if (bytes[pixel] === 1) red += 1;
      else if (bytes[pixel] === 0) blue += 1;
    }
  } else {
    for (let pixel = 0; pixel < row.width * row.height; pixel += 1) {
      const x = ((pixel % row.width) + 0.5) * MAP_W / row.width;
      const y = (Math.floor(pixel / row.width) + 0.5) * MAP_H / row.height;
      if (!regionContainsMapPoint(scope, x, y)) continue;
      if (bytes[pixel] === 1) red += 1;
      else if (bytes[pixel] === 0) blue += 1;
    }
  }

  const { worldSize, cities } = state.cityData;
  const owners = new Uint8Array(cities.length).fill(255);
  for (const cityIndex of scope.cityIndexes) {
    const [x, y] = cities[cityIndex];
    const px = Math.min(row.width - 1, Math.max(0, Math.floor((x * row.width) / worldSize.width)));
    const py = Math.min(row.height - 1, Math.max(0, Math.floor((y * row.height) / worldSize.height)));
    owners[cityIndex] = bytes[py * row.width + px];
  }
  return { red, blue, ...countSelectedCities(owners, scope) };
}

function setRegionStat(mapHash, stats, generation) {
  if (!state.region.scope || state.region.scope.generation !== generation) return;
  const current = state.region.stats.get(mapHash);
  if (current
      && current.red === stats.red
      && current.blue === stats.blue
      && current.cityRed === stats.cityRed
      && current.cityBlue === stats.cityBlue) return;
  state.region.stats.set(mapHash, stats);
  scheduleAnalytics();
}

async function computeRegionStats(row, scope) {
  const decoded = state.cache.get(row.mapHash);
  if (decoded) {
    try {
      const entry = await decoded;
      setRegionStat(row.mapHash, countRegionEntry(row, entry, scope), scope.generation);
      return;
    } catch { /* decode failed — fall through to a direct fetch */ }
  }
  const bytes = await getOwnershipBytes(row);
  let stats;
  if (row.encoding === "playable-bitset-zlib-v1") stats = countCompactRegion(row, bytes, scope);
  else if (row.encoding === "raw-u8-zlib-v1") stats = countLegacyRegion(row, bytes, scope);
  else throw new Error(`Unsupported map encoding: ${row.encoding}`);
  setRegionStat(row.mapHash, stats, scope.generation);
}

function queueRegionStats(rows, scope = state.region.scope) {
  if (!scope || scope.generation !== state.region.generation) return;
  const missing = rows
    .filter((row) => !state.region.stats.has(row.mapHash))
    .sort((a, b) => b.capturedAt - a.capturedAt);
  for (const row of missing) {
    if (regionStatsQueued.has(row.mapHash)) continue;
    regionStatsQueued.add(row.mapHash);
    regionStatsQueue.push({ row, scope });
  }
  pumpRegionStats();
}

function restartRegionStats(scope) {
  regionStatsQueue.length = 0;
  regionStatsQueued.clear();
  if (scope) queueRegionStats(state.rows, scope);
}

function pumpRegionStats() {
  while (regionStatsActive < STATS_CONCURRENCY && regionStatsQueue.length > 0) {
    const task = regionStatsQueue.shift();
    const { row, scope } = task;
    if (!state.region.scope
        || scope.generation !== state.region.generation
        || state.region.stats.has(row.mapHash)) {
      regionStatsQueued.delete(row.mapHash);
      continue;
    }
    regionStatsActive += 1;
    computeRegionStats(row, scope)
      .catch(() => {})
      .finally(() => {
        regionStatsActive -= 1;
        if (scope.generation === state.region.generation) regionStatsQueued.delete(row.mapHash);
        pumpRegionStats();
      });
  }
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
  const bytes = await getOwnershipBytes(row);
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
  if (!analyticsReady || analyticsTimer) return;
  analyticsTimer = setTimeout(() => {
    analyticsTimer = 0;
    renderChart();
    renderTable();
    if (state.leaderboards.timelineView === "movement" && !leaderboardTimelineDrag) renderLeaderboardTimeline();
  }, MEMORY_CONSTRAINED ? 1000 : 60);
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

function rowsForTimeRange(rows, range, timeOf) {
  if (range === "all" || rows.length === 0) return rows;
  const span = range === "24h" ? 24 * 3600 : range === "1w" ? 7 * 24 * 3600 : null;
  if (span === null) return rows;
  const latest = timeOf(rows.at(-1));
  return rows.filter((row) => timeOf(row) >= latest - span);
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

function renderChartStatus(points, loadedCount, total) {
  const el = els.chartStatus;
  el.replaceChildren();
  const regional = Boolean(state.region.scope);
  const cityStatus = state.chartSeries === "cities";
  const statusPoints = cityStatus ? points.filter((point) => point.cityShare !== null) : points;
  if (total === 0) {
    el.className = "chart-status";
    return;
  }
  if (loadedCount < total) {
    el.textContent = `${regional ? "Selected region · " : ""}Analyzing ${loadedCount} / ${total} snapshots…`;
    el.className = "chart-status";
    return;
  }
  if (statusPoints.length === 0) {
    el.textContent = regional ? "Selected region has no data for this series" : "No data for this series";
    el.className = "chart-status";
    return;
  }
  const latest = statusPoints[statusPoints.length - 1];
  const latestShare = cityStatus ? latest.cityShare : latest.share;
  const margin = latestShare - (100 - latestShare);
  el.className = "chart-status";
  if (regional) el.append("Selected region · ");
  if (cityStatus) el.append("Cities · ");
  if (Math.abs(margin) < 0.005) {
    el.append("Dead heat");
  } else {
    const faction = margin > 0 ? "red" : "blue";
    const name = faction === "red" ? "Red Empire" : "Blue Republic";
    el.append(factionSpan(`${name} leads by ${Math.abs(margin).toFixed(2)}%`, faction, "chart-leader"));
  }

  const baseline = chartTrendBaseline(statusPoints);
  if (latest.t > baseline.t) {
    const change = latestShare - (cityStatus ? baseline.cityShare : baseline.share);
    const span = formatChartSpan(latest.t - baseline.t);
    el.append(" · ");
    if (Math.abs(change) >= 0.005) {
      const faction = change > 0 ? "red" : "blue";
      const name = faction === "red" ? "Red" : "Blue";
      el.append(factionSpan(`${name} +${Math.abs(change).toFixed(2)}% in ${span}`, faction, "chart-change"));
    } else {
      el.append(`No change in ${span}`);
    }
  }
}

function renderChart() {
  const svg = els.chartSvg;
  const width = Math.max(300, Math.floor(els.chartWrap.getBoundingClientRect().width) || 300);
  const height = 250;
  const movementMode = state.chartMode === "movement";
  const showLand = state.chartSeries !== "cities";
  const showCities = state.chartSeries !== "land";
  const seriesName = state.chartSeries === "both" ? "land and city" : state.chartSeries;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-label", movementMode
    ? `${seriesName} faction advantage over time`
    : `Red and blue ${seriesName} control over time`);
  svg.replaceChildren();
  chartHit = null;

  const rows = rowsForTimeRange(state.rows, state.chartRange, (row) => row.capturedAt);
  const points = [];
  let loadedCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const stats = analyticsStatsFor(rows[i]);
    if (stats) loadedCount += 1;
    const share = stats ? shareOf(stats) : null;
    const cityShare = stats ? cityShareOf(stats) : null;
    if (share !== null || (state.chartSeries === "cities" && cityShare !== null)) {
      points.push({
        i,
        t: rows[i].capturedAt,
        share,
        red: stats.red,
        blue: stats.blue,
        cityShare,
        cityRed: stats.cityRed,
        cityBlue: stats.cityBlue,
      });
    }
  }
  renderChartStatus(points, loadedCount, rows.length);
  if (points.length < 2) {
    const message = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart-empty" });
    if (rows.length === 0) message.textContent = "Waiting for snapshots…";
    else if (loadedCount < rows.length) message.textContent = "Analyzing snapshots…";
    else if (state.region.scope) {
      message.textContent = state.chartSeries === "cities"
        ? "No cities in the selected region"
        : "No land in the selected region";
    } else message.textContent = "Not enough snapshot data";
    svg.append(message);
    return;
  }

  for (const point of points) {
    point.landMovement = point.share === null ? null : (100 - point.share) - point.share;
    point.cityMovement = point.cityShare !== null
      ? (100 - point.cityShare) - point.cityShare
      : null;
  }

  const pad = {
    top: 32,
    right: movementMode ? 118 : 66,
    bottom: 26,
    left: width < 420 ? 44 : 56,
  };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const xOf = (t) => (t1 === t0 ? pad.left + plotW / 2 : pad.left + ((t - t0) / (t1 - t0)) * plotW);

  const defs = svgEl("defs", {});
  const gridGradient = svgEl("linearGradient", {
    id: "chart-grid-vertical-gradient",
    x1: 0,
    y1: pad.top,
    x2: 0,
    y2: pad.top + plotH,
    gradientUnits: "userSpaceOnUse",
  });
  gridGradient.append(
    svgEl("stop", { offset: "0%", "stop-color": "#3f6ce0", "stop-opacity": 0.62 }),
    svgEl("stop", { offset: "42%", "stop-color": "#6f7fac", "stop-opacity": 0.34 }),
    svgEl("stop", { offset: "50%", "stop-color": "#77727f", "stop-opacity": 0.28 }),
    svgEl("stop", { offset: "58%", "stop-color": "#a76c73", "stop-opacity": 0.34 }),
    svgEl("stop", { offset: "100%", "stop-color": "#d94141", "stop-opacity": 0.6 }),
  );
  defs.append(gridGradient);
  svg.append(defs);

  let lo = movementMode ? Infinity : 49.5;
  let hi = movementMode ? -Infinity : 50.5;
  for (const p of points) {
    if (movementMode) {
      if (showLand) {
        lo = Math.min(lo, p.landMovement);
        hi = Math.max(hi, p.landMovement);
      }
      if (showCities && p.cityMovement !== null) {
        lo = Math.min(lo, p.cityMovement);
        hi = Math.max(hi, p.cityMovement);
      }
    } else {
      if (showLand) {
        lo = Math.min(lo, p.share, 100 - p.share);
        hi = Math.max(hi, p.share, 100 - p.share);
      }
      if (showCities && p.cityShare !== null) {
        lo = Math.min(lo, p.cityShare, 100 - p.cityShare);
        hi = Math.max(hi, p.cityShare, 100 - p.cityShare);
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = movementMode ? -0.5 : 49.5;
    hi = movementMode ? 0.5 : 50.5;
  }
  const rawSpan = Math.max(movementMode ? 0.12 : 0.6, hi - lo);
  const padY = rawSpan * (movementMode ? 0.18 : 0.12);
  lo = movementMode ? lo - padY : Math.max(0, lo - padY);
  hi = movementMode ? hi + padY : Math.min(100, hi + padY);
  const yOf = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;

  const buildLine = (valueOf) => {
    let path = "";
    let segmentLength = 0;
    for (const point of points) {
      const value = valueOf(point);
      if (value === null || !Number.isFinite(value)) {
        segmentLength = 0;
        continue;
      }
      const x = xOf(point.t).toFixed(1);
      path += `${segmentLength === 0 ? "M" : "L"}${x},${yOf(value).toFixed(1)}`;
      segmentLength += 1;
    }
    return path;
  };
  const buildSlopeGradient = (id, valueOf) => {
    const samples = points
      .map((point) => ({ point, value: valueOf(point) }))
      .filter((sample) => sample.value !== null && Number.isFinite(sample.value));
    const slopes = samples.map((sample, index) => {
      const before = samples[Math.max(0, index - 1)];
      const after = samples[Math.min(samples.length - 1, index + 1)];
      const hours = Math.max(1 / 60, (after.point.t - before.point.t) / 3600);
      return (after.value - before.value) / hours;
    });
    const maxSlope = Math.max(0, ...slopes.map(Math.abs));
    const neutral = [126, 111, 147];
    const gradient = svgEl("linearGradient", {
      id,
      x1: pad.left,
      y1: 0,
      x2: pad.left + plotW,
      y2: 0,
      gradientUnits: "userSpaceOnUse",
    });
    for (let index = 0; index < samples.length; index += 1) {
      const slope = slopes[index];
      const ratio = maxSlope > 0 ? Math.sqrt(Math.abs(slope) / maxSlope) : 0;
      const strength = Math.abs(slope) < 1e-9 ? 0 : 0.68 + ratio * 0.32;
      const target = slope > 1e-9 ? [63, 108, 224] : slope < -1e-9 ? [217, 65, 65] : neutral;
      const color = neutral.map((channel, colorIndex) => (
        Math.round(channel + (target[colorIndex] - channel) * strength)
      ));
      const offset = t1 === t0 ? 0 : ((samples[index].point.t - t0) / (t1 - t0)) * 100;
      gradient.append(svgEl("stop", {
        offset: `${Math.max(0, Math.min(100, offset)).toFixed(2)}%`,
        "stop-color": `rgb(${color.join(", ")})`,
      }));
    }
    return gradient;
  };
  if (movementMode) {
    if (showLand) defs.append(buildSlopeGradient("chart-land-slope-gradient", (p) => p.landMovement));
    if (showCities) defs.append(buildSlopeGradient("chart-city-slope-gradient", (p) => p.cityMovement));
  }
  const redLine = buildLine((p) => movementMode ? p.landMovement : p.share);
  const blueLine = movementMode ? "" : buildLine((p) => 100 - p.share);
  const cityRedLine = buildLine((p) => movementMode ? p.cityMovement : p.cityShare);
  const cityBlueLine = movementMode ? "" : buildLine((p) => p.cityShare === null ? null : 100 - p.cityShare);
  const bottom = (pad.top + plotH).toFixed(1);
  const firstX = xOf(points[0].t).toFixed(1);
  const lastX = xOf(points[points.length - 1].t).toFixed(1);
  if (movementMode) {
    const halfPlot = plotH / 2;
    svg.append(
      svgEl("rect", { x: pad.left, y: pad.top, width: plotW, height: halfPlot, class: "chart-zone-blue" }),
      svgEl("rect", { x: pad.left, y: pad.top + halfPlot, width: plotW, height: halfPlot, class: "chart-zone-red" }),
    );
  } else if (showLand) {
    svg.append(
      svgEl("path", { d: `${redLine}L${lastX},${bottom}L${firstX},${bottom}Z`, class: "chart-area chart-area-red" }),
      svgEl("path", { d: `${blueLine}L${lastX},${bottom}L${firstX},${bottom}Z`, class: "chart-area chart-area-blue" }),
    );
  }

  // Local midnight dividers make each campaign day easy to scan.
  const dayCursor = new Date(t0 * 1000);
  dayCursor.setHours(24, 0, 0, 0);
  while (dayCursor.getTime() / 1000 < t1) {
    const x = xOf(dayCursor.getTime() / 1000).toFixed(1);
    svg.append(svgEl("line", {
      x1: x,
      x2: x,
      y1: pad.top,
      y2: pad.top + plotH,
      class: "chart-day-line",
    }));
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  // Gridlines with a step that yields a handful of lines.
  let step = 20;
  const stepCandidates = movementMode
    ? [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20]
    : [0.25, 0.5, 1, 2, 5, 10, 20];
  for (const candidate of stepCandidates) {
    if ((hi - lo) / candidate <= 6) {
      step = candidate;
      break;
    }
  }
  const gridLabelElements = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    const middle = movementMode ? 0 : 50;
    if (Math.abs(v - middle) < 1e-9) continue;
    const yValue = yOf(v);
    const y = yValue.toFixed(1);
    const gridClass = movementMode ? "chart-grid chart-grid-movement" : "chart-grid";
    svg.append(svgEl("line", { x1: pad.left, x2: pad.left + plotW, y1: y, y2: y, class: gridClass }));
    let labelText;
    if (movementMode) {
      const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
      labelText = `${v > 0 ? "+" : ""}${v.toFixed(decimals)}%`;
    } else {
      labelText = `${step < 1 ? v.toFixed(2) : Math.round(v)}%`;
    }
    const label = svgEl("text", {
      x: pad.left - 7,
      y: yValue + 4,
      "text-anchor": "end",
      class: "chart-grid-label",
    });
    label.textContent = labelText;
    gridLabelElements.push(label);
  }
  const middle = movementMode ? 0 : 50;
  if (lo <= middle && hi >= middle) {
    const y = yOf(middle).toFixed(1);
    svg.append(svgEl("line", { x1: pad.left, x2: pad.left + plotW, y1: y, y2: y, class: "chart-mid" }));
    const labelText = movementMode ? "0%" : "50%";
    const middleY = yOf(middle);
    const label = svgEl("text", {
      x: pad.left - 7,
      y: middleY + 4,
      "text-anchor": "end",
      class: "chart-grid-label",
    });
    label.textContent = labelText;
    gridLabelElements.push(label);
  }

  if (movementMode) {
    const blueDirection = svgEl("text", {
      x: pad.left + plotW - 5,
      y: pad.top + 13,
      "text-anchor": "end",
      class: "chart-direction-label blue",
    });
    blueDirection.textContent = "BLUE ↑";
    const redDirection = svgEl("text", {
      x: pad.left + plotW - 5,
      y: pad.top + plotH - 7,
      "text-anchor": "end",
      class: "chart-direction-label red",
    });
    redDirection.textContent = "RED ↓";
    svg.append(blueDirection, redDirection);
  }

  const legend = [];
  let legendX = pad.left;
  if (showLand) {
    legend.push(svgEl("line", {
      x1: legendX,
      x2: legendX + 22,
      y1: 12,
      y2: 12,
      class: movementMode ? "chart-line chart-line-land-movement" : "chart-line chart-line-red",
    }));
    const landKeyLabel = svgEl("text", { x: legendX + 28, y: 16, class: "chart-series-label" });
    landKeyLabel.textContent = movementMode ? "Land / pixels" : "Land";
    legend.push(landKeyLabel);
    legendX += movementMode ? 112 : 78;
  }
  if (showCities) {
    legend.push(svgEl("line", {
      x1: legendX,
      x2: legendX + 22,
      y1: 12,
      y2: 12,
      class: movementMode ? "chart-line chart-line-city-movement" : "chart-line chart-line-red chart-line-city",
    }));
    const cityKeyLabel = svgEl("text", { x: legendX + 28, y: 16, class: "chart-series-label" });
    cityKeyLabel.textContent = "Cities";
    legend.push(cityKeyLabel);
  }
  svg.append(...legend);

  // Time axis.
  const spanSeconds = t1 - t0;
  const tickFormat = new Intl.DateTimeFormat(
    undefined,
    spanSeconds > 3 * 86400
      ? { month: "short", day: "numeric" }
      : { weekday: "short", hour: "2-digit", minute: "2-digit" },
  );
  const tickCount = width < 420 ? 2 : width < 520 ? 3 : 5;
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
      const markers = [];
      if (showLand && movementMode) {
        markers.push(svgEl("circle", { cx: x, cy: yOf(currentPoint.landMovement).toFixed(1), r: 4, class: "chart-dot chart-dot-land" }));
      } else if (showLand) {
        markers.push(
          svgEl("circle", { cx: x, cy: yOf(currentPoint.share).toFixed(1), r: 4, class: "chart-dot chart-dot-red" }),
          svgEl("circle", { cx: x, cy: yOf(100 - currentPoint.share).toFixed(1), r: 4, class: "chart-dot chart-dot-blue" }),
        );
      }
      if (showCities && movementMode && currentPoint.cityMovement !== null) {
        markers.push(svgEl("rect", { x: Number(x) - 3.5, y: yOf(currentPoint.cityMovement) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-city" }));
      } else if (showCities && !movementMode && currentPoint.cityShare !== null) {
        markers.push(
          svgEl("rect", { x: Number(x) - 3.5, y: yOf(currentPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-red" }),
          svgEl("rect", { x: Number(x) - 3.5, y: yOf(100 - currentPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-blue" }),
        );
      }
      svg.append(...markers);
    }
  }

  if (movementMode) {
    if (showLand) svg.append(svgEl("path", { d: redLine, class: "chart-line chart-line-land-movement" }));
    if (showCities) svg.append(svgEl("path", { d: cityRedLine, class: "chart-line chart-line-city-movement" }));
  } else {
    if (showLand) {
      svg.append(
        svgEl("path", { d: redLine, class: "chart-line chart-line-red" }),
        svgEl("path", { d: blueLine, class: "chart-line chart-line-blue" }),
      );
    }
    if (showCities) {
      svg.append(
        svgEl("path", { d: cityRedLine, class: "chart-line chart-line-red chart-line-city" }),
        svgEl("path", { d: cityBlueLine, class: "chart-line chart-line-blue chart-line-city" }),
      );
    }
  }

  // Keep scale labels readable above the plotted series.
  svg.append(...gridLabelElements);

  // Live endpoints: pulsing dots plus the latest value, election-night style.
  const endPoint = points[points.length - 1];
  const endX = xOf(endPoint.t);
  const endpointLabels = [];
  if (movementMode) {
    if (showLand) {
      const y = yOf(endPoint.landMovement);
      svg.append(
        svgEl("circle", { cx: endX, cy: y, r: 8, class: "chart-pulse chart-pulse-neutral" }),
        svgEl("circle", { cx: endX, cy: y, r: 3.5, class: "chart-dot chart-dot-land" }),
      );
      endpointLabels.push({
        y,
        className: "neutral",
        text: `Land · ${endPoint.landMovement >= 0 ? "Blue" : "Red"} +${Math.abs(endPoint.landMovement).toFixed(2)}%`,
      });
    }
    if (showCities && endPoint.cityMovement !== null) {
      const y = yOf(endPoint.cityMovement);
      svg.append(
        svgEl("circle", { cx: endX, cy: y, r: 8, class: "chart-pulse chart-pulse-gold" }),
        svgEl("rect", { x: endX - 3.5, y: y - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-city chart-city-end" }),
      );
      endpointLabels.push({
        y,
        className: "gold",
        text: `Cities · ${endPoint.cityMovement >= 0 ? "Blue" : "Red"} +${Math.abs(endPoint.cityMovement).toFixed(1)}%`,
      });
    }
  } else {
    const cityOnly = !showLand && showCities && endPoint.cityShare !== null;
    const redValue = cityOnly ? endPoint.cityShare : endPoint.share;
    const blueValue = 100 - redValue;
    const yRed = yOf(redValue);
    const yBlue = yOf(blueValue);
    if (showLand || cityOnly) {
      svg.append(
        svgEl("circle", { cx: endX, cy: yRed, r: 8, class: "chart-pulse chart-pulse-red" }),
        svgEl("circle", { cx: endX, cy: yBlue, r: 8, class: "chart-pulse chart-pulse-blue" }),
      );
      if (cityOnly) {
        svg.append(
          svgEl("rect", { x: endX - 3.5, y: yRed - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-red chart-city-end" }),
          svgEl("rect", { x: endX - 3.5, y: yBlue - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-blue chart-city-end" }),
        );
      } else {
        svg.append(
          svgEl("circle", { cx: endX, cy: yRed, r: 3.5, class: "chart-dot chart-dot-red" }),
          svgEl("circle", { cx: endX, cy: yBlue, r: 3.5, class: "chart-dot chart-dot-blue" }),
        );
      }
      endpointLabels.push(
        { y: yRed, className: "red", text: `${redValue.toFixed(2)}%` },
        { y: yBlue, className: "blue", text: `${blueValue.toFixed(2)}%` },
      );
    }
    if (showLand && showCities && endPoint.cityShare !== null) {
      svg.append(
        svgEl("rect", { x: endX - 3.5, y: yOf(endPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-red chart-city-end" }),
        svgEl("rect", { x: endX - 3.5, y: yOf(100 - endPoint.cityShare) - 3.5, width: 7, height: 7, class: "chart-dot chart-dot-blue chart-city-end" }),
      );
    }
  }
  if (endpointLabels.length === 2 && Math.abs(endpointLabels[0].y - endpointLabels[1].y) < 16) {
    const mid = (endpointLabels[0].y + endpointLabels[1].y) / 2;
    const sign = endpointLabels[0].y <= endpointLabels[1].y ? 1 : -1;
    endpointLabels[0].y = mid - 8 * sign;
    endpointLabels[1].y = mid + 8 * sign;
  }
  for (const endpoint of endpointLabels) {
    const label = svgEl("text", {
      x: endX + 8,
      y: endpoint.y + 4,
      class: `chart-end-label ${endpoint.className}`,
    });
    label.textContent = endpoint.text;
    svg.append(label);
  }

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
    mode: state.chartMode,
    series: state.chartSeries,
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
  const showLand = chartHit?.series !== "cities";
  const showCities = chartHit?.series !== "land";
  if (chartHit?.mode === "movement") {
    tooltip.append(when);
    if (showLand) {
      const land = document.createElement("div");
      const landFaction = point.landMovement > 0 ? "blue" : point.landMovement < 0 ? "red" : null;
      land.className = landFaction ? `tt-${landFaction}` : "";
      land.textContent = Math.abs(point.landMovement) < 0.0005
        ? "Land / pixels · No net movement"
        : `Land / pixels · ${landFaction === "blue" ? "Blue" : "Red"} +${Math.abs(point.landMovement).toFixed(3)}%`;
      tooltip.append(land);
    }
    if (showCities && point.cityMovement !== null) {
      const cities = document.createElement("div");
      const cityFaction = point.cityMovement > 0 ? "blue" : point.cityMovement < 0 ? "red" : null;
      cities.className = `tt-cities${cityFaction ? ` tt-${cityFaction}` : ""}`;
      cities.textContent = Math.abs(point.cityMovement) < 0.0005
        ? "Cities · No net movement"
        : `Cities · ${cityFaction === "blue" ? "Blue" : "Red"} +${Math.abs(point.cityMovement).toFixed(1)}%`;
      tooltip.append(cities);
    }
    const control = document.createElement("div");
    control.className = "tt-time";
    control.textContent = !showLand && point.cityShare !== null
      ? `Current cities · R ${point.cityRed} / B ${point.cityBlue}`
      : `Current land · R ${point.share.toFixed(2)}% / B ${(100 - point.share).toFixed(2)}%`;
    tooltip.append(control);
    const hint = document.createElement("div");
    hint.className = "tt-change";
    hint.textContent = "Press and drag to compare snapshots";
    tooltip.append(hint);
    positionChartTooltip(point.x);
    return;
  }
  tooltip.append(when);
  if (showLand) {
    const red = document.createElement("div");
    red.className = "tt-red";
    red.textContent = `Land · Red ${point.share.toFixed(3)}%`;
    const blue = document.createElement("div");
    blue.className = "tt-blue";
    blue.textContent = `Land · Blue ${(100 - point.share).toFixed(3)}%`;
    tooltip.append(red, blue);
  }
  if (showCities && point.cityShare !== null) {
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
  tooltip.append(range, duration);
  if (chartHit?.series !== "cities") {
    const landChange = end.share - start.share;
    const landGained = landChange >= 0 ? end.red - start.red : end.blue - start.blue;
    tooltip.append(changeLine("Land", landChange, landGained, "px"));
  }
  if (chartHit?.series !== "land" && start.cityShare !== null && end.cityShare !== null) {
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
    const stats = analyticsStatsFor(row);
    const share = stats ? shareOf(stats) : null;
    const prevStats = i > 0 ? analyticsStatsFor(rows[i - 1]) : undefined;
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

    if (!stats) {
      addCell(tr, "num cell-flat", "…");
    } else {
      const leadPx = stats.red - stats.blue;
      factionCell(tr, leadPx, Math.abs(leadPx).toLocaleString());
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
  for (const button of els.chartRangeButtons) {
    button.addEventListener("click", () => {
      const range = button.dataset.chartRange;
      if (!["24h", "1w", "all"].includes(range)) return;
      state.chartRange = range;
      for (const option of els.chartRangeButtons) {
        const active = option.dataset.chartRange === range;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-pressed", String(active));
      }
      chartLeave();
      renderChart();
    });
  }
  for (const button of els.chartModeButtons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.chartMode;
      if (mode !== "movement" && mode !== "control") return;
      state.chartMode = mode;
      for (const option of els.chartModeButtons) {
        const active = option.dataset.chartMode === mode;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-pressed", String(active));
      }
      updateAnalyticsScopeCopy();
      chartLeave();
      renderChart();
    });
  }
  for (const button of els.chartSeriesButtons) {
    button.addEventListener("click", () => {
      const series = button.dataset.chartSeries;
      if (!["both", "land", "cities"].includes(series)) return;
      state.chartSeries = series;
      for (const option of els.chartSeriesButtons) {
        const active = option.dataset.chartSeries === series;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-pressed", String(active));
      }
      chartLeave();
      renderChart();
    });
  }
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

/* ---------- Player leaderboards ---------- */

function leaderboardFaction(value) {
  return value === "red" || value === "blue" ? value : "neutral";
}

function leaderboardPlayerKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function leaderboardPlayerFaction(player) {
  const override = state.leaderboards.playerColors[leaderboardPlayerKey(player.nickname)];
  return leaderboardFaction(override ?? player.faction);
}

async function loadLeaderboardPlayerColors() {
  const data = await fetchJSON(PLAYER_COLORS_URL);
  const colors = Object.create(null);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [nickname, faction] of Object.entries(data)) {
      const normalizedFaction = leaderboardFaction(faction);
      if (normalizedFaction !== "neutral") colors[leaderboardPlayerKey(nickname)] = normalizedFaction;
    }
  }
  state.leaderboards.playerColors = colors;
}

const LEADERBOARD_HISTORY_LIMIT = 336;
let leaderboardTimelineView = null;
let leaderboardTimelineDrag = null;
let leaderboardTimelineSuppressClick = false;

function leaderboardMetricLabel(metric) {
  return metric === "elo" ? "ELO" : "World";
}

function leaderboardValueUnit(metric) {
  return metric === "elo" ? "ELO" : "net wins";
}

function leaderboardMovementValue(value, unit = leaderboardValueUnit(state.leaderboards.metric)) {
  return `${value >= 0 ? "Blue" : "Red"} top-20 total leads by ${Math.abs(Math.round(value)).toLocaleString()} ${unit}`;
}

function normalizeLeaderboardHistory(rows) {
  if (!Array.isArray(rows)) throw new Error("Invalid leaderboard history.");
  const captures = new Map();
  for (const row of rows) {
    const capturedAt = Number(row?.capturedAt ?? row?.fetchedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0) continue;
    const normalized = { capturedAt };
    for (const metric of ["elo", "world"]) {
      const board = Array.isArray(row[metric]) ? row[metric] : [];
      normalized[metric] = board.slice(0, 20).map((player, index) => ({
        ...player,
        nickname: String(player?.nickname ?? "Unknown player"),
        rank: Number.isFinite(Number(player?.rank)) ? Number(player.rank) : index + 1,
        value: Number(player?.value) || 0,
        faction: leaderboardFaction(player?.faction),
      }));
    }
    captures.set(capturedAt, normalized);
  }
  return [...captures.values()].sort((a, b) => a.capturedAt - b.capturedAt);
}

function currentLeaderboardHistory() {
  const captures = new Map(state.leaderboards.history.map((row) => [row.capturedAt, row]));
  if (state.leaderboards.fetchedAt) {
    captures.set(state.leaderboards.fetchedAt, {
      capturedAt: state.leaderboards.fetchedAt,
      elo: state.leaderboards.elo,
      world: state.leaderboards.world,
    });
  }
  return [...captures.values()].sort((a, b) => a.capturedAt - b.capturedAt);
}

function renderLeaderboardGraph() {
  const metric = state.leaderboards.metric;
  const rows = state.leaderboards[metric];
  const svg = els.leaderboardGraph;
  const width = 1000;
  const rowHeight = 31;
  const top = 20;
  const height = Math.max(250, top + rows.length * rowHeight + 28);
  const plotLeft = 232;
  const plotRight = 910;
  const plotWidth = plotRight - plotLeft;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.removeAttribute("height");
  svg.setAttribute("aria-label", metric === "elo" ? "Top 20 ELO ratings" : "Top 20 world net wins");
  svg.replaceChildren();

  const title = svgEl("title", {});
  title.textContent = `${leaderboardMetricLabel(metric)} top 20 at a glance`;
  const description = svgEl("desc", {});
  description.textContent = `Horizontal bars compare the current top 20 players by ${leaderboardValueUnit(metric)}.`;
  svg.append(title, description);

  if (rows.length === 0) {
    const empty = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "leaderboard-graph-empty" });
    empty.textContent = "Waiting for leaderboard data…";
    svg.append(empty);
    return;
  }

  const values = rows.map((row) => row.value);
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  const baseline = metric === "elo" ? Math.max(0, Math.floor((minimum * 0.9) / 100) * 100) : Math.min(0, minimum);
  const span = Math.max(1, maximum - baseline);

  rows.forEach((player, index) => {
    const y = top + index * rowHeight;
    const faction = metric === "world" ? leaderboardPlayerFaction(player) : "elo";
    const barWidth = Math.max(3, ((player.value - baseline) / span) * plotWidth);
    const name = svgEl("text", { x: plotLeft - 14, y: y + 11, "text-anchor": "end", class: "leaderboard-graph-name" });
    name.textContent = `${index + 1}. ${player.nickname}`;
    const track = svgEl("rect", { x: plotLeft, y, width: plotWidth, height: 19, rx: 6, class: "leaderboard-graph-track" });
    const bar = svgEl("rect", { x: plotLeft, y, width: barWidth, height: 19, rx: 6, class: `leaderboard-graph-bar ${faction}` });
    const title = svgEl("title", {});
    title.textContent = `${player.nickname}: ${Math.round(player.value).toLocaleString()} ${metric === "elo" ? "ELO" : "net wins"}`;
    bar.append(title);
    const value = svgEl("text", { x: plotRight + 14, y: y + 11, class: `leaderboard-graph-value ${faction}` });
    value.textContent = Math.round(player.value).toLocaleString();
    svg.append(track, bar, name, value);
  });

  els.leaderboardGraphDescription.textContent = metric === "elo"
    ? `Current top-20 ELO ratings · scale begins at ${baseline.toLocaleString()}.`
    : "Current top-20 World standings by net wins · bars use each player’s faction color when available.";
}

function leaderboardTimelinePath(points, xOf, yOf) {
  let path = "";
  let drawing = false;
  for (const point of points) {
    if (!point) {
      drawing = false;
      continue;
    }
    const command = drawing ? "L" : "M";
    path += `${command}${xOf(point.capturedAt).toFixed(1)},${yOf(point.value).toFixed(1)}`;
    drawing = true;
  }
  return path;
}

function leaderboardTimelineSlopeGradient(id, samples, xStart, xEnd, plotLeft, plotRight) {
  const slopes = samples.map((sample, index) => {
    const before = samples[Math.max(0, index - 1)];
    const after = samples[Math.min(samples.length - 1, index + 1)];
    const hours = Math.max(1 / 60, (after.capturedAt - before.capturedAt) / 3600);
    return (after.value - before.value) / hours;
  });
  const maximumSlope = Math.max(0, ...slopes.map(Math.abs));
  const neutral = [126, 111, 147];
  const gradient = svgEl("linearGradient", {
    id,
    x1: plotLeft,
    y1: 0,
    x2: plotRight,
    y2: 0,
    gradientUnits: "userSpaceOnUse",
  });
  for (let index = 0; index < samples.length; index += 1) {
    const slope = slopes[index];
    const ratio = maximumSlope > 0 ? Math.sqrt(Math.abs(slope) / maximumSlope) : 0;
    const strength = Math.abs(slope) < 1e-9 ? 0 : 0.68 + ratio * 0.32;
    const target = slope > 1e-9 ? [63, 108, 224] : slope < -1e-9 ? [217, 65, 65] : neutral;
    const color = neutral.map((channel, colorIndex) => (
      Math.round(channel + (target[colorIndex] - channel) * strength)
    ));
    const offset = xEnd === xStart ? 0 : ((samples[index].capturedAt - xStart) / (xEnd - xStart)) * 100;
    gradient.append(svgEl("stop", {
      offset: `${Math.max(0, Math.min(100, offset)).toFixed(2)}%`,
      "stop-color": `rgb(${color.join(", ")})`,
    }));
  }
  return gradient;
}

function leaderboardTimelineStep(span, targetTicks = 6) {
  const rough = Math.max(span, 1) / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function packLeaderboardTimelineLabels(series, yOf, minimum, maximum, gap) {
  const labels = series
    .map((player) => ({ key: player.key, y: yOf(player.value) }))
    .sort((a, b) => a.y - b.y);
  for (let index = 0; index < labels.length; index += 1) {
    const floor = index === 0 ? minimum : labels[index - 1].packed + gap;
    labels[index].packed = Math.max(labels[index].y, floor);
  }
  if (labels.length && labels.at(-1).packed > maximum) {
    labels.at(-1).packed = maximum;
    for (let index = labels.length - 2; index >= 0; index -= 1) {
      labels[index].packed = Math.min(labels[index].packed, labels[index + 1].packed - gap);
    }
  }
  if (labels.length && labels[0].packed < minimum) {
    const shift = minimum - labels[0].packed;
    for (const label of labels) label.packed += shift;
  }
  if (labels.length) {
    const desiredCenter = labels.reduce((sum, label) => sum + label.y, 0) / labels.length;
    const packedCenter = labels.reduce((sum, label) => sum + label.packed, 0) / labels.length;
    const minimumShift = minimum - labels[0].packed;
    const maximumShift = maximum - labels.at(-1).packed;
    const centerShift = Math.max(minimumShift, Math.min(desiredCenter - packedCenter, maximumShift));
    for (const label of labels) label.packed += centerShift;
  }
  return new Map(labels.map((label) => [label.key, label.packed]));
}

function setLeaderboardTimelineHighlight(playerKey) {
  const svg = els.leaderboardTimeline;
  const activeKey = playerKey || state.leaderboards.highlightedPlayer;
  for (const node of svg.querySelectorAll("[data-player-key]")) {
    const active = Boolean(activeKey) && node.dataset.playerKey === activeKey;
    node.classList.toggle("is-highlighted", active);
  }
}

function hideLeaderboardTimelineTooltip() {
  els.leaderboardTimelineTooltip.hidden = true;
  if (leaderboardTimelineView?.crosshair) leaderboardTimelineView.crosshair.setAttribute("visibility", "hidden");
  if (leaderboardTimelineView?.hoverDot) leaderboardTimelineView.hoverDot.setAttribute("visibility", "hidden");
}

function positionLeaderboardTimelineTooltip(capturedAt) {
  const { tooltip, wrap, svg } = {
    tooltip: els.leaderboardTimelineTooltip,
    wrap: els.leaderboardTimelineWrap,
    svg: els.leaderboardTimeline,
  };
  const wrapRect = wrap.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const viewX = leaderboardTimelineView.xOf(capturedAt);
  const anchorX = wrap.scrollLeft + svgRect.left - wrapRect.left + (viewX / leaderboardTimelineView.width) * svgRect.width;
  const minLeft = wrap.scrollLeft + 8;
  const visibleRight = wrap.scrollLeft + wrap.clientWidth - 8;
  const tooltipRight = leaderboardTimelineView.tooltipRight === null
    ? visibleRight
    : wrap.scrollLeft + svgRect.left - wrapRect.left
      + (leaderboardTimelineView.tooltipRight / leaderboardTimelineView.width) * svgRect.width - 8;
  const maxLeft = Math.max(minLeft, Math.min(visibleRight, tooltipRight) - tooltip.offsetWidth);
  tooltip.style.left = `${Math.max(minLeft, Math.min(anchorX + 10, maxLeft))}px`;
}

function showLeaderboardTimelineTooltip(point, series, snapshot) {
  const tooltip = els.leaderboardTimelineTooltip;
  const time = document.createElement("div");
  time.className = "tt-time";
  time.textContent = timeFormat.format(new Date(snapshot.capturedAt * 1000));
  const player = document.createElement("div");
  player.className = "leaderboard-tooltip-player";
  player.textContent = series.nickname;
  const value = document.createElement("div");
  value.textContent = point
    ? (series.movement
      ? leaderboardMovementValue(point.value)
      : `Rank #${point.rank} · ${Math.round(point.value).toLocaleString()} ${leaderboardValueUnit(state.leaderboards.metric)}`)
    : (series.movement ? "Faction totals unavailable at this snapshot" : "Outside the top 20 at this snapshot");
  const content = [time, player, value];
  if (point) {
    const baseline = series.points.find(Boolean);
    if (baseline) {
      const change = Math.round(point.value - baseline.value);
      const progress = document.createElement("div");
      progress.className = `tt-change ${change > 0 ? "leaderboard-progress-up" : change < 0 ? "leaderboard-progress-down" : ""}`;
      progress.textContent = `Visible-window change: ${change > 0 ? "+" : ""}${change.toLocaleString()}`;
      content.push(progress);
    }
  }
  const hint = document.createElement("div");
  hint.className = "tt-change";
  hint.textContent = "Press and drag to compare snapshots";
  content.push(hint);
  tooltip.replaceChildren(...content);
  tooltip.hidden = false;
  const viewX = leaderboardTimelineView.xOf(snapshot.capturedAt);
  positionLeaderboardTimelineTooltip(snapshot.capturedAt);

  leaderboardTimelineView.crosshair.setAttribute("x1", viewX.toFixed(1));
  leaderboardTimelineView.crosshair.setAttribute("x2", viewX.toFixed(1));
  leaderboardTimelineView.crosshair.removeAttribute("visibility");
  if (point) {
    leaderboardTimelineView.hoverDot.setAttribute("cx", viewX.toFixed(1));
    leaderboardTimelineView.hoverDot.setAttribute("cy", leaderboardTimelineView.yOf(point.value).toFixed(1));
    leaderboardTimelineView.hoverDot.className.baseVal = `leaderboard-timeline-hover-dot ${series.faction}`;
    leaderboardTimelineView.hoverDot.removeAttribute("visibility");
  } else {
    leaderboardTimelineView.hoverDot.setAttribute("visibility", "hidden");
  }
}

function renderLeaderboardTimeline() {
  const metric = state.leaderboards.metric;
  const movementMode = state.leaderboards.timelineView === "movement";
  const currentPlayers = state.leaderboards[metric].slice(0, 20);
  const snapshots = rowsForTimeRange(
    currentLeaderboardHistory(),
    state.leaderboards.timelineRange,
    (snapshot) => snapshot.capturedAt,
  );
  const svg = els.leaderboardTimeline;
  const width = 1200;
  const height = 650;
  const top = 38;
  const bottom = 54;
  const plotLeft = 54;
  const plotRight = movementMode ? width - 28 : 830;
  const labelLeft = 858;
  const labelValueX = 1180;
  const labelDeltaX = labelValueX - 64;
  const plotHeight = height - top - bottom;
  const xStart = snapshots[0]?.capturedAt ?? 0;
  const xEnd = snapshots.at(-1)?.capturedAt ?? xStart + 1;
  const xSpan = Math.max(1, xEnd - xStart);
  const xOf = (capturedAt) => plotLeft + ((capturedAt - xStart) / xSpan) * (plotRight - plotLeft);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", movementMode
    ? `Top 20 ${leaderboardMetricLabel(metric)} faction advantage over time with war land momentum`
    : `Top 20 ${leaderboardMetricLabel(metric)} value history`);
  svg.replaceChildren();
  leaderboardTimelineView = null;
  leaderboardTimelineDrag = null;

  const title = svgEl("title", {});
  title.textContent = `${leaderboardMetricLabel(metric)} ${movementMode ? "faction advantage" : "player value momentum"}`;
  const description = svgEl("desc", {});
  description.textContent = movementMode
    ? `One slope-colored line shows combined Blue ${leaderboardValueUnit(metric)} minus combined Red ${leaderboardValueUnit(metric)} within each snapshot’s actual top 20: up is Blue and down is Red. The dotted, slope-colored war land line uses an independent percentage scale.`
    : `Lines show every player who appeared in the visible top-20 history. Latest labels remain limited to the current top 20; gaps mean the player was outside the top 20.`;
  svg.append(title, description);

  if (currentPlayers.length === 0 || snapshots.length === 0) {
    const empty = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "leaderboard-graph-empty" });
    empty.textContent = state.leaderboards.historyError ? "Leaderboard history is temporarily unavailable." : "Waiting for leaderboard history…";
    svg.append(empty);
    els.leaderboardTimelineDescription.textContent = `Seven days of ${leaderboardMetricLabel(metric)} value progress for today’s top 20.`;
    els.leaderboardTimelineStatus.textContent = state.leaderboards.historyError ? "History unavailable" : "Loading history…";
    return;
  }

  const snapshotLookups = snapshots.map((snapshot) => {
    const players = new Map();
    const board = Array.isArray(snapshot[metric]) ? snapshot[metric] : [];
    board.forEach((player, index) => players.set(leaderboardPlayerKey(player.nickname), {
      ...player,
      rank: Number(player.rank) || index + 1,
      value: Number(player.value) || 0,
    }));
    return { capturedAt: snapshot.capturedAt, players };
  });
  const roster = new Map();
  currentPlayers.forEach((player, index) => {
    const key = leaderboardPlayerKey(player.nickname);
    roster.set(key, {
      key,
      nickname: player.nickname,
      rank: Number(player.rank) || index + 1,
      value: Number(player.value) || 0,
      source: player,
      isCurrent: true,
      lastSeenAt: xEnd,
    });
  });
  for (const snapshot of snapshotLookups) {
    for (const [key, player] of snapshot.players) {
      const existing = roster.get(key);
      if (existing) {
        existing.lastSeenAt = Math.max(existing.lastSeenAt, snapshot.capturedAt);
        if (!existing.isCurrent) {
          existing.nickname = player.nickname;
          existing.rank = player.rank;
          existing.value = player.value;
          existing.source = player;
        }
      } else {
        roster.set(key, {
          key,
          nickname: player.nickname,
          rank: player.rank,
          value: player.value,
          source: player,
          isCurrent: false,
          lastSeenAt: snapshot.capturedAt,
        });
      }
    }
  }
  const playerSeries = [...roster.values()]
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isCurrent) return a.rank - b.rank;
      return b.lastSeenAt - a.lastSeenAt || a.rank - b.rank;
    })
    .map((player) => ({
      ...player,
      faction: metric === "world" ? leaderboardPlayerFaction(player.source) : "elo",
      teamFaction: leaderboardPlayerFaction(player.source),
      points: snapshotLookups.map((snapshot) => {
        const historical = snapshot.players.get(player.key);
        return historical ? { ...historical, capturedAt: snapshot.capturedAt } : null;
      }),
    }));
  let series = playerSeries;
  if (movementMode) {
    const movementKey = "__ranking-movement__";
    for (const snapshot of snapshotLookups) {
      const redValues = [];
      const blueValues = [];
      for (const player of snapshot.players.values()) {
        const faction = leaderboardPlayerFaction(player);
        if (faction === "red") redValues.push(player.value);
        else if (faction === "blue") blueValues.push(player.value);
      }
      if (redValues.length > 0 && blueValues.length > 0) {
        const redTotal = redValues.reduce((sum, value) => sum + value, 0);
        const blueTotal = blueValues.reduce((sum, value) => sum + value, 0);
        snapshot.players.set(movementKey, {
          capturedAt: snapshot.capturedAt,
          rank: null,
          value: blueTotal - redTotal,
        });
      }
    }
    const movementPoints = snapshotLookups.map((snapshot) => snapshot.players.get(movementKey) || null);
    const latestMovement = [...movementPoints].reverse().find(Boolean);
    if (latestMovement) {
      series = [{
        movement: true,
        key: movementKey,
        nickname: "Ranking movement",
        rank: null,
        value: latestMovement.value,
        faction: "movement",
        points: movementPoints,
      }];
    } else series = [];
  }

  const historicalValues = series.flatMap((player) => player.points.filter(Boolean).map((point) => point.value));
  if (historicalValues.length === 0) {
    const empty = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "leaderboard-graph-empty" });
    empty.textContent = movementMode
      ? "Red and Blue faction data is needed for movement."
      : "No player history is available for this view.";
    svg.append(empty);
    els.leaderboardTimelineDescription.textContent = movementMode
      ? "Movement needs both Red and Blue faction data in the visible history."
      : `Visible ${leaderboardMetricLabel(metric)} history for everyone who reached the top 20.`;
    return;
  }
  let valueMinimum = Math.min(...historicalValues);
  let valueMaximum = Math.max(...historicalValues);
  if (movementMode) {
    const maximumMagnitude = Math.max(1, Math.abs(valueMinimum), Math.abs(valueMaximum));
    valueMinimum = -maximumMagnitude;
    valueMaximum = maximumMagnitude;
  } else if (valueMinimum === valueMaximum) {
    const padding = Math.max(5, Math.abs(valueMinimum) * 0.03);
    valueMinimum -= padding;
    valueMaximum += padding;
  }
  const valueStep = leaderboardTimelineStep(valueMaximum - valueMinimum);
  const axisMinimum = Math.floor(valueMinimum / valueStep) * valueStep;
  const axisMaximum = Math.ceil(valueMaximum / valueStep) * valueStep;
  const axisSpan = Math.max(valueStep, axisMaximum - axisMinimum);
  const yOf = (value) => top + ((axisMaximum - value) / axisSpan) * plotHeight;

  if (movementMode) {
    const zeroY = yOf(0);
    svg.append(
      svgEl("rect", { x: plotLeft, y: top, width: plotRight - plotLeft, height: zeroY - top, class: "leaderboard-timeline-zone-blue" }),
      svgEl("rect", { x: plotLeft, y: zeroY, width: plotRight - plotLeft, height: top + plotHeight - zeroY, class: "leaderboard-timeline-zone-red" }),
    );
  }

  for (let value = axisMinimum; value <= axisMaximum + valueStep / 2; value += valueStep) {
    const y = yOf(value);
    svg.append(svgEl("line", {
      x1: plotLeft,
      x2: plotRight,
      y1: y,
      y2: y,
      class: "leaderboard-timeline-grid major",
    }));
    const valueLabel = svgEl("text", { x: plotLeft - 12, y: y + 4, "text-anchor": "end", class: "leaderboard-timeline-axis-value" });
    valueLabel.textContent = `${movementMode && value > 0 ? "+" : ""}${Math.round(value).toLocaleString()}`;
    svg.append(valueLabel);
  }

  if (movementMode) {
    const zeroY = yOf(0);
    svg.append(svgEl("line", {
      x1: plotLeft,
      x2: plotRight,
      y1: zeroY,
      y2: zeroY,
      class: "leaderboard-timeline-zero",
    }));
    const blueDirection = svgEl("text", {
      x: plotRight - 6,
      y: top + 14,
      "text-anchor": "end",
      class: "leaderboard-timeline-direction blue",
    });
    blueDirection.textContent = "BLUE ↑";
    const redDirection = svgEl("text", {
      x: plotRight - 6,
      y: top + plotHeight - 8,
      "text-anchor": "end",
      class: "leaderboard-timeline-direction red",
    });
    redDirection.textContent = "RED ↓";
    svg.append(blueDirection, redDirection);
  }

  const valueHeading = svgEl("text", { x: plotLeft, y: 18, class: "leaderboard-timeline-heading" });
  valueHeading.textContent = movementMode
    ? (metric === "elo" ? "TOP-20 ELO DIFFERENCE" : "TOP-20 NET-WIN DIFFERENCE")
    : (metric === "elo" ? "ELO" : "NET WINS");
  svg.append(valueHeading);
  if (!movementMode) {
    const latestHeading = svgEl("text", { x: labelLeft, y: 18, class: "leaderboard-timeline-heading" });
    latestHeading.textContent = "LATEST STANDINGS";
    svg.append(latestHeading, svgEl("line", {
      x1: plotRight + 14,
      x2: plotRight + 14,
      y1: top - 18,
      y2: height - bottom + 14,
      class: "leaderboard-timeline-divider",
    }));
  }

  let timelineDefs = null;
  if (movementMode) {
    const samples = series[0].points.filter(Boolean);
    timelineDefs = svgEl("defs", {});
    timelineDefs.append(leaderboardTimelineSlopeGradient(
      "leaderboard-movement-slope-gradient",
      samples,
      xStart,
      xEnd,
      plotLeft,
      plotRight,
    ));
    svg.append(timelineDefs);
  }

  for (const player of series) {
    const path = leaderboardTimelinePath(player.points, xOf, yOf);
    if (path) {
      const line = svgEl("path", {
        d: path,
        class: `leaderboard-timeline-line ${player.faction}${Number.isFinite(player.rank) && player.rank <= 3 ? " podium" : ""}`,
        "data-player-key": player.key,
      });
      const lineTitle = svgEl("title", {});
      lineTitle.textContent = player.movement
        ? `Ranking movement: ${leaderboardMovementValue(player.value)}`
        : player.isCurrent
          ? `${player.nickname}, currently rank ${player.rank} with ${Math.round(player.value).toLocaleString()} ${leaderboardValueUnit(metric)}`
          : `${player.nickname}, last seen at rank ${player.rank} with ${Math.round(player.value).toLocaleString()} ${leaderboardValueUnit(metric)}`;
      line.append(lineTitle);
      svg.append(line);
    }
  }

  if (movementMode) {
    const warLandPoints = state.rows
      .map((row) => {
        const stats = state.stats.get(row.mapHash);
        const share = stats ? shareOf(stats) : null;
        return share === null || row.capturedAt < xStart || row.capturedAt > xEnd
          ? null
          : { capturedAt: row.capturedAt, value: (100 - share) - share };
      })
      .filter(Boolean);
    if (warLandPoints.length >= 2) {
      timelineDefs?.append(leaderboardTimelineSlopeGradient(
        "leaderboard-war-land-slope-gradient",
        warLandPoints,
        xStart,
        xEnd,
        plotLeft,
        plotRight,
      ));
      let warMinimum = Math.min(...warLandPoints.map((point) => point.value));
      let warMaximum = Math.max(...warLandPoints.map((point) => point.value));
      if (warMinimum === warMaximum) {
        warMinimum -= 0.5;
        warMaximum += 0.5;
      }
      const warPadding = Math.max(0.05, (warMaximum - warMinimum) * 0.08);
      warMinimum -= warPadding;
      warMaximum += warPadding;
      const warYOf = (value) => top + ((warMaximum - value) / (warMaximum - warMinimum)) * plotHeight;
      const warPath = leaderboardTimelinePath(warLandPoints, xOf, warYOf);
      const warLine = svgEl("path", { d: warPath, class: "leaderboard-timeline-war-line" });
      const warTitle = svgEl("title", {});
      warTitle.textContent = "War land momentum · independently scaled land-control advantage";
      warLine.append(warTitle);
      const warLabel = svgEl("text", {
        x: plotRight - 6,
        y: 18,
        "text-anchor": "end",
        class: "leaderboard-timeline-war-label",
      });
      warLabel.textContent = "WAR LAND · INDEPENDENT SCALE";
      svg.append(warLine, warLabel);
    }
  }

  const lastX = xOf(xEnd);
  const labelSeries = movementMode ? [] : series.filter((player) => player.isCurrent);
  const labelPositions = packLeaderboardTimelineLabels(labelSeries, yOf, top, height - bottom, 25);
  const deltaLabels = new Map();
  for (const player of labelSeries) {
    const y = yOf(player.value);
    const labelY = labelPositions.get(player.key) ?? y;
    const dot = svgEl("circle", {
      cx: lastX,
      cy: y,
      r: Number.isFinite(player.rank) && player.rank <= 3 ? 4.8 : 4.2,
      class: `leaderboard-timeline-end-dot ${player.faction}`,
      "data-player-key": player.key,
    });
    if (player.rank === 1) {
      svg.append(svgEl("circle", {
        cx: lastX,
        cy: y,
        r: 9,
        class: `leaderboard-timeline-live-ring ${player.faction}`,
        "data-player-key": player.key,
      }));
    }
    const link = svgEl("a", {
      href: "#leaderboards",
      class: "leaderboard-timeline-label-link",
      "data-player-key": player.key,
      "aria-label": player.movement
        ? `Ranking movement, ${leaderboardMovementValue(player.value)}`
        : `${player.nickname}, rank ${player.rank}, ${Math.round(player.value).toLocaleString()} ${leaderboardValueUnit(metric)}`,
    });
    const hitbox = svgEl("rect", {
      x: labelLeft - 10,
      y: labelY - 13,
      width: labelValueX - labelLeft + 20,
      height: 26,
      rx: 5,
      class: "leaderboard-timeline-label-hitbox",
    });
    const name = svgEl("text", {
      x: labelLeft,
      y: labelY + 5,
      class: `leaderboard-timeline-name ${player.faction}`,
    });
    const shortName = player.nickname.length > 21 ? `${player.nickname.slice(0, 20)}…` : player.nickname;
    name.textContent = player.movement
      ? `Ranking · ${player.value >= 0 ? "Blue" : "Red"}`
      : `${player.rank}. ${shortName}`;
    const value = svgEl("text", {
      x: labelValueX,
      y: labelY + 5,
      "text-anchor": "end",
      class: "leaderboard-timeline-value",
    });
    value.textContent = player.movement
      ? `+${Math.abs(Math.round(player.value)).toLocaleString()}`
      : Math.round(player.value).toLocaleString();
    const linkTitle = svgEl("title", {});
    linkTitle.textContent = player.movement
      ? leaderboardMovementValue(player.value)
      : `${player.nickname}: ${Math.round(player.value).toLocaleString()} ${leaderboardValueUnit(metric)}`;
    link.append(hitbox, name, value, linkTitle);
    const delta = svgEl("text", {
      x: labelDeltaX,
      y: labelY + 5,
      "text-anchor": "end",
      class: "leaderboard-timeline-delta",
      visibility: "hidden",
    });
    deltaLabels.set(player.key, delta);
    svg.append(delta, dot, link);
  }

  const spanSeconds = Math.max(1, xEnd - xStart);
  const tickFormat = new Intl.DateTimeFormat(
    undefined,
    spanSeconds > 3 * 86400
      ? { month: "short", day: "numeric" }
      : { weekday: "short", hour: "2-digit", minute: "2-digit" },
  );
  const tickCount = Math.min(7, Math.max(2, snapshots.length));
  for (let tick = 0; tick < tickCount; tick += 1) {
    const capturedAt = xStart + (spanSeconds * tick) / (tickCount - 1);
    const anchor = tick === 0 ? "start" : tick === tickCount - 1 ? "end" : "middle";
    const label = svgEl("text", {
      x: xOf(capturedAt),
      y: height - 16,
      "text-anchor": anchor,
      class: "leaderboard-timeline-time",
    });
    label.textContent = tickFormat.format(new Date(capturedAt * 1000));
    svg.append(label);
  }

  const crosshair = svgEl("line", {
    y1: top - 8,
    y2: height - bottom + 8,
    class: "leaderboard-timeline-crosshair",
    visibility: "hidden",
  });
  const hoverDot = svgEl("circle", { r: 6, class: "leaderboard-timeline-hover-dot", visibility: "hidden" });
  const dragRange = svgEl("rect", {
    x: 0,
    y: top - 8,
    width: 0,
    height: plotHeight + 16,
    class: "leaderboard-timeline-drag-range",
    visibility: "hidden",
  });
  const dragStartLine = svgEl("line", {
    x1: 0,
    x2: 0,
    y1: top - 8,
    y2: height - bottom + 8,
    class: "leaderboard-timeline-drag-marker",
    visibility: "hidden",
  });
  const dragEndLine = svgEl("line", {
    x1: 0,
    x2: 0,
    y1: top - 8,
    y2: height - bottom + 8,
    class: "leaderboard-timeline-drag-marker",
    visibility: "hidden",
  });
  svg.append(dragRange, dragStartLine, dragEndLine, crosshair, hoverDot);

  leaderboardTimelineView = {
    width,
    height,
    plotLeft,
    plotRight,
    tooltipRight: movementMode ? null : plotRight + 14,
    top,
    bottom,
    xOf,
    yOf,
    snapshots: snapshotLookups,
    series,
    deltaLabels,
    dragRange,
    dragStartLine,
    dragEndLine,
    crosshair,
    hoverDot,
  };
  setLeaderboardTimelineHighlight();

  const rangeStart = new Date(xStart * 1000);
  const rangeEnd = new Date(xEnd * 1000);
  const rangeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  if (movementMode) {
    els.leaderboardTimelineDescription.textContent = `${rangeFormat.format(rangeStart)}–${rangeFormat.format(rangeEnd)} · combined Blue minus combined Red within each snapshot’s top 20: up is Blue, down is Red; dotted war land uses the same direction colors on an independent scale.`;
  } else {
    els.leaderboardTimelineDescription.textContent = `${rangeFormat.format(rangeStart)}–${rangeFormat.format(rangeEnd)} · ${playerSeries.length.toLocaleString()} players who reached the top 20; gaps mean outside it.`;
  }
  els.leaderboardTimelineStatus.textContent = state.leaderboards.historyError
    ? "Update failed · showing saved history"
    : `${snapshots.length.toLocaleString()} snapshots · live`;
  els.leaderboardTimelineStatus.title = state.leaderboards.historyError || "";
}

function leaderboardTimelineContextFromEvent(event, preferredPlayerKey = null) {
  const view = leaderboardTimelineView;
  if (!view) return null;
  const target = event.target instanceof Element ? event.target.closest("[data-player-key]") : null;
  const rect = els.leaderboardTimeline.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * view.width;
  const y = ((event.clientY - rect.top) / rect.height) * view.height;
  if (x < view.plotLeft || x > view.plotRight) return { target, x, y };

  let snapshot = view.snapshots[0];
  let bestDistance = Infinity;
  for (const candidate of view.snapshots) {
    const distance = Math.abs(view.xOf(candidate.capturedAt) - x);
    if (distance < bestDistance) {
      snapshot = candidate;
      bestDistance = distance;
    }
  }

  const focusedKey = preferredPlayerKey
    || state.leaderboards.highlightedPlayer
    || target?.dataset.playerKey;
  let focusedSeries = focusedKey
    ? view.series.find((player) => player.key === focusedKey)
    : null;
  if (!focusedSeries) {
    let closestDistance = Infinity;
    for (const player of view.series) {
      const point = snapshot.players.get(player.key);
      if (!point) continue;
      const distance = Math.abs(view.yOf(point.value) - y);
      if (distance < closestDistance) {
        closestDistance = distance;
        focusedSeries = player;
      }
    }
  }
  if (!focusedSeries) return { target, x, y, snapshot };
  return {
    target,
    x,
    y,
    snapshot,
    series: focusedSeries,
    point: snapshot.players.get(focusedSeries.key) || null,
  };
}

function renderLeaderboardTimelineDragTooltip(series, firstSnapshot, secondSnapshot) {
  const [start, end] = firstSnapshot.capturedAt <= secondSnapshot.capturedAt
    ? [firstSnapshot, secondSnapshot]
    : [secondSnapshot, firstSnapshot];
  const startPoint = start.players.get(series.key) || null;
  const endPoint = end.players.get(series.key) || null;
  const tooltip = els.leaderboardTimelineTooltip;
  const range = document.createElement("div");
  range.className = "tt-time tt-range-time";
  range.textContent = `${timeFormat.format(new Date(start.capturedAt * 1000))} → ${timeFormat.format(new Date(end.capturedAt * 1000))}`;
  const duration = document.createElement("div");
  duration.className = "tt-duration";
  duration.textContent = start === end ? "Drag to another snapshot" : formatChartSpan(end.capturedAt - start.capturedAt);
  const player = document.createElement("div");
  player.className = "leaderboard-tooltip-player";
  player.textContent = series.nickname;
  const unit = leaderboardValueUnit(state.leaderboards.metric);
  const startValue = document.createElement("div");
  startValue.textContent = startPoint
    ? (series.movement
      ? `Start · ${leaderboardMovementValue(startPoint.value, unit)}`
      : `Start · #${startPoint.rank} · ${Math.round(startPoint.value).toLocaleString()} ${unit}`)
    : (series.movement ? "Start · Faction totals unavailable" : "Start · Outside the top 20");
  const endValue = document.createElement("div");
  endValue.textContent = endPoint
    ? (series.movement
      ? `End · ${leaderboardMovementValue(endPoint.value, unit)}`
      : `End · #${endPoint.rank} · ${Math.round(endPoint.value).toLocaleString()} ${unit}`)
    : (series.movement ? "End · Faction totals unavailable" : "End · Outside the top 20");
  const content = [range, duration, player, startValue, endValue];

  if (startPoint && endPoint) {
    const valueChange = Math.round(endPoint.value - startPoint.value);
    const progress = document.createElement("div");
    progress.className = `tt-change-value ${valueChange > 0 ? "leaderboard-progress-up" : valueChange < 0 ? "leaderboard-progress-down" : ""}`;
    progress.textContent = `Value change · ${valueChange > 0 ? "+" : ""}${valueChange.toLocaleString()}`;
    content.push(progress);
    if (!series.movement) {
      const rankChange = startPoint.rank - endPoint.rank;
      const ranking = document.createElement("div");
      ranking.className = `tt-change ${rankChange > 0 ? "leaderboard-progress-up" : rankChange < 0 ? "leaderboard-progress-down" : ""}`;
      ranking.textContent = rankChange === 0
        ? `Rank unchanged · #${endPoint.rank}`
        : `Rank change · ${rankChange > 0 ? "↑" : "↓"}${Math.abs(rankChange)} (#${startPoint.rank} → #${endPoint.rank})`;
      content.push(ranking);
    }
  } else if (!startPoint && endPoint) {
    const progress = document.createElement("div");
    progress.className = "tt-change leaderboard-progress-up";
    progress.textContent = series.movement
      ? "Faction totals became available"
      : `Entered the top 20 at #${endPoint.rank}`;
    content.push(progress);
  } else if (startPoint && !endPoint) {
    const progress = document.createElement("div");
    progress.className = "tt-change leaderboard-progress-down";
    progress.textContent = series.movement ? "Faction totals became unavailable" : "Exited the top 20";
    content.push(progress);
  }

  tooltip.replaceChildren(...content);
  tooltip.hidden = false;
  positionLeaderboardTimelineTooltip(secondSnapshot.capturedAt);
}

function updateLeaderboardTimelineDrag(snapshot) {
  const drag = leaderboardTimelineDrag;
  const view = leaderboardTimelineView;
  if (!drag || !view || !snapshot) return;
  drag.currentSnapshot = snapshot;
  const startX = view.xOf(drag.startSnapshot.capturedAt);
  const endX = view.xOf(snapshot.capturedAt);
  view.crosshair.setAttribute("visibility", "hidden");
  view.hoverDot.setAttribute("visibility", "hidden");
  view.dragRange.setAttribute("x", Math.min(startX, endX).toFixed(1));
  view.dragRange.setAttribute("width", Math.abs(endX - startX).toFixed(1));
  view.dragStartLine.setAttribute("x1", startX.toFixed(1));
  view.dragStartLine.setAttribute("x2", startX.toFixed(1));
  view.dragEndLine.setAttribute("x1", endX.toFixed(1));
  view.dragEndLine.setAttribute("x2", endX.toFixed(1));
  for (const element of [view.dragRange, view.dragStartLine, view.dragEndLine]) {
    element.removeAttribute("visibility");
  }
  const [rangeStart, rangeEnd] = drag.startSnapshot.capturedAt <= snapshot.capturedAt
    ? [drag.startSnapshot, snapshot]
    : [snapshot, drag.startSnapshot];
  for (const series of view.series) {
    const startPoint = rangeStart.players.get(series.key) || null;
    const endPoint = rangeEnd.players.get(series.key) || null;
    const deltaLabel = view.deltaLabels.get(series.key);
    if (!deltaLabel) continue;
    if (startPoint && endPoint) {
      const delta = Math.round(endPoint.value - startPoint.value);
      deltaLabel.textContent = `${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`;
    } else if (!startPoint && endPoint) deltaLabel.textContent = "IN";
    else if (startPoint && !endPoint) deltaLabel.textContent = "OUT";
    else deltaLabel.textContent = "—";
    deltaLabel.removeAttribute("visibility");
  }
  setLeaderboardTimelineHighlight(drag.series.key);
  renderLeaderboardTimelineDragTooltip(drag.series, drag.startSnapshot, snapshot);
}

function leaderboardTimelinePointerDown(event) {
  if (event.button !== 0 || leaderboardTimelineDrag) return;
  const context = leaderboardTimelineContextFromEvent(event);
  if (!context?.snapshot || !context.series) return;
  leaderboardTimelineDrag = {
    pointerId: event.pointerId,
    series: context.series,
    startSnapshot: context.snapshot,
    currentSnapshot: context.snapshot,
  };
  els.leaderboardTimeline.setPointerCapture(event.pointerId);
  updateLeaderboardTimelineDrag(context.snapshot);
  event.preventDefault();
}

function leaderboardTimelinePointerMove(event) {
  const context = leaderboardTimelineContextFromEvent(event, leaderboardTimelineDrag?.series.key);
  if (!context) return;
  if (leaderboardTimelineDrag && event.pointerId === leaderboardTimelineDrag.pointerId) {
    if (context.snapshot) updateLeaderboardTimelineDrag(context.snapshot);
    return;
  }
  if (!context.snapshot) {
    hideLeaderboardTimelineTooltip();
    setLeaderboardTimelineHighlight(context.target?.dataset.playerKey || null);
    return;
  }
  if (!context.series) return;
  setLeaderboardTimelineHighlight(context.series.key);
  showLeaderboardTimelineTooltip(context.point, context.series, context.snapshot);
}

function resetLeaderboardTimelineDrag(event) {
  const drag = leaderboardTimelineDrag;
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  const pointerId = drag.pointerId;
  const draggedAcrossSnapshots = drag.startSnapshot !== drag.currentSnapshot;
  leaderboardTimelineDrag = null;
  if (els.leaderboardTimeline.hasPointerCapture(pointerId)) {
    els.leaderboardTimeline.releasePointerCapture(pointerId);
  }
  if (leaderboardTimelineView) {
    for (const element of [
      leaderboardTimelineView.dragRange,
      leaderboardTimelineView.dragStartLine,
      leaderboardTimelineView.dragEndLine,
    ]) element.setAttribute("visibility", "hidden");
    for (const label of leaderboardTimelineView.deltaLabels.values()) {
      label.setAttribute("visibility", "hidden");
    }
  }
  if (draggedAcrossSnapshots) {
    leaderboardTimelineSuppressClick = true;
    setTimeout(() => { leaderboardTimelineSuppressClick = false; }, 0);
  }
  hideLeaderboardTimelineTooltip();
  setLeaderboardTimelineHighlight();
}

function setupLeaderboardTimelineInteractions() {
  const svg = els.leaderboardTimeline;
  svg.addEventListener("pointerdown", leaderboardTimelinePointerDown);
  svg.addEventListener("pointermove", leaderboardTimelinePointerMove);
  svg.addEventListener("pointerup", resetLeaderboardTimelineDrag);
  svg.addEventListener("pointercancel", resetLeaderboardTimelineDrag);
  svg.addEventListener("pointerleave", () => {
    if (leaderboardTimelineDrag) return;
    hideLeaderboardTimelineTooltip();
    setLeaderboardTimelineHighlight();
  });
  svg.addEventListener("click", (event) => {
    if (leaderboardTimelineSuppressClick) {
      event.preventDefault();
      leaderboardTimelineSuppressClick = false;
      return;
    }
    const target = event.target instanceof Element ? event.target.closest("[data-player-key]") : null;
    if (!target) {
      state.leaderboards.highlightedPlayer = null;
      setLeaderboardTimelineHighlight();
      return;
    }
    event.preventDefault();
    const key = target.dataset.playerKey;
    state.leaderboards.highlightedPlayer = state.leaderboards.highlightedPlayer === key ? null : key;
    setLeaderboardTimelineHighlight();
  });
  svg.addEventListener("focusin", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-player-key]") : null;
    if (target) setLeaderboardTimelineHighlight(target.dataset.playerKey);
  });
  svg.addEventListener("focusout", () => setTimeout(() => setLeaderboardTimelineHighlight(), 0));
  svg.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    state.leaderboards.highlightedPlayer = null;
    hideLeaderboardTimelineTooltip();
    setLeaderboardTimelineHighlight();
  });
}

function updateLeaderboardTimelineControls() {
  for (const button of els.leaderboardTimelineViewButtons) {
    const active = button.dataset.leaderboardTimelineView === state.leaderboards.timelineView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of els.leaderboardTimelineRangeButtons) {
    const active = button.dataset.leaderboardTimelineRange === state.leaderboards.timelineRange;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setupLeaderboards() {
  for (const button of els.leaderboardTimelineRangeButtons) {
    button.addEventListener("click", () => {
      const range = button.dataset.leaderboardTimelineRange;
      if (!["24h", "1w", "all"].includes(range)) return;
      state.leaderboards.timelineRange = range;
      state.leaderboards.highlightedPlayer = null;
      hideLeaderboardTimelineTooltip();
      updateLeaderboardTimelineControls();
      renderLeaderboardTimeline();
    });
  }
  for (const button of els.leaderboardMetricButtons) {
    button.addEventListener("click", () => {
      const metric = button.dataset.leaderboardMetric;
      if (metric !== "elo" && metric !== "world") return;
      state.leaderboards.metric = metric;
      state.leaderboards.highlightedPlayer = null;
      for (const option of els.leaderboardMetricButtons) {
        const active = option.dataset.leaderboardMetric === metric;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-pressed", String(active));
      }
      hideLeaderboardTimelineTooltip();
      renderLeaderboardGraph();
      renderLeaderboardTimeline();
    });
  }
  for (const button of els.leaderboardTimelineViewButtons) {
    button.addEventListener("click", () => {
      const view = button.dataset.leaderboardTimelineView;
      if (view !== "movement" && view !== "players") return;
      state.leaderboards.timelineView = view;
      state.leaderboards.highlightedPlayer = null;
      hideLeaderboardTimelineTooltip();
      updateLeaderboardTimelineControls();
      renderLeaderboardTimeline();
    });
  }
  setupLeaderboardTimelineInteractions();
  updateLeaderboardTimelineControls();
  renderLeaderboardGraph();
  renderLeaderboardTimeline();
}

async function refreshLeaderboards() {
  els.leaderboardsSection.setAttribute("aria-busy", "true");
  els.leaderboardStatus.textContent = state.leaderboards.fetchedAt ? "Refreshing rankings…" : "Loading live rankings…";
  const [currentResult, historyResult] = await Promise.allSettled([
    fetchJSON(`${API}/v1/leaderboard`),
    fetchJSON(`${API}/v1/leaderboard/history?limit=${LEADERBOARD_HISTORY_LIMIT}`),
    loadLeaderboardPlayerColors(),
  ]);

  let currentError = null;
  if (currentResult.status === "fulfilled") {
    const data = currentResult.value;
    if (!Array.isArray(data.elo) || !Array.isArray(data.world)) {
      currentError = new Error("Invalid leaderboard data.");
    } else {
      state.leaderboards.elo = data.elo.slice(0, 20);
      state.leaderboards.world = data.world.slice(0, 20);
      state.leaderboards.fetchedAt = Number(data.capturedAt ?? data.fetchedAt) || Math.floor(Date.now() / 1000);
    }
  } else {
    currentError = currentResult.reason;
  }

  if (historyResult.status === "fulfilled") {
    try {
      state.leaderboards.history = normalizeLeaderboardHistory(historyResult.value.rows);
      state.leaderboards.historyFetchedAt = state.leaderboards.history.at(-1)?.capturedAt ?? null;
      state.leaderboards.historyError = null;
      if (!state.leaderboards.fetchedAt && state.leaderboards.history.length) {
        const latest = state.leaderboards.history.at(-1);
        state.leaderboards.elo = latest.elo;
        state.leaderboards.world = latest.world;
        state.leaderboards.fetchedAt = latest.capturedAt;
      }
    } catch (error) {
      state.leaderboards.historyError = error.message || "Invalid leaderboard history.";
    }
  } else {
    state.leaderboards.historyError = historyResult.reason?.message || "Could not load leaderboard history.";
  }

  renderLeaderboardGraph();
  renderLeaderboardTimeline();
  if (currentError) {
    els.leaderboardStatus.textContent = state.leaderboards.fetchedAt
      ? "Update failed · showing last rankings"
      : "Rankings temporarily unavailable";
    els.leaderboardStatus.title = currentError.message || "Could not load rankings.";
  } else {
    const updated = new Date(state.leaderboards.fetchedAt * 1000);
    els.leaderboardStatus.textContent = `Live · updated ${timeFormat.format(updated)}`;
    els.leaderboardStatus.removeAttribute("title");
  }
  els.leaderboardsSection.setAttribute("aria-busy", "false");
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
  if (!MEMORY_CONSTRAINED && state.frontGlowScale !== scale) {
    const glowScale = 1 / Math.max(scale, 0.01);
    els.battleCanvas.style.setProperty("--front-glow-core", `${4 * glowScale}px`);
    els.battleCanvas.style.setProperty("--front-glow-near", `${9 * glowScale}px`);
    els.battleCanvas.style.setProperty("--front-glow-mid", `${18 * glowScale}px`);
    els.battleCanvas.style.setProperty("--front-glow-far", `${30 * glowScale}px`);
    state.frontGlowScale = scale;
  }
  updateOverlayViews();
  refreshRegionHover();
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

function focusIsland(islandId) {
  const island = state.region.islands?.[islandId];
  if (!island) return;
  const rect = els.viewport.getBoundingClientRect();
  const width = Math.max(24, island.maxX - island.minX + 1);
  const height = Math.max(24, island.maxY - island.minY + 1);
  const padding = Math.min(rect.width, rect.height) * 0.18;
  const scale = Math.min(
    (rect.width - padding * 2) / width,
    (rect.height - padding * 2) / height,
  );
  state.view.scale = Math.max(state.view.fit, Math.min(state.view.fit * 12, scale));
  state.view.tx = rect.width / 2 - ((island.minX + island.maxX + 1) / 2) * state.view.scale;
  state.view.ty = rect.height / 2 - ((island.minY + island.maxY + 1) / 2) * state.view.scale;
  clampView();
  applyView();
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
      event.preventDefault();
      els.viewport.setPointerCapture(event.pointerId);
      const point = regionPoint(event);
      state.region.pointerId = event.pointerId;
      state.region.start = { ...point, clientX: event.clientX, clientY: event.clientY };
      state.region.dragging = false;
      setHoveredIsland(0);
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
    state.region.lastPointer = { clientX: event.clientX, clientY: event.clientY };
    if (state.region.pointerId === event.pointerId && state.region.start) {
      const distance = Math.hypot(
        event.clientX - state.region.start.clientX,
        event.clientY - state.region.start.clientY,
      );
      if (distance >= 5) {
        if (!state.region.dragging) {
          state.region.dragging = true;
          state.region.selectedId = 0;
          els.regionIntel.hidden = true;
        }
        state.region.bounds = normalizedRegion(state.region.start, regionPoint(event));
        renderRegionOutline();
      }
      return;
    }
    refreshRegionHover();
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

  const releasePointer = (event, cancelled = false) => {
    if (state.region.pointerId === event.pointerId) {
      const wasDragging = state.region.dragging;
      const point = regionPoint(event);
      state.region.pointerId = null;
      state.region.start = null;
      state.region.dragging = false;
      if (cancelled) {
        clearRegion();
      } else if (wasDragging) {
        state.region.selectedId = 0;
        commitRegionAnalytics();
        updateRegionStats();
      } else {
        state.region.bounds = null;
        const islandId = islandAtMapPoint(point);
        if (islandId) selectIsland(islandId);
        else clearRegion();
      }
      refreshRegionHover();
      return;
    }
    pointers.delete(event.pointerId);
    pinchDistance = 0;
    if (pointers.size === 0) els.viewport.classList.remove("dragging");
  };
  els.viewport.addEventListener("pointerup", releasePointer);
  els.viewport.addEventListener("pointercancel", (event) => releasePointer(event, true));
  els.viewport.addEventListener("pointerenter", (event) => {
    state.region.pointerInside = true;
    state.region.lastPointer = { clientX: event.clientX, clientY: event.clientY };
    refreshRegionHover();
  });
  els.viewport.addEventListener("pointerleave", () => {
    state.region.pointerInside = false;
    refreshRegionHover();
  });

  els.viewport.addEventListener("dblclick", () => {
    if (!state.region.selecting) fitView();
  });

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
  els.showCityDensity.addEventListener("change", () => {
    els.islandDetails.hidden = !els.showCityDensity.checked;
    if (els.showCityDensity.checked) initializeIslandFeatures();
    scheduleDensityLabelLayout();
  });
  for (const button of document.querySelectorAll("[data-island-sort]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.islandSort;
      if (state.islandDetails.sortKey === key) {
        state.islandDetails.sortDirection = state.islandDetails.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.islandDetails.sortKey = key;
        state.islandDetails.sortDirection = key === "rank" ? "asc" : "desc";
      }
      renderIslandTable(state.islandDetails.stats);
    });
  }
  els.regionSelect.addEventListener("click", () => {
    if (state.region.selecting) {
      clearRegion();
      setRegionSelection(false);
    } else {
      ensureIslandIndex();
      setRegionSelection(true);
    }
  });
  els.islandTbody.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest("tr[data-island-id]");
    if (!row || !ensureIslandIndex()) return;
    const islandId = Number(row.dataset.islandId);
    if (!state.region.islands?.[islandId]) return;
    selectIsland(islandId);
    setRegionSelection(true);
    focusIsland(islandId);
  });
  els.islandTbody.addEventListener("keydown", (event) => {
    if (!(["Enter", " "].includes(event.key)) || !(event.target instanceof Element)) return;
    const row = event.target.closest("tr[data-island-id]");
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    row.click();
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "Escape" && state.region.selecting) {
      clearRegion();
      setRegionSelection(false);
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
  hideAccessGate();
  appStarted = true;
  await init();
}

async function init() {
  setupLeaderboards();
  void refreshLeaderboards();
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
    if (state.region.selectedId || state.region.bounds) commitRegionAnalytics();
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
    await setIndex(state.rows.length - 1);
    if (els.showCityDensity.checked) initializeIslandFeatures();
    // Paint the current map before starting hundreds of background snapshot
    // downloads. This avoids a large startup memory spike on mobile Safari.
    const startAnalytics = () => {
      analyticsReady = true;
      queueStats(state.rows);
      queueRegionStats(state.rows);
      scheduleAnalytics();
    };
    if (MEMORY_CONSTRAINED) setTimeout(startAnalytics, 1500);
    else startAnalytics();
    prefetch(Math.max(0, state.rows.length - PREFETCH_COUNT - 1), PREFETCH_COUNT);
  } catch (error) {
    showError(`Could not reach the map service: ${error.message}`);
    return;
  }
  setInterval(refreshLive, POLL_MS);
  setInterval(refreshLeaderboards, POLL_MS);
  setInterval(renderStatus, 30 * 1000);
}

bootstrap();

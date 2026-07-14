/* War of Dots — Nations campaign map frontend.
 * Static site; all data comes from the public snapshot API. */
"use strict";

const API = "https://wod-nations-map.moreofdots.workers.dev";
const MASK_URL = "assets/playable-mask.bitset.zlib";
const TERRAIN_URL = "assets/world_map.png";
const CITY_DATA_URL = "assets/city-points.json";

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
  cityOverlay: $("city-overlay"),
  objectiveOverlay: $("objective-overlay"),
  loading: $("map-loading"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
  overlayAlpha: $("overlay-alpha"),
  showCities: $("show-cities"),
  showObjectives: $("show-objectives"),
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
    const cityOwners = sampleCityOwners(row, built.rgba);
    setStat(row.mapHash, built.red, built.blue, countCityOwners(cityOwners));
    return { canvas, red: built.red, blue: built.blue, cityOwners };
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
  drawCities(entry.cityOwners);
  drawObjectives(row.objectives);
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

function updateOverlayViews() {
  const { scale, tx, ty } = state.view;
  const rect = els.viewport.getBoundingClientRect();
  if (scale <= 0 || rect.width <= 0 || rect.height <= 0) return;
  const viewBox = `${-tx / scale} ${-ty / scale} ${rect.width / scale} ${rect.height / scale}`;
  els.cityOverlay.setAttribute("viewBox", viewBox);
  els.objectiveOverlay.setAttribute("viewBox", viewBox);
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
  scheduleAnalytics(); // keep the chart marker and log highlight in sync
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
let chartHit = null; // { points: [{x, i, t, share}], hoverLine }

function shareOf(stats) {
  const total = stats.red + stats.blue;
  return total > 0 ? (stats.red / total) * 100 : null;
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
  const bytes = await inflate(await fetch(new URL(row.mapUrl, API)));
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

function renderChartStatus(points) {
  const el = els.chartStatus;
  const total = state.rows.length;
  if (total === 0 || points.length === 0) {
    el.textContent = "";
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
  let text;
  if (Math.abs(margin) < 0.005) {
    text = "Dead heat";
  } else {
    text = `${margin > 0 ? "Red Empire" : "Blue Republic"} leads by ${Math.abs(margin).toFixed(2)} pp`;
  }
  // Trend against the point closest to 24 h ago (if history reaches back far enough).
  const target = latest.t - 24 * 3600;
  let baseline = points[0];
  for (const p of points) {
    if (Math.abs(p.t - target) < Math.abs(baseline.t - target)) baseline = p;
  }
  if (latest.t - baseline.t >= 3 * 3600) {
    const change = latest.share - baseline.share;
    if (Math.abs(change) >= 0.005) {
      const hours = Math.round((latest.t - baseline.t) / 3600);
      text += ` · ${change > 0 ? "Red" : "Blue"} +${Math.abs(change).toFixed(2)} pp in ${hours} h`;
    }
  }
  el.textContent = text;
  el.className = `chart-status ${margin >= 0 ? "lead-red" : "lead-blue"}`;
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
    if (share !== null) points.push({ i, t: rows[i].capturedAt, share });
  }
  renderChartStatus(points);
  if (points.length < 2) {
    const message = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart-empty" });
    message.textContent = rows.length === 0 ? "Waiting for snapshots…" : "Analyzing snapshots…";
    svg.append(message);
    return;
  }

  const pad = { top: 18, right: 66, bottom: 26, left: 12 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const t0 = rows[0].capturedAt;
  const t1 = rows[rows.length - 1].capturedAt;
  const xOf = (t) => (t1 === t0 ? pad.left + plotW / 2 : pad.left + ((t - t0) / (t1 - t0)) * plotW);

  // Y domain covers both lines, always includes the 50% battle line.
  let lo = 49.5;
  let hi = 50.5;
  for (const p of points) {
    lo = Math.min(lo, p.share, 100 - p.share);
    hi = Math.max(hi, p.share, 100 - p.share);
  }
  const padY = Math.max(0.3, (hi - lo) * 0.12);
  lo = Math.max(0, lo - padY);
  hi = Math.min(100, hi + padY);
  const yOf = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;

  let redLine = "";
  let blueLine = "";
  for (let k = 0; k < points.length; k += 1) {
    const p = points[k];
    const x = xOf(p.t).toFixed(1);
    redLine += `${k === 0 ? "M" : "L"}${x},${yOf(p.share).toFixed(1)}`;
    blueLine += `${k === 0 ? "M" : "L"}${x},${yOf(100 - p.share).toFixed(1)}`;
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
  if (currentRow) {
    const x = xOf(currentRow.capturedAt).toFixed(1);
    svg.append(svgEl("line", { x1: x, x2: x, y1: pad.top, y2: pad.top + plotH, class: "chart-marker" }));
    const currentPoint = points.find((p) => p.i === state.index);
    if (currentPoint) {
      svg.append(
        svgEl("circle", { cx: x, cy: yOf(currentPoint.share).toFixed(1), r: 4, class: "chart-dot chart-dot-red" }),
        svgEl("circle", { cx: x, cy: yOf(100 - currentPoint.share).toFixed(1), r: 4, class: "chart-dot chart-dot-blue" }),
      );
    }
  }

  svg.append(
    svgEl("path", { d: redLine, class: "chart-line chart-line-red" }),
    svgEl("path", { d: blueLine, class: "chart-line chart-line-blue" }),
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

  const hoverLine = svgEl("line", { x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH, class: "chart-hover-line" });
  hoverLine.style.visibility = "hidden";
  svg.append(hoverLine);
  chartHit = { points: points.map((p) => ({ ...p, x: xOf(p.t) })), hoverLine };
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

function chartHover(event) {
  const point = chartPointFromEvent(event);
  if (!point) return;
  chartHit.hoverLine.setAttribute("x1", point.x);
  chartHit.hoverLine.setAttribute("x2", point.x);
  chartHit.hoverLine.style.visibility = "visible";
  const tooltip = els.chartTooltip;
  tooltip.replaceChildren();
  const when = document.createElement("div");
  when.className = "tt-time";
  when.textContent = timeFormat.format(new Date(point.t * 1000));
  const red = document.createElement("div");
  red.className = "tt-red";
  red.textContent = `Red ${point.share.toFixed(3)}%`;
  const blue = document.createElement("div");
  blue.className = "tt-blue";
  blue.textContent = `Blue ${(100 - point.share).toFixed(3)}%`;
  tooltip.append(when, red, blue);
  tooltip.hidden = false;
  const wrapWidth = els.chartWrap.getBoundingClientRect().width;
  const left = point.x + 14 + tooltip.offsetWidth > wrapWidth
    ? point.x - 14 - tooltip.offsetWidth
    : point.x + 14;
  tooltip.style.left = `${Math.max(0, left)}px`;
}

function chartLeave() {
  els.chartTooltip.hidden = true;
  if (chartHit) chartHit.hoverLine.style.visibility = "hidden";
}

function chartClick(event) {
  const point = chartPointFromEvent(event);
  if (!point) return;
  setPlaying(false);
  setIndex(point.i);
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

function citiesCell(tr, stats) {
  if (!stats || !Number.isFinite(stats.cityRed) || !Number.isFinite(stats.cityBlue)) {
    addCell(tr, "num cell-flat", "…");
    return;
  }
  const td = document.createElement("td");
  td.className = "num city-count-cell";
  const red = document.createElement("span");
  red.className = "cell-red";
  red.textContent = `R ${stats.cityRed}`;
  const separator = document.createElement("span");
  separator.className = "cell-flat";
  separator.textContent = " / ";
  const blue = document.createElement("span");
  blue.className = "cell-blue";
  blue.textContent = `B ${stats.cityBlue}`;
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
    addCell(tr, "num cell-red", share === null ? "…" : `${share.toFixed(3)}%`);
    addCell(tr, "num cell-blue", share === null ? "…" : `${(100 - share).toFixed(3)}%`);

    if (share === null) {
      addCell(tr, "num cell-flat", "…");
    } else {
      const margin = share - (100 - share);
      factionCell(tr, margin, Math.abs(margin).toFixed(3));
    }

    if (i === 0) {
      // Oldest loaded snapshot has nothing loaded to compare against.
      addCell(tr, "num cell-flat", "—");
      addCell(tr, "num cell-flat", "—");
    } else if (share === null || prevShare === null) {
      addCell(tr, "num cell-flat", "…");
      addCell(tr, "num cell-flat", "…");
    } else {
      const deltaShare = share - prevShare;
      factionCell(tr, Math.abs(deltaShare) < 0.0005 ? 0 : deltaShare, Math.abs(deltaShare).toFixed(3));
      const deltaPx = stats.red - prevStats.red;
      factionCell(tr, deltaPx, Math.abs(deltaPx).toLocaleString());
    }

    citiesCell(tr, stats);
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
  els.chartWrap.addEventListener("pointermove", chartHover);
  els.chartWrap.addEventListener("pointerleave", chartLeave);
  els.chartWrap.addEventListener("click", chartClick);
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
  els.showCities.addEventListener("change", drawMap);
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
    const [terrain, mask, cityData, timeline, health] = await Promise.all([
      loadTerrain(),
      (async () => inflate(await fetch(MASK_URL)))(),
      fetchJSON(CITY_DATA_URL),
      fetchJSON(`${API}/v1/timeline?limit=336`),
      fetchJSON(`${API}/health`),
    ]);
    state.terrain = terrain;
    state.mask = mask;
    state.cityData = cityData;
    buildCityMarkers();
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

init();

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
  buildGrid,
  logarithmicGainRates,
  simulateCampaignTimeline,
} = require("./objective-simulator.js");

function ownersAfter(grid, frames, step) {
  const owners = new Int8Array(grid.owners);
  for (let frameIndex = 1; frameIndex <= step; frameIndex += 1) {
    for (const encoded of frames[frameIndex].changes) owners[encoded >>> 1] = encoded & 1;
  }
  return owners;
}

function syntheticGrid() {
  const width = 7;
  const height = 5;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = x < 2;
      rgba[offset] = red ? 217 : 63;
      rgba[offset + 1] = red ? 65 : 108;
      rgba[offset + 2] = red ? 65 : 224;
      rgba[offset + 3] = 255;
    }
  }
  return buildGrid({
    rgba,
    width,
    height,
    step: 1,
    cities: [[4, 0], [4, 4], [6, 2]],
    cityOwners: [0, 0, 0],
  });
}

test("gain balance is logarithmic with 200 pixels per side at center", () => {
  assert.deepEqual(logarithmicGainRates(0), { red: 200, blue: 200 });
  assert.deepEqual(logarithmicGainRates(-1000), { red: 1000, blue: 0 });
  assert.deepEqual(logarithmicGainRates(1000), { red: 0, blue: 1000 });
  assert.equal(logarithmicGainRates(-500).red, 467);
  assert.equal(logarithmicGainRates(500).blue, 467);
});

test("grid records any faction foothold on an island, even below the cell majority", () => {
  const rgba = new Uint8ClampedArray([
    217, 65, 65, 255,
    63, 108, 224, 255,
  ]);
  const grid = buildGrid({
    rgba,
    width: 2,
    height: 1,
    step: 2,
    islandIds: new Uint16Array([1, 1]),
  });
  assert.equal(grid.owners[0], 0);
  assert.equal(grid.islandIds[0], 1);
  assert.equal(grid.islandAccess[1], 3);
});

test("equal pressure deadlocks on the same front", () => {
  const grid = syntheticGrid();
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 3, y: 2 }, { x: 3, y: 2 }],
    { red: 2, blue: 2 },
    1,
    { conflictRadiusCells: 10 },
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [...grid.owners]);
  assert.equal(frames[1].contested, true);
});

test("separate objectives deadlock when their advancing fronts meet", () => {
  const grid = {
    width: 6,
    height: 1,
    mapWidth: 6,
    mapHeight: 1,
    owners: new Int8Array([1, 1, 1, 0, 0, 0]),
    weights: new Uint16Array([1, 1, 1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 1, 1, 1, 1]),
    islandAccess: new Uint8Array([0, 3]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    { red: 1, blue: 1 },
    1,
    { conflictRadiusPixels: 0 },
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [...grid.owners]);
  assert.equal(frames[1].contested, true);
  assert.equal(frames[1].redClaimed, 0);
  assert.equal(frames[1].blueClaimed, 0);
});

test("only excess pressure advances through a contested front", () => {
  const grid = {
    width: 6,
    height: 1,
    mapWidth: 6,
    mapHeight: 1,
    owners: new Int8Array([1, 1, 1, 0, 0, 0]),
    weights: new Uint16Array([1, 1, 1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 1, 1, 1, 1]),
    islandAccess: new Uint8Array([0, 3]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    { red: 1, blue: 2 },
    2,
    { conflictRadiusPixels: 0 },
  );
  assert.deepEqual([...ownersAfter(grid, frames, 2)], [1, 0, 0, 0, 0, 0]);
  assert.equal(frames[2].contested, true);
  assert.equal(frames[2].redClaimed, 0);
  assert.equal(frames[2].blueClaimed, 1);
});

test("equal pressure can gain land on separate fronts", () => {
  const grid = syntheticGrid();
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 0, y: 0 }, { x: 6, y: 4 }],
    { red: 2, blue: 2 },
    1,
    { conflictRadiusCells: 1 },
  );
  assert.notDeepEqual([...ownersAfter(grid, frames, 1)], [...grid.owners]);
  assert.equal(frames[1].contested, false);
  assert.equal(frames[1].redClaimed, 2);
  assert.equal(frames[1].blueClaimed, 2);
});

test("a faction cannot invade an island where it has no starting pixels", () => {
  const grid = {
    width: 4,
    height: 1,
    mapWidth: 4,
    mapHeight: 1,
    owners: new Int8Array([1, 0, 0, 0]),
    weights: new Uint16Array([1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 2, 2]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    { red: 10, blue: 0 },
    1,
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [1, 1, 0, 0]);
  assert.equal(frames[1].redClaimed, 1);
});

test("an objective radius advances across every eligible island it reaches", () => {
  const grid = {
    width: 4,
    height: 1,
    mapWidth: 4,
    mapHeight: 1,
    owners: new Int8Array([1, 0, 1, 0]),
    weights: new Uint16Array([1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 2, 2]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    { red: 10, blue: 0 },
    1,
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [1, 1, 1, 1]);
  assert.equal(frames[1].redClaimed, 2);
});

test("radius captures the nearest eligible pixel regardless of shoreline", () => {
  const grid = {
    width: 4,
    height: 1,
    mapWidth: 4,
    mapHeight: 1,
    owners: new Int8Array([1, 0, 1, 0]),
    weights: new Uint16Array([1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 2, 2]),
    islandAccess: new Uint8Array([0, 3, 3]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    { red: 1, blue: 0 },
    1,
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [1, 0, 1, 1]);
});

test("an objective placed deep in enemy land spreads there without a corridor", () => {
  const grid = {
    width: 7,
    height: 1,
    mapWidth: 7,
    mapHeight: 1,
    owners: new Int8Array([0, 0, 1, 1, 1, 1, 1]),
    weights: new Uint16Array([1, 1, 1, 1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 1, 1, 1, 1, 1]),
    islandAccess: new Uint8Array([0, 3]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 5, y: 0 }, { x: 0, y: 0 }],
    { red: 0, blue: 1 },
    1,
    { conflictRadiusPixels: 0 },
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [0, 0, 1, 1, 1, 0, 1]);
  assert.equal(frames[1].blueClaimed, 1);
});

test("objective perimeter radius grows from the objective as pixels are reached", () => {
  const grid = {
    width: 7,
    height: 1,
    mapWidth: 7,
    mapHeight: 1,
    owners: new Int8Array([0, 1, 1, 1, 1, 1, 1]),
    weights: new Uint16Array([1, 1, 1, 1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 1, 1, 1, 1, 1]),
    islandAccess: new Uint8Array([0, 3]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 0, y: 0 }, { x: 6, y: 0 }],
    { red: 0, blue: 1 },
    2,
    { conflictRadiusPixels: 0 },
  );
  assert.ok(frames[0].blueRadius > 0);
  assert.equal(frames[1].blueRadius, frames[0].blueRadius);
  assert.ok(frames[2].blueRadius > frames[1].blueRadius);
});

test("pixel-level expansion consumes the selected island without remnants", () => {
  const grid = {
    width: 7,
    height: 1,
    mapWidth: 7,
    mapHeight: 1,
    owners: new Int8Array([0, 1, 1, 1, 1, 1, 1]),
    weights: new Uint16Array([1, 1, 1, 1, 1, 1, 1]),
    cityCells: new Int32Array(0),
    islandIds: new Uint32Array([1, 1, 1, 1, 1, 1, 1]),
    islandAccess: new Uint8Array([0, 3]),
  };
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 4, y: 0 }, { x: 0, y: 0 }],
    { red: 0, blue: 10 },
    1,
    { conflictRadiusPixels: 0 },
  );
  assert.deepEqual([...ownersAfter(grid, frames, 1)], [0, 0, 0, 0, 0, 0, 0]);
});

test("48 hours produces 96 half-hour projection steps", () => {
  const grid = syntheticGrid();
  const frames = simulateCampaignTimeline(
    grid,
    [{ x: 0, y: 0 }, { x: 6, y: 4 }],
    logarithmicGainRates(0),
    96,
  );
  assert.equal(frames.length, 97);
});

test("worker protocol returns the complete simulated timeline", () => {
  let messageHandler = null;
  let response = null;
  let transferred = null;
  const context = {
    addEventListener(type, handler) {
      if (type === "message") messageHandler = handler;
    },
    postMessage(message, transferList) {
      response = message;
      transferred = transferList;
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./objective-simulator.js"), "utf8"), context);
  assert.equal(typeof messageHandler, "function");

  messageHandler({
    data: {
      type: "simulate",
      requestId: 42,
      grid: syntheticGrid(),
      objectives: [{ x: 0, y: 0 }, { x: 6, y: 4 }],
      gains: { red: 2, blue: 2 },
      steps: 3,
    },
  });

  assert.equal(response.type, "complete");
  assert.equal(response.requestId, 42);
  assert.equal(response.frames.length, 4);
  assert.equal(transferred.length, 4);
});

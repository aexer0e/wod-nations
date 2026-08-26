"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectHistoryPages,
  interpolateValue,
  pearsonCorrelation,
  rollingComparison,
  valueExtent,
} = require("./ranking-momentum.js");

test("collects every leaderboard history page", async () => {
  const requestedCursors = [];
  const pages = new Map([
    [null, { rows: [{ capturedAt: 3 }, { capturedAt: 2 }], nextBefore: 2, top: 20 }],
    [2, { rows: [{ capturedAt: 1 }], nextBefore: null, top: 20 }],
  ]);
  const result = await collectHistoryPages(async (before) => {
    requestedCursors.push(before);
    return pages.get(before);
  });
  assert.deepEqual(requestedCursors, [null, 2]);
  assert.deepEqual(result, {
    rows: [{ capturedAt: 3 }, { capturedAt: 2 }, { capturedAt: 1 }],
    top: 20,
  });
});

test("rejects a leaderboard history cursor loop", async () => {
  await assert.rejects(
    collectHistoryPages(async () => ({ rows: [], nextBefore: 2, top: 20 })),
    /did not advance/,
  );
});

test("interpolates land values at leaderboard snapshot times", () => {
  const points = [{ capturedAt: 0, value: -2 }, { capturedAt: 20, value: 2 }];
  assert.equal(interpolateValue(points, 10), 0);
  assert.equal(interpolateValue(points, -1), null);
});

test("rolling comparison exposes aligned normalized derivatives", () => {
  const ranking = [0, 1, 2, 3].map((value) => ({ capturedAt: value * 3600, value: value * 10 }));
  const land = [0, 1, 2, 3].map((value) => ({ capturedAt: value * 3600, value: value * 2 }));
  const result = rollingComparison(ranking, land, 2);
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples[0].rankingRate, 10);
  assert.equal(result.samples[0].landRate, 2);
  assert.equal(result.samples[0].rankingNormalized, 1);
  assert.equal(result.correlation, null, "constant rates have no defined correlation");
});

test("correlation distinguishes aligned and opposed movement", () => {
  assert.equal(pearsonCorrelation([[1, 2], [2, 4], [3, 6]]), 1);
  assert.equal(pearsonCorrelation([[1, 6], [2, 4], [3, 2]]), -1);
});

test("value extent fits whenever at least one available player is selected", () => {
  const series = [
    { key: "a", points: [{ value: 10 }, { value: 20 }] },
    { key: "b", points: [{ value: 100 }, { value: 120 }] },
    { key: "c", points: [{ value: 1000 }] },
  ];
  assert.deepEqual(valueExtent(series, new Set(["a"])), {
    values: [10, 20],
    fittedToSelection: true,
    selectedCount: 1,
  });
  assert.deepEqual(valueExtent(series, new Set(["a", "b"])), {
    values: [10, 20, 100, 120],
    fittedToSelection: true,
    selectedCount: 2,
  });
});

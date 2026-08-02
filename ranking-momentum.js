(function exposeRankingMomentum(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RankingMomentum = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildRankingMomentum() {
  "use strict";

  function validPoints(points) {
    return (Array.isArray(points) ? points : [])
      .filter((point) => point
        && Number.isFinite(Number(point.capturedAt))
        && Number.isFinite(Number(point.value)))
      .map((point) => ({ capturedAt: Number(point.capturedAt), value: Number(point.value) }))
      .sort((a, b) => a.capturedAt - b.capturedAt);
  }

  function interpolateSortedValue(samples, capturedAt) {
    if (!samples.length || capturedAt < samples[0].capturedAt || capturedAt > samples.at(-1).capturedAt) return null;
    let low = 0;
    let high = samples.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const point = samples[middle];
      if (point.capturedAt === capturedAt) return point.value;
      if (point.capturedAt < capturedAt) low = middle + 1;
      else high = middle - 1;
    }
    const before = samples[Math.max(0, high)];
    const after = samples[Math.min(samples.length - 1, low)];
    if (!before || !after || before.capturedAt === after.capturedAt) return before?.value ?? after?.value ?? null;
    const ratio = (capturedAt - before.capturedAt) / (after.capturedAt - before.capturedAt);
    return before.value + (after.value - before.value) * ratio;
  }

  function interpolateValue(points, capturedAt) {
    return interpolateSortedValue(validPoints(points), capturedAt);
  }

  function pearsonCorrelation(pairs) {
    if (!Array.isArray(pairs) || pairs.length < 2) return null;
    const xMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
    const yMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
    let covariance = 0;
    let xVariance = 0;
    let yVariance = 0;
    for (const [x, y] of pairs) {
      const xDelta = x - xMean;
      const yDelta = y - yMean;
      covariance += xDelta * yDelta;
      xVariance += xDelta * xDelta;
      yVariance += yDelta * yDelta;
    }
    if (xVariance < 1e-12 || yVariance < 1e-12) return null;
    return covariance / Math.sqrt(xVariance * yVariance);
  }

  function rollingComparison(rankingPoints, landPoints, windowSize = 6) {
    const ranking = validPoints(rankingPoints);
    const land = validPoints(landPoints);
    const size = Math.max(2, Math.round(Number(windowSize) || 6));
    const aligned = ranking.map((point) => ({
      ...point,
      landValue: interpolateSortedValue(land, point.capturedAt),
    }));
    const samples = [];
    for (let index = size - 1; index < aligned.length; index += 1) {
      const current = aligned[index];
      const baseline = aligned[index - size + 1];
      if (current.landValue === null || baseline.landValue === null) continue;
      const hours = (current.capturedAt - baseline.capturedAt) / 3600;
      if (!(hours > 0)) continue;
      samples.push({
        capturedAt: current.capturedAt,
        rankingRate: (current.value - baseline.value) / hours,
        landRate: (current.landValue - baseline.landValue) / hours,
      });
    }
    const rankingScale = Math.max(1e-9, ...samples.map((sample) => Math.abs(sample.rankingRate)));
    const landScale = Math.max(1e-9, ...samples.map((sample) => Math.abs(sample.landRate)));
    for (const sample of samples) {
      sample.rankingNormalized = sample.rankingRate / rankingScale;
      sample.landNormalized = sample.landRate / landScale;
    }
    return {
      windowSize: size,
      samples,
      rankingScale,
      landScale,
      correlation: pearsonCorrelation(samples.map((sample) => [sample.rankingRate, sample.landRate])),
    };
  }

  function valueExtent(series, selectedKeys) {
    const selection = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
    const selected = selection.size > 0
      ? (Array.isArray(series) ? series : []).filter((item) => selection.has(item.key))
      : [];
    const source = selected.length > 0 ? selected : (Array.isArray(series) ? series : []);
    const values = source.flatMap((item) => (Array.isArray(item.points) ? item.points : []))
      .filter(Boolean)
      .map((point) => Number(point.value))
      .filter(Number.isFinite);
    return {
      values,
      fittedToSelection: selected.length > 0,
      selectedCount: selected.length,
    };
  }

  return { interpolateValue, pearsonCorrelation, rollingComparison, valueExtent };
});

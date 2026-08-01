/* Simultaneous 48-hour objective simulation for the Nations map. */
(function exposeObjectiveSimulator(globalScope) {
  "use strict";

  class MinHeap {
    constructor() {
      this.items = [];
    }

    push(priority, value) {
      const item = { priority, value };
      let index = this.items.length;
      this.items.push(item);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this.items[parent].priority <= priority) break;
        this.items[index] = this.items[parent];
        index = parent;
      }
      this.items[index] = item;
    }

    pop() {
      if (this.items.length === 0) return null;
      const first = this.items[0];
      const last = this.items.pop();
      if (this.items.length === 0) return first;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.items.length) break;
        const right = left + 1;
        const child = right < this.items.length
          && this.items[right].priority < this.items[left].priority
          ? right
          : left;
        if (this.items[child].priority >= last.priority) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
      return first;
    }

    get size() {
      return this.items.length;
    }
  }

  function buildGrid({
    rgba,
    width,
    height,
    step = 6,
    mapWidth = width,
    mapHeight = height,
    cities = [],
    cityOwners = [],
    islandIds = null,
  }) {
    const gridWidth = Math.ceil(width / step);
    const gridHeight = Math.ceil(height / step);
    const owners = new Int8Array(gridWidth * gridHeight);
    const weights = new Uint16Array(owners.length);
    const cellIslandIds = islandIds ? new Uint32Array(owners.length) : null;
    let islandAccess = null;
    if (islandIds) {
      let largestIslandId = 0;
      for (const islandId of islandIds) largestIslandId = Math.max(largestIslandId, islandId);
      islandAccess = new Uint8Array(largestIslandId + 1);
    }
    owners.fill(-1);

    for (let gridY = 0; gridY < gridHeight; gridY += 1) {
      const top = gridY * step;
      const bottom = Math.min(height, top + step);
      for (let gridX = 0; gridX < gridWidth; gridX += 1) {
        const left = gridX * step;
        const right = Math.min(width, left + step);
        let blue = 0;
        let red = 0;
        let firstIslandId = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const offset = (y * width + x) * 4;
            if (rgba[offset + 3] === 0) continue;
            const islandId = islandIds ? islandIds[y * width + x] || 0 : 0;
            if (!firstIslandId) firstIslandId = islandId;
            if (rgba[offset] > rgba[offset + 2]) {
              red += 1;
              if (islandId) islandAccess[islandId] |= 2;
            } else {
              blue += 1;
              if (islandId) islandAccess[islandId] |= 1;
            }
          }
        }
        const index = gridY * gridWidth + gridX;
        weights[index] = red + blue;
        if (weights[index] > 0) owners[index] = red > blue ? 1 : 0;
        if (cellIslandIds) {
          const centerX = Math.min(width - 1, Math.floor((left + right - 1) / 2));
          const centerY = Math.min(height - 1, Math.floor((top + bottom - 1) / 2));
          cellIslandIds[index] = islandIds[centerY * width + centerX] || firstIslandId;
        }
      }
    }

    const cityCells = new Int32Array(cities.length);
    cityCells.fill(-1);
    cities.forEach(([mapX, mapY], cityIndex) => {
      const x = Math.min(gridWidth - 1, Math.max(0, Math.floor((mapX / mapWidth) * gridWidth)));
      const y = Math.min(gridHeight - 1, Math.max(0, Math.floor((mapY / mapHeight) * gridHeight)));
      const index = y * gridWidth + x;
      cityCells[cityIndex] = index;
      const owner = Number(cityOwners[cityIndex]);
      if ((owner === 0 || owner === 1) && weights[index] > 0) owners[index] = owner;
    });

    return {
      width: gridWidth,
      height: gridHeight,
      mapWidth,
      mapHeight,
      owners,
      weights,
      cityCells,
      islandIds: cellIslandIds,
      islandAccess,
    };
  }

  /* Exponential response: each side reads 200 at the physical center,
   * reaches 1,000 at its endpoint, and falls to zero at the opposite end. */
  function logarithmicGainRates(balance) {
    const clamped = Math.max(-1000, Math.min(1000, Number(balance) || 0));
    const curve = (position) => Math.round((1000 * (16 ** position - 1)) / 15);
    return {
      red: curve((1000 - clamped) / 2000),
      blue: curve((1000 + clamped) / 2000),
    };
  }

  function accessibleIslandsFor(grid, owners) {
    if (!grid.islandIds) return null;
    let largestIslandId = Math.max(0, (grid.islandAccess?.length || 1) - 1);
    for (const islandId of grid.islandIds) largestIslandId = Math.max(largestIslandId, islandId);
    const accessible = [
      new Uint8Array(largestIslandId + 1),
      new Uint8Array(largestIslandId + 1),
    ];
    if (grid.islandAccess) {
      for (let islandId = 1; islandId < grid.islandAccess.length; islandId += 1) {
        accessible[0][islandId] = grid.islandAccess[islandId] & 1;
        accessible[1][islandId] = (grid.islandAccess[islandId] & 2) >> 1;
      }
      return accessible;
    }
    for (let index = 0; index < owners.length; index += 1) {
      const owner = owners[index];
      const islandId = grid.islandIds[index];
      if ((owner === 0 || owner === 1) && islandId) accessible[owner][islandId] = 1;
    }
    return accessible;
  }

  function createRadiusPlan(grid, owners, attacker, objective, accessibleIslands) {
    const enemy = 1 - attacker;
    const objectiveX = Math.max(0, Math.min(grid.mapWidth,
      Number(objective?.x) || 0));
    const objectiveY = Math.max(0, Math.min(grid.mapHeight,
      Number(objective?.y) || 0));
    const startX = Math.min(grid.width - 1, Math.max(0,
      Math.floor((objectiveX / grid.mapWidth) * grid.width)));
    const startY = Math.min(grid.height - 1, Math.max(0,
      Math.floor((objectiveY / grid.mapHeight) * grid.height)));
    const visited = new Uint8Array(owners.length);
    const heap = new MinHeap();
    let pending = [];
    let radius = 0;

    const eligibleEnemy = (index) => {
      if (owners[index] !== enemy) return false;
      if (!accessibleIslands) return true;
      const islandId = grid.islandIds[index];
      return Boolean(islandId && accessibleIslands[islandId]);
    };

    let hasEligibleEnemy = false;
    for (let index = 0; index < owners.length; index += 1) {
      if (eligibleEnemy(index)) {
        hasEligibleEnemy = true;
        break;
      }
    }

    function enqueue(x, y) {
      if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return;
      const index = y * grid.width + x;
      if (visited[index]) return;
      visited[index] = 1;
      const mapX = ((x + 0.5) * grid.mapWidth) / grid.width;
      const mapY = ((y + 0.5) * grid.mapHeight) / grid.height;
      const dx = mapX - objectiveX;
      const dy = mapY - objectiveY;
      heap.push(dx * dx + dy * dy, index);
    }

    if (hasEligibleEnemy) enqueue(startX, startY);

    function cleanPending() {
      pending = pending.filter((item) => owners[item.index] === enemy);
    }

    function fillPending(limit) {
      cleanPending();
      while (heap.size > 0 && pending.length < limit) {
        const item = heap.pop();
        const index = item.value;
        const x = index % grid.width;
        const y = Math.floor(index / grid.width);
        enqueue(x - 1, y);
        enqueue(x + 1, y);
        enqueue(x, y - 1);
        enqueue(x, y + 1);
        enqueue(x - 1, y - 1);
        enqueue(x + 1, y - 1);
        enqueue(x - 1, y + 1);
        enqueue(x + 1, y + 1);
        if (eligibleEnemy(index)) pending.push({ index, radius: Math.sqrt(item.priority) });
      }
    }

    const plan = {
      objectiveX,
      objectiveY,
      preview(budget) {
        fillPending(budget);
        return pending.slice(0, budget).map((item) => item.index);
      },
      commit(budget) {
        fillPending(budget);
        const committed = pending.splice(0, budget);
        for (const item of committed) radius = Math.max(radius, item.radius);
        return {
          cells: committed.map((item) => item.index),
          pixels: committed.length,
          radius,
        };
      },
      get radius() { return radius; },
    };
    plan.preview(1);
    radius = pending[0]?.radius || 0;
    return plan;
  }

  function frontsTouch(grid, blueCells, redCells) {
    if (blueCells.length === 0 || redCells.length === 0) return false;
    const blue = new Set(blueCells);
    for (const index of redCells) {
      const x = index % grid.width;
      const y = Math.floor(index / grid.width);
      for (let dy = -1; dy <= 1; dy += 1) {
        const neighborY = y + dy;
        if (neighborY < 0 || neighborY >= grid.height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighborX = x + dx;
          if (neighborX < 0 || neighborX >= grid.width) continue;
          if (blue.has(neighborY * grid.width + neighborX)) return true;
        }
      }
    }
    return false;
  }

  function simulateCampaignTimeline(grid, objectives, gainsPerStep, steps = 96, options = {}) {
    const owners = new Int8Array(grid.owners);
    const accessible = accessibleIslandsFor(grid, owners);
    const bluePlan = createRadiusPlan(grid, owners, 0, objectives[0], accessible?.[0]);
    const redPlan = createRadiusPlan(grid, owners, 1, objectives[1], accessible?.[1]);
    const available = [0, 0];
    const scale = grid.width / grid.mapWidth;
    const conflictRadius = options.conflictRadiusPixels ?? options.conflictRadiusCells ?? 84 * scale;
    const objectiveDx = bluePlan.objectiveX - redPlan.objectiveX;
    const objectiveDy = bluePlan.objectiveY - redPlan.objectiveY;
    const objectivesOverlap = objectiveDx * objectiveDx + objectiveDy * objectiveDy
      <= conflictRadius * conflictRadius;
    let frontsEngaged = false;

    let redPixels = 0;
    let bluePixels = 0;
    for (let index = 0; index < owners.length; index += 1) {
      if (owners[index] === 1) redPixels += grid.weights[index] || 1;
      else if (owners[index] === 0) bluePixels += grid.weights[index] || 1;
    }
    let redDelta = 0;
    let blueDelta = 0;
    let blueRadius = bluePlan.radius;
    let redRadius = redPlan.radius;
    const frames = [{
      changes: new Uint32Array(0),
      redPixels,
      bluePixels,
      redDelta,
      blueDelta,
      contested: false,
      redClaimed: 0,
      blueClaimed: 0,
      redRadius,
      blueRadius,
    }];

    for (let step = 1; step <= steps; step += 1) {
      available[0] += Math.max(0, Number(gainsPerStep.blue) || 0);
      available[1] += Math.max(0, Number(gainsPerStep.red) || 0);
      const bluePreview = bluePlan.preview(Math.floor(available[0]));
      const redPreview = redPlan.preview(Math.floor(available[1]));
      if (frontsTouch(grid, bluePreview, redPreview)) frontsEngaged = true;
      const contested = objectivesOverlap || frontsEngaged;
      if (contested) {
        const cancelled = Math.min(available[0], available[1]);
        available[0] -= cancelled;
        available[1] -= cancelled;
      }
      const blueClaims = bluePlan.commit(Math.floor(available[0]));
      const redClaims = redPlan.commit(Math.floor(available[1]));
      available[0] -= blueClaims.pixels;
      available[1] -= redClaims.pixels;
      blueRadius = blueClaims.radius;
      redRadius = redClaims.radius;

      const changes = new Uint32Array(blueClaims.cells.length + redClaims.cells.length);
      let changeIndex = 0;
      for (const index of blueClaims.cells) {
        owners[index] = 0;
        changes[changeIndex++] = index * 2;
      }
      for (const index of redClaims.cells) {
        owners[index] = 1;
        changes[changeIndex++] = index * 2 + 1;
      }
      bluePixels += blueClaims.pixels - redClaims.pixels;
      redPixels += redClaims.pixels - blueClaims.pixels;
      blueDelta += blueClaims.pixels - redClaims.pixels;
      redDelta += redClaims.pixels - blueClaims.pixels;
      frames.push({
        changes,
        redPixels,
        bluePixels,
        redDelta,
        blueDelta,
        contested,
        redClaimed: redClaims.pixels,
        blueClaimed: blueClaims.pixels,
        redRadius,
        blueRadius,
      });
    }
    return frames;
  }

  const api = { buildGrid, logarithmicGainRates, simulateCampaignTimeline };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ObjectiveSimulator = api;

  const isWorker = typeof document === "undefined"
    && typeof globalScope.addEventListener === "function"
    && typeof globalScope.postMessage === "function";
  if (isWorker) {
    globalScope.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "simulate") return;
      try {
        const frames = simulateCampaignTimeline(
          message.grid,
          message.objectives,
          message.gains,
          message.steps,
        );
        globalScope.postMessage({
          type: "complete",
          requestId: message.requestId,
          frames,
        }, frames.map((frame) => frame.changes.buffer));
      } catch (error) {
        globalScope.postMessage({
          type: "error",
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}(typeof window === "undefined" ? globalThis : window));

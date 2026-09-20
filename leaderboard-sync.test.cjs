const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const RankingMomentum = require('./ranking-momentum.js');

test('site paginates its initial history and requests only the newest overlap thereafter', async () => {
  const source = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const start = source.indexOf('async function fetchLeaderboardRefresh(');
  const end = source.indexOf('async function fetchRecentLeaderboardHistory(', start);
  const now = Math.floor(Date.now() / 1000);
  const state = { leaderboards: { historyLimit: 0, historyFetchedAt: null, historyComplete: false, history: [] } };
  const urls = [];
  const context = vm.createContext({ URLSearchParams, Date, Math, Number, String,
    API: 'https://example.test', state, RankingMomentum, LEADERBOARD_HISTORY_LIMIT: 336,
    LEADERBOARD_HISTORY_RETENTION_SECONDS: 150 * 86400,
    normalizeLeaderboardHistory: rows => [...new Map(rows.map(r => [r.capturedAt, r])).values()].sort((a, b) => a.capturedAt - b.capturedAt),
    fetchJSON: async url => {
      const parsed = new URL(url); urls.push(parsed);
      if (parsed.pathname.endsWith('/history')) return { rows: [{ capturedAt: now - 240 }], nextBefore: null };
      return { capturedAt: now, history: { rows: [{ capturedAt: now }], nextBefore: parsed.searchParams.has('since') ? null : now } };
    },
  });
  vm.runInContext(source.slice(start, end), context);
  const initial = await context.fetchLeaderboardRefresh(20, false);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('history'), 'boards');
  assert.equal(urls[0].searchParams.get('top'), '20');
  assert.equal(urls[1].searchParams.get('to'), String(now + 1));
  assert.equal(initial.rows.length, 2);
  Object.assign(state.leaderboards, { history: initial.rows, historyLimit: 20, historyFetchedAt: now });
  const updated = await context.fetchLeaderboardRefresh(10, false);
  assert.equal(urls.length, 3);
  assert.equal(urls[2].searchParams.get('since'), String(now));
  assert.equal(urls[2].searchParams.get('top'), '20');
  assert.equal(updated.rows.length, 2);
  await context.fetchLeaderboardRefresh(100, false);
  assert.equal(urls[3].searchParams.has('since'), false);
});

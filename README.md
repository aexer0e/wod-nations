# War of Dots — Nations Campaign Map

Static website for the **War of Dots Nations** event: a live territory map of the Red Empire vs. the Blue Republic, with timeline replay, objective planning, the in-game war report, and live top-100 ELO/world leaderboards with a 10-player-step slider.

Data comes from the [wod-nations-map worker](https://wod-nations-map.moreofdots.workers.dev) (`/health`, `/v1/timeline`, `/v1/snapshots/...`, `/v1/leaderboard`). The site is plain HTML/CSS/JS with no build step.

The site starts behind an access-code screen. The code is verified only by the Worker and is never included in these static files. After login, the returned 30-day bearer session is kept in `localStorage`, attached to every map API request, and shared across tabs and browser restarts. The **Lock map** button removes and revokes it. The Worker must be migrated and have `ACCESS_CODE` and `ACCESS_SESSION_SECRET` configured before deploying this frontend.

## Structure

- `index.html`, `styles.css`, `app.js` — the app shell, presentation, and interactions
- `ranking-momentum.js` — tested player comparison scaling and rolling land/ranking correlation helpers
- `objective-simulator.js` — simultaneous objective-directed 48-hour simulation model
- `assets/world_map.png` — terrain image (1920×1080)
- `assets/playable-mask.bitset.zlib` + `assets/playable-mask.meta.json` — static playable-area bitset used to decode `playable-bitset-zlib-v1` snapshots
- `assets/city-points.json` — 295 static city coordinates in the game's 9600×5400 world space; flag ownership is sampled from the selected snapshot
- `assets/player-colors.json` — case-insensitive faction overrides for leaderboard players whose upstream color is missing or incorrect
- `.nojekyll` — tells GitHub Pages to serve files as-is

Both snapshot encodings are supported: `playable-bitset-zlib-v1` (compact) and the legacy `raw-u8-zlib-v1`. Decoded overlays are cached in memory by `mapHash`.

The full retained timeline and its precomputed land/city graph totals are cached in IndexedDB. On later visits the frontend requests only the newest overlap, while ownership map blobs are downloaded only for snapshots that are actually displayed.

Press **Enable simulation** to replace historical playback with a 97-frame forecast. Frame 0 is the latest real snapshot; frames 1–96 simulate the next 48 hours in 30-minute steps and render through the same territory, city, totals, and battlefront pipeline as captured snapshots. Expansion is calculated at exact pixel resolution as a true radius from each placed objective: eligible enemy pixels are taken in distance order, even across water, while pixels on islands without a starting foothold remain protected. The Objective perimeters toggle renders the same styled rings in simulation mode, using that exact forecast radius. A compact city-control line and the current-frame readout show city gains and losses across the forecast. Moving either objective or changing the logarithmic gain slider pauses playback, waits briefly for input to settle, rebuilds all simulated frames in a worker, and re-enables playback when the forecast is ready. At the centered setting both factions apply 200 pixels of pressure: equal attacks cancel when they converge on the same front, while separated objectives can advance simultaneously.

## Run locally

Any static file server works (the map decode uses `fetch`, so opening `index.html` from disk will not):

```powershell
npx serve .
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo: **Settings → Pages → Source: Deploy from a branch**, pick the branch and `/ (root)`.
3. Done — the site works from any path (all asset URLs are relative).

Rankings refresh every two minutes through the combined public leaderboard endpoint. The website merges only new history captures after loading the selected range, and requests larger player lists only when needed. Map and health checks keep their independent five-minute interval. Public ranking requests omit the map session token.

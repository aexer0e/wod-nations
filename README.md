# War of Dots — Nations Campaign Map

Static website for the **War of Dots Nations** event: a live territory map of the Red Empire vs. the Blue Republic, with timeline replay, objectives, the in-game war report, and live top-20 ELO/world leaderboards.

Data comes from the [wod-nations-map worker](https://wod-nations-map.moreofdots.workers.dev) (`/health`, `/v1/timeline`, `/v1/snapshots/...`, `/v1/leaderboard`). The site is plain HTML/CSS/JS with no build step.

The site starts behind an access-code screen. The code is verified only by the Worker and is never included in these static files. After login, the returned 30-day bearer session is kept in `localStorage`, attached to every map API request, and shared across tabs and browser restarts. The **Lock map** button removes and revokes it. The Worker must be migrated and have `ACCESS_CODE` and `ACCESS_SESSION_SECRET` configured before deploying this frontend.

## Structure

- `index.html`, `styles.css`, `app.js` — the whole app
- `assets/world_map.png` — terrain image (1920×1080)
- `assets/playable-mask.bitset.zlib` + `assets/playable-mask.meta.json` — static playable-area bitset used to decode `playable-bitset-zlib-v1` snapshots
- `assets/city-points.json` — 295 static city coordinates in the game's 9600×5400 world space; flag ownership is sampled from the selected snapshot
- `assets/player-colors.json` — case-insensitive faction overrides for leaderboard players whose upstream color is missing or incorrect
- `.nojekyll` — tells GitHub Pages to serve files as-is

Both snapshot encodings are supported: `playable-bitset-zlib-v1` (compact) and the legacy `raw-u8-zlib-v1`. Decoded overlays are cached in memory by `mapHash`.

## Run locally

Any static file server works (the map decode uses `fetch`, so opening `index.html` from disk will not):

```powershell
npx serve .
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo: **Settings → Pages → Source: Deploy from a branch**, pick the branch and `/ (root)`.
3. Done — the site works from any path (all asset URLs are relative).

# War of Dots — Nations Campaign Map

Static website for the **War of Dots Nations** event: a live territory map of the Red Empire vs. the Blue Republic, with timeline replay, objectives, and the in-game war report.

Data comes from the [wod-nations-map worker](https://wod-nations-map.moreofdots.workers.dev) (`/health`, `/v1/timeline`, `/v1/snapshots/...`). The site is plain HTML/CSS/JS with no build step.

## Structure

- `index.html`, `styles.css`, `app.js` — the whole app
- `assets/world_map.png` — terrain image (1920×1080)
- `assets/playable-mask.bitset.zlib` + `assets/playable-mask.meta.json` — static playable-area bitset used to decode `playable-bitset-zlib-v1` snapshots
- `assets/city-points.json` — 295 static city coordinates in the game's 9600×5400 world space; flag ownership is sampled from the selected snapshot
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

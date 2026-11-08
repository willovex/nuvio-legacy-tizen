# Nuvio Lite for Legacy Tizen TVs

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/Willovex)

A lightweight streaming client + companion bridge server that brings the
**[Nuvio](https://github.com/NuvioMedia)** account experience (login, installed
add-ons, watch history / *Continue Watching*, cross-device resume) to **old
Samsung Smart TVs running Tizen 2.3** (2015-era J-series) — hardware that the
official Nuvio TV app cannot realistically run on.

> **Unofficial / community project.** Not affiliated with, endorsed by, or
> supported by the Nuvio team. It talks to the public Nuvio account backend and
> re-uses the Nuvio add-on ecosystem the same way the official clients do. All
> credit for the platform, backend and add-on protocol goes to the
> **[NuvioMedia](https://github.com/NuvioMedia)** project. This repo is provided
> for educational purposes; use it with your own account and add-ons.

---

## Why this exists

The official Nuvio TV app is a modern web app transpiled for Chromium-based TVs
(Tizen 3.0+ / webOS). A 2015 Samsung (e.g. **UE55J6350**, Tizen **2.3.0**,
`AppleWebKit/538.1`) uses the pre-Chromium WebKit2 engine and a weak SoC, so the
official build either fails to boot or is unusably slow (minutes per screen).

The trick used here: **move all the heavy lifting off the TV**. A small Node.js
**bridge** on your LAN (NAS / Unraid / any always-on box) does everything the old
TV can't — modern TLS, the Stremio add-on protocol, stream validation, account
sync — and exposes a dead-simple HTTP API. The TV runs a tiny, dependency-free
**ES5** app that just renders what the bridge gives it, so it stays fast and
responsive.

## Architecture

```
┌──────────────────────────┐        plain HTTP (LAN)        ┌───────────────────────────┐
│   Samsung TV (Tizen 2.3)  │  ───────────────────────────▶ │   Nuvio Bridge (Node.js)  │
│   "Nuvio Lite" .wgt app   │                                │   on your NAS / server    │
│   • ES5, no framework     │  ◀───────────────────────────  │                           │
│   • webapis.avplay player │        JSON / video proxy      │   • Modern TLS to the     │
│   • remote-friendly UI    │                                │     internet (TV can't)   │
└──────────────────────────┘                                │   • Nuvio account (login, │
                                                             │     history, add-ons)     │
                                                             │   • Stremio add-on proto  │
                                                             │   • Stream validation     │
                                                             │   • Video/subtitle proxy  │
                                                             └────────────┬──────────────┘
                                                                          │ HTTPS
                                        ┌─────────────────────────────────┼───────────────────────┐
                                        ▼                                  ▼                       ▼
                                 Nuvio backend                     Your Stremio add-ons        TMDB
                                 (api.nuvio.tv)                    (AIOStreams, Cinemeta…)   (catalogs)
```

## Features

- **Nuvio account login** via the same TV QR flow as the official app.
- **Your installed add-ons** are used as the real stream sources (e.g. AIOStreams),
  shown **1:1** in the add-on's own order with full descriptions (language, size).
- **Continue Watching** read from your account and **resume from the exact
  position**; progress is written back in Nuvio's schema so it **syncs to your
  phone and other devices**.
- **Audio & subtitle track switching** in the player, including **online
  subtitles** pulled from your OpenSubtitles add-on.
- **Account shelves and collections** with saved order, custom titles, and hidden-row preferences. Collection folders open as an eight-column poster grid with remote navigation. TMDB catalogs remain the fallback when no account rows exist.
- **Artwork and rating preservation**, with visible-row rendering and smaller cached posters for older TV engines.
- **Metadata caching** with coalesced lookups and optional account-synced TMDB credentials; environment configuration remains supported.
- **Full-screen playback** with auto-hiding controls, resume, and progress sync.
- Works around the old engine's limits: **all HTTPS is proxied** through the
  bridge (the 2015 TLS stack can't reach many modern hosts), streams are
  **validated** (dead/landing-page links filtered out) and **ranked** for what a
  1080p H.264-class decoder can actually play.

## Repository layout

```
bridge/         Node.js bridge server (the brains)
  server.js
  package.json
  .env.example
tizen-app/      The TV app packaged into a .wgt
  config.xml
  index.html
  icon.png
  css/style.css
  js/app.js
  js/config.js  ← set your bridge URL here
docs/
```

---

## Setup

### 1. Bridge server (runs on your LAN, always-on)

Requirements: Node.js 18+ (native `fetch`), or Docker.

Configure it (see `bridge/.env.example`):

| Variable          | What it is                                                        |
|-------------------|-------------------------------------------------------------------|
| `PORT`            | Port to listen on (default `7070`).                               |
| `NUVIO_API`       | Nuvio account backend. Default `https://api.nuvio.tv`.            |
| `NUVIO_ANON_KEY`  | Nuvio Supabase **anon** (public) key — required for account sync. |
| `TMDB_KEY`        | TMDB v3 API key for catalogs/metadata.                            |
| `TMDB_LANG`       | UI language for TMDB (e.g. `pl-PL`, `en-US`).                     |

> `NUVIO_ANON_KEY` is the public client key that ships inside the official Nuvio
> TV build (`nuvio.env.js` → `SUPABASE_ANON_KEY`). Read it from there.

**Run with Docker (recommended):**

```bash
docker run -d --name nuvio-bridge --restart unless-stopped \
  -p 7070:7070 \
  -e NUVIO_ANON_KEY=... -e TMDB_KEY=... -e TMDB_LANG=pl-PL \
  -v /path/to/bridge:/app -w /app \
  node:20-alpine sh -c "npm install --no-audit --no-fund && node server.js"
```

**Or run directly:**

```bash
cd bridge
cp .env.example .env   # fill in the values
npm install
env $(grep -v '^#' .env | xargs) node server.js
```

Verify: `curl http://<server-ip>:7070/api/health` → `{"ok":true,...}`.

### 2. TV app (`.wgt`)

Requirements: [Tizen Studio](https://developer.tizen.org/) CLI + a Samsung
author/distributor certificate profile, and **Developer Mode** enabled on the TV
(Apps → `12345` → Developer mode → set your PC's IP).

1. Point the app at your bridge: edit `tizen-app/js/config.js`
   ```js
   window.BRIDGE_URL = 'http://<your-server-ip>:7070';
   ```
2. Package & sign:
   ```bash
   cd tizen-app
   tizen package -t wgt -s <your-cert-profile> -- .
   ```
3. Install over the network:
   ```bash
   sdb connect <tv-ip>
   tizen install -n "Nuvio Lite.wgt" -- . -t <device-name>
   ```
4. Launch it from the TV's Apps menu (or
   `sdb -s <tv-ip>:26101 shell 0 was_execute Nuvio00001.NuvioTV`).

On first run the TV shows a QR code — scan it, log into your Nuvio account, and
your profile, add-ons and history sync over.

---

## Tests and validation

Run `npm test` from `bridge/`. Tests use Node's built-in test runner and controlled inputs; they do not need account keys, a TV, or network access.

The browsing changes were installed and exercised on a 2017 Samsung running Tizen 3.0. The TV code remains ES5 and uses inline-block layout rather than modern CSS Grid. Physical testing on Tizen 2.3 is still needed. See [performance and compatibility notes](docs/PERFORMANCE.md).

Account-synced TMDB credentials are read by the bridge through `sync_pull_provider_credentials`; key values stay on the bridge. If no account credential is available, `TMDB_KEY` is used. Other integrations from full Nuvio, including direct MDBList ratings and AnimeSkip controls, are not implemented by this client. Debrid credentials configured inside add-ons continue to be handled by those add-ons.

## How it works (the interesting bits)

These are the concrete problems a 2015 Tizen 2.3 / WebKit2 TV throws at you, and
how the bridge + app solve them:

- **No modern TLS.** The TV can reach some hosts (TMDB) but not others
  (`api.nuvio.tv`, add-on CDNs, subtitle/image hosts) because of newer cert
  chains / TLS 1.3. **Everything** goes through the bridge over plain LAN HTTP;
  the bridge does the HTTPS on the TV's behalf.
- **Account without a heavy client.** The bridge performs the TV login flow
  (`signup` → `start_tv_login_session` → `poll` → `tv-logins-exchange`), stores
  the session, refreshes tokens, and exposes `/me/*` endpoints. Profiles are keyed
  by **integer `profile_index`**, and watch progress uses the exact
  `content_id` (imdb) / `video_id` / `progress_key` schema so it round-trips with
  other devices.
- **Real add-ons, not a reimplementation.** Your installed sources live in the
  account's `addons` table. The bridge fetches each add-on manifest and speaks
  the **Stremio protocol** (`/stream/{type}/{id}.json`) to get real streams,
  preserving the add-on's own ordering and rich descriptions.
- **Stream validation.** Many scraper links resolve to login/landing HTML rather
  than video. The bridge probes candidates (Range request, checks
  `Content-Type`) and only offers real, playable streams, ranked toward formats
  the old decoder handles.
- **Playback quirks.** `avplay.seekTo()` is ignored *before* playback starts on
  Tizen 2.3, so resume is triggered *after* play begins (via buffering/time
  events). Video is proxied (with `Range` + redirect following) so seeking works.
  External subtitles are downloaded, written to `wgt-private` and rendered via
  `onsubtitlechange`. Emoji in descriptions (no emoji font on the old engine) are
  converted — flags to `[PL]`/`[EN]` codes, the rest stripped.
- **Overscan.** Old panels crop the edges; the UI is scaled to a title-safe area
  and centred so nothing runs off-screen.

## Limitations

- This is 2015 hardware: browsing is snappy, but expect **1080p H.264-class**
  playback. 4K / HEVC generally won't decode — pick 1080p/720p sources.
- No built-in torrent/P2P (the official app's local EngineFS service can't run on
  Tizen 2.3). Direct add-on links (e.g. debrid via AIOStreams) work fine.
- The bridge is **required at all times** — it's the account/TLS gateway. Keep it
  running (Docker `--restart unless-stopped`).

## Credits & attribution

- **[Nuvio / NuvioMedia](https://github.com/NuvioMedia)** — the streaming
  platform, account backend and add-on ecosystem this project builds on. Please
  support the upstream project.
- **[TMDB](https://www.themoviedb.org/)** — catalog & metadata (this product uses
  the TMDB API but is not endorsed or certified by TMDB).
- The Stremio add-on protocol, and the community add-ons you configure in Nuvio.

## License

MIT — see [LICENSE](LICENSE).

## Wsparcie

Jeśli ten projekt okazał się przydatny i chcesz postawić mi kawę — zapraszam:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/Willovex)

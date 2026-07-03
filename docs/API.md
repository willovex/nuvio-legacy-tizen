# Bridge HTTP API

All endpoints are plain HTTP on the LAN (default port `7070`). The TV app is the
only intended client. CORS is open.

## Account (`/me/*`)

| Endpoint                 | Method | Description                                             |
|--------------------------|--------|---------------------------------------------------------|
| `/me/status`             | GET    | `{ loggedIn, profile }`.                                |
| `/me/login/start`        | GET    | Begins the TV QR login. Returns `{ code, url }`.        |
| `/me/login/poll`         | GET    | Poll until approved; auto-exchanges tokens. `{status}`. |
| `/me/logout`             | GET    | Clears the stored session.                              |
| `/me/continue`           | GET    | *Continue Watching*, enriched with TMDB posters/titles. |
| `/me/progress`           | POST   | Save watch position (Nuvio schema, cross-device).       |
| `/me/plugins`            | GET    | The account's installed add-ons.                        |

`POST /me/progress` body:

```json
{ "tmdbId": "1396", "contentId": "tt...", "type": "series",
  "season": 1, "episode": 1, "positionMs": 600000, "durationMs": 2700000 }
```

## Catalog / metadata (`/api/*`)

| Endpoint                                         | Description                          |
|--------------------------------------------------|--------------------------------------|
| `/api/health`                                    | Liveness + loaded fallback providers.|
| `/api/catalog/:category`                         | TMDB rows (e.g. `trending-movie`).   |
| `/api/search?q=`                                 | TMDB multi search.                   |
| `/api/meta/:type/:id`                            | Title details (+ seasons for series).|
| `/api/episodes/:id/:season`                      | Episode list.                        |
| `/api/streams/:type/:id?season=&episode=`        | Aggregated, validated, playable streams (your add-ons first, then fallback scrapers). |
| `/api/subtitles/:type/:id?season=&episode=`      | Subtitles from your subtitle add-ons.|

## Proxies

| Endpoint                 | Description                                                        |
|--------------------------|-------------------------------------------------------------------|
| `/sb/*`                  | Reverse proxy to the Nuvio account backend (modern TLS).           |
| `/px?u=<https-url>`      | Generic HTTPS proxy for anything the TV can't reach directly.      |
| `/img?u=<https-url>`     | Image proxy (posters, QR, subtitle files).                        |
| `/api/proxy?u=&h=`       | Video stream proxy — follows redirects server-side, supports `Range`, injects add-on headers. |

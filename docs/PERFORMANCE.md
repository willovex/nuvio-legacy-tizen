# Legacy browsing performance and compatibility

Home reads enabled add-on catalogs and collections from the active account profile. Collection folders use an eight-column grid; Home shelves remain horizontal. Back retains existing Home cards, loaded artwork, and focus. The initial view renders the two complete shelves and partly visible third shelf rather than every cached catalog. The grid loads poster rows around focus.

Poster requests through the bridge use 342-pixel TMDB artwork, a 32 MiB / 256-entry / one-hour memory cache, duplicate-request coalescing, and six concurrent upstream downloads. Successful image responses receive private one-hour browser caching. QR and subtitle requests do not use the poster cache. The cache is intentionally memory-only; it does not persist account data or remote configuration URLs to disk.

TMDB JSON responses are cached for ten minutes, with at most 256 completed entries and six concurrent lookups. Concurrent requests share their pending result; failures are retryable. Account TMDB credentials are read at most once per five minutes per account/profile scope. V3 keys and V4 bearer credentials are supported. Secret headers are removed before cross-origin redirects. Account RPC responses and authentication exchanges do not use the metadata cache.

Continue Watching chooses the requested media type when an IMDb ID has both movie and show matches. This avoids combining a movie ID with the TV endpoint. A configured metadata add-on can provide missing title/artwork for provider-specific identifiers. That fallback does not establish native-provider playback compatibility.

## Measurements

An eager-rendering account-shelf fixture with twenty preloaded 100-item catalogs plus Continue Watching produced 2,020 cards, 6,124 DOM nodes and 147 initial poster assignments before visible-row rendering. After the change it produced 220 cards, 724 nodes and 33 assignments, covering the partially visible third shelf too. Host Node VM mount timing was approximately 4 ms versus 1.3 ms; this is not a measurement of TV frame rate.

The DOM comparison is a controlled account-shelf fixture, not a benchmark of the unmodified upstream six-row Home.

For the same ten live TMDB posters supplied by account add-on catalogs, response bodies fell from 1,335,177 bytes to 441,705 bytes (66.9% less transfer). Repeat bridge requests had median latency 49 ms before caching and 1 ms after. Network conditions and upstream caches affect these numbers. In a twenty-item Continue Watching check, initial metadata load took about 2.50 seconds and a cached repeat 0.58 seconds; all title/poster fields resolved after typed lookup and add-on fallback.

## Validation and limits

`cd bridge && npm test` exercises folder navigation, focus restoration, short final grid rows, visible artwork boundaries, ratings, account shelf ordering/visibility, partial source failures, cache eviction/coalescing/concurrency, account credential scope and ambiguous IMDb matches. The server and TV scripts also pass syntax checks. A private signed build was installed and launched on a 2017 Tizen 3.0 Samsung; full physical regression testing on Tizen 2.3 remains necessary.

Each folder currently merges up to 100 titles from its sources. This change adds a grid, not unlimited catalog pagination. Existing player and stream-proxy behavior is retained. Direct MDBList/AnimeSkip integration is not provided. The configured add-ons may use their own debrid keys independently of this bridge.

## Audit follow-ups

- The stream endpoint still waits for fallback scrapers and fallback probing even when account add-ons return links. A follow-up should offer backup-source lookup explicitly so account links can appear sooner while retaining access to backups.
- Provider-specific resume playback needs separate verification; artwork availability alone does not prove that an ID maps to a playable stream.
- The bridge is intended for a trusted LAN. Its pre-existing diagnostic/account endpoints and generic proxy are not an internet-facing authenticated API; this patch does not redesign that trust boundary.

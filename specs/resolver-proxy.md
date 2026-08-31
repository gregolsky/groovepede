# Groovepede Resolver — Spec

**Status:** shipped  
**Owner:** `backend/`

> This spec originally described an AWS Lambda + CloudFront + WAF + DynamoDB
> deployment that proxied Odesli. That stack was removed in `1c07ecc`; the
> resolver moved to a self-hosted Raspberry Pi. Odesli's public API was then
> deprecated outright (`401 PUBLIC_API_ACCESS_DEPRECATED`, 2026-08), so the
> resolver was rewritten again: instead of proxying a third party, it fetches
> the pasted album page itself and extracts the metadata directly. The
> problem this doc describes, the endpoint, and the security model are all
> current as of that rewrite — for how the Pi deployment is built, run and
> deployed, see `backend/README.md`.

---

## Problem

Two, layered:

1. **CORS.** The browser can't fetch another service's album page directly —
   `open.spotify.com`, `music.apple.com`, etc. send no
   `Access-Control-Allow-Origin` for `groovepede.gregolsky.pl`. Whatever reads
   the page has to run server-side.
2. **No third party does this for us anymore.** Odesli (`api.song.link`) used
   to solve exactly this — resolve a pasted link to metadata plus equivalent
   links on every other service — for free, keyless, from any origin (via our
   own CORS-adding proxy). Its public API is now `401`-deprecated. There is no
   drop-in replacement: every alternative either wants a paid key, doesn't
   cover the services we need, or (Spotify's own oEmbed) gives a title but no
   artist.

---

## Solution

The resolver fetches the pasted album page itself, runs a small per-service
extraction routine, then looks up the same album on Deezer and Apple/iTunes
(free keyless search APIs) plus Spotify (Client Credentials app-auth — optional,
degrades to a no-op when unconfigured) to rebuild cross-service links. Amazon
Music and SoundCloud were dropped from the registry entirely: both album pages
are pure client-rendered JS shells with no server-rendered metadata at all
(verified live — no `og:` tags, no JSON-LD, and SoundCloud's oEmbed endpoint
404s outright), so there is nothing here to extract from either.

```
Browser (Origin: https://groovepede.gregolsky.pl)
  │  GET /v1/album?url=…
  │  Header: x-gp-token: <signed token>
  ▼
nginx on the Pi  (api.groovepede.gregolsky.pl)
  │  TLS (Let's Encrypt) · per-IP rate limit · fail2ban
  ▼
resolver (node:http)
  ├─ token verify · origin allowlist · host allowlist (→ service slug)
  ├─ SQLite cache lookup (TTL 60 days)
  │   hit  → return cached record
  │   miss ↓
  ├─ EXTRACT: fetch the album's own page/API for that service
  │   spotify → embed page's __NEXT_DATA__ · apple → itunes.apple.com/lookup
  │   deezer  → api.deezer.com/album/{id} · tidal/pandora → og: tags
  │   youtube → youtube.com/oembed
  │   fetch failure, transient (network/429/5xx) → retryable {_error}
  │   fetch failure, permanent (upstream 404/403/400/…) → 422 {_error:'not-found'}
  │     (remapped to our OWN 422, never the raw upstream status — passing a
  │     bare 404 through would trip fail2ban's any-404 jail on real users)
  │   fetch OK but no album found → 422 {_error:'extraction-failed'}, NOT retryable
  ├─ CROSS-LINK: with {artist, title} in hand, query Deezer + Apple search,
  │   plus Spotify search via a cached Client Credentials app token (skip
  │   whichever is the source service) — best-effort, never fails the add.
  │   Any job that actually threw (not just "no match") caches the record for
  │   1h instead of 60 days, so a retry isn't frozen out.
  └─ write to SQLite · return the normalized record
```

---

## Handler contract

**Endpoints:** `GET https://api.groovepede.gregolsky.pl/v1/album` (album
metadata + cross-links) and `/v1/artist` (artist image URL, unchanged by this
rewrite); `/healthz` returns `{ ok, commit }`.

**Query params:** `/v1/album` takes `url` (required) — the pasted album page.
`/v1/artist` takes `name` (required) and an optional Deezer `albumId`.

**Required header:** `x-gp-token: <ts>.<base64url-sig>` (ECDSA-P256; 5-minute
window; bound to the URL, or to `artist:<name>|<albumId>` — signing is
unchanged from the retired `/v1/resolve`, so `sign.js` needed no client edit).

**Response shape**, `/v1/album` success:

```json
{
  "id": "spotify:4aawyAB9vmqN3uQ7FjRGTy",
  "service": "spotify",
  "title": "Global Warming",
  "artist": "Pitbull",
  "cover": "https://i.scdn.co/image/…",
  "year": "2012",
  "tags": ["Dance"],
  "links": {
    "spotify": { "url": "…", "nativeUri": "spotify:album:…" },
    "deezer":  { "url": "…" },
    "apple":   { "url": "…" }
  }
}
```

`links` holds **exact matches only** — never a search URL; those are built
client-side on demand (`buildSearchUrl()` in `services.js`), not stored or
returned by the resolver. Failure: `{ "_error": <status> }` for anything
retryable (network, 429, 5xx passthrough from the upstream fetch);
`{ "_error": "not-found" }` (HTTP 422) when the upstream itself returned a
permanent failure (404/403/400/…) — remapped to our own 422 rather than
passed through, so it can never trip fail2ban's any-404 ban jail;
`{ "_error": "extraction-failed" }` (HTTP 422) when the fetch itself succeeded
but no album could be found in the response — neither is retryable.

`/v1/artist` is unchanged: `{ image: string|null, genres: string[] }` — image
is a URL only, never image bytes; `genres` rides along for free on the same
Deezer `/album/{albumId}` lookup used for the image, when `albumId` was
supplied and matched (otherwise `[]`). Cache entries written before this field
existed (30-day TTL) return without a `genres` key at all — callers must treat
it as optional, not assume presence.

**CORS:** explicit origin allowlist —
`https://groovepede.gregolsky.pl` plus `http://localhost:5173` for dev,
extendable via `ALLOWED_ORIGINS`. Never `*`.

### Cache keys

```
album:v1:{normalizedUrl}                 TTL 60 days
artist:{normalizedArtistName}             TTL 30 days (negatives cached too)
```

`album:v1:` is a new prefix — the old `links:{cc}:{url}` entries from the
Odesli-proxy era are simply never read again, no migration needed.
`normalizedUrl` strips `si=` and `utm_*` while preserving service-specific
params (Apple Music album ids are path segments, so they're unaffected).

### Input allowlist (SSRF hygiene)

The handler rejects any `url` whose host is not one of, mapped straight to the
service it identifies (and therefore which extractor runs):

| Service | Hosts |
|---|---|
| Spotify | `open.spotify.com` |
| Apple Music | `music.apple.com` |
| Deezer | `deezer.com`, `www.deezer.com` |
| Tidal | `tidal.com`, `listen.tidal.com` |
| YouTube / YT Music | `music.youtube.com`, `youtube.com`, `www.youtube.com` |
| Pandora | `pandora.com`, `www.pandora.com` |

Amazon Music and SoundCloud are **not** in this list — see Solution above.

`albumId` on `/v1/artist` is validated as digits-only before it reaches a URL
path. Outbound cross-linking calls (`api.deezer.com`, `itunes.apple.com`) are
separate, fixed URLs the resolver constructs itself — never built from the
pasted URL, so they need no allowlist of their own.

---

## Security model

| Control | Layer |
|---|---|
| `x-gp-token` signature + 5-min replay window | resolver |
| Origin allowlist (CORS) | resolver |
| Host allowlist (SSRF) | resolver |
| Per-upstream-fetch timeout (8s) + response size cap (512KB) | resolver |
| Per-IP rate limit (`limit_req`) | nginx |
| Ban on repeated 404s / blocked UAs | fail2ban |

**Token caveat:** `VITE_GP_PRIVATE_KEY` ships in the public PWA bundle, so a
determined attacker can mint valid tokens. It is a stronger deterrent than a
static shared secret, not airtight auth — tokens sniffed from the wire expire in
5 minutes and are bound to one URL. The hard limits are nginx's rate limit and
fail2ban.

**What CORS does and doesn't do here:** it is browser-enforced. It stops another
*website* from reading a response in the user's browser; it does not stop a
direct `curl` carrying a valid token. See `backend/README.md` § Security posture.

**New surface from this rewrite:** the resolver now fetches consumer-facing
HTML pages (not just small JSON APIs) from a residential Pi IP. The fetch
timeout/size cap above bound the worst case; there is deliberately no
server-side outbound *pacing* beyond that — the 60-day cache means each album
is fetched at most once, ever, so volume stays low without it.

---

## Client integration

- `frontend/src/js/config.js` — `RESOLVER_BASE` points at the resolver;
  `GP_PRIVATE_KEY` comes from `VITE_GP_PRIVATE_KEY` (`.env.local` for dev, a
  GitHub Actions secret for CI). Generate the pair with `cd backend && make keygen`.
- `frontend/src/js/sign.js` — `signRequestToken(payload)` returns
  `"<ts>.<base64url(ECDSA-SHA256 over '${ts}\n${payload}')>"`. Unchanged by
  this rewrite.
- `frontend/src/js/api.js` — `resolveAlbum` calls `/v1/album` and adopts the
  response near-verbatim (no more `linksByPlatform` reshaping — the resolver
  already returns the client's shape). `resolveAlbumResilient` wraps it with a
  MusicBrainz fallback and is now used on every interactive resolve (paste,
  share, refresh), not only the pending-retry loop — extraction is more
  fragile than a dedicated API was, so a markup change degrades to MusicBrainz
  instead of a bare error. `fetchDeezerArtistData` calls `/v1/artist`.

---

## Infrastructure layout

```
backend/
├── resolver-core.mjs    — transport-agnostic core: token verify, CORS, host allowlist,
│                          per-service extraction, cross-linking, artist lookup
├── server.mjs           — node:http + node:sqlite adapter around the core
├── Dockerfile           — arm64 image (Node 22, --experimental-sqlite)
├── docker-compose.yml   — resolver + nginx + certbot + fail2ban
├── deploy.sh            — push-deploy from a dev machine over SSH
├── deploy-local.sh      — the on-Pi half (cert backup, guard, build, health check)
├── ansible/             — pull-deploy triggered via ntfy.sh
├── nginx/, fail2ban/    — TLS termination, rate limiting, ban rules
└── Makefile             — keygen
```

---

## Tests

**Backend unit** — `backend/resolver-core.test.mjs`, run with
`node --test backend/resolver-core.test.mjs` (and in CI):

- Cache miss → extracts, cross-links, caches the record, returns it
- Cache hit → no upstream fetch at all
- Unknown host → 400 before any outbound call
- Upstream fetch failure (non-2xx / network) → retryable passthrough
- Fetch OK but no album found → 422, non-retryable
- Cross-linking is skipped for the source service, and its failure is non-fatal
- One extraction test per service (Spotify, Apple, Deezer, Tidal, YouTube, Pandora)
- Artist lookup: exact album-id hit, strict name match, mismatch rejection,
  blank-placeholder handling — unchanged by this rewrite

**App** — `frontend/src/js/api.test.js` stubs the resolver URL;
`frontend/tests/*.spec.js` stub it through `tests/helpers.js`
(`makeAlbumResponse`, `stubExternals({ resolver })`).

**Post-deploy smoke** — `cd frontend && npm run test:smoke` opens the deployed
site and exercises a real resolve per service, asserting the rendered card
actually has a title and artist (not just a 200) — the canary for "a service
changed its markup." YouTube and Pandora are not yet in that list: neither
extractor's live behavior was confirmed during development (YouTube: no
specific album-playlist URL verified; Pandora: US-geofenced, every probe from
outside the US came back geo-blocked — possibly including the Pi itself,
depending on where it's hosted). See the comment in
`frontend/tests-smoke/smoke.spec.js`.

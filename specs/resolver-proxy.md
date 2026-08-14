# Groovepede Resolver Proxy — Spec

**Status:** shipped  
**Owner:** `backend/`

> This spec originally described an AWS Lambda + CloudFront + WAF + DynamoDB
> deployment. That stack was removed in `1c07ecc`; the resolver is now
> self-hosted on a Raspberry Pi. The problem, the handler contract and the
> security model below are unchanged and still current — for how the Pi
> deployment is built, run and deployed, see `backend/README.md`.

---

## Problem

Odesli (`api.song.link`) returns `Access-Control-Allow-Origin` only for its own
frontends (`odesli.co`, `song.link`). A browser fetch from
`groovepede.gregolsky.pl` gets a `200` back but **no ACAO header**, so the
browser blocks the response. The app catches the TypeError as
`{ _error: 'network' }`, which is retryable — so pending stubs retry forever and
never resolve.

This affects every album added via any service, because all resolution goes
through Odesli.

An Odesli API key does **not** fix the problem — CORS is origin-based, not
key-based.

---

## Solution

A server-side proxy calls Odesli without an `Origin` header, with a named
`User-Agent`, and re-emits the JSON with the correct ACAO header. Odesli's
response shape is preserved verbatim, so the client data model is unchanged.

```
Browser (Origin: https://groovepede.gregolsky.pl)
  │  GET /v1/resolve?url=…&userCountry=US
  │  Header: x-gp-token: <signed token>
  ▼
nginx on the Pi  (api.groovepede.gregolsky.pl)
  │  TLS (Let's Encrypt) · per-IP rate limit · fail2ban
  ▼
resolver (node:http)
  ├─ token verify · origin allowlist · host allowlist
  ├─ SQLite cache lookup (TTL 60 days)
  │   hit  → return cached body
  │   miss ↓
  ├─ fetch https://api.song.link/v1-alpha.1/links?…
  │   UA: Groovepede-Resolver/1.0 (+https://groovepede.gregolsky.pl)
  │   non-200 → passthrough error (app retry logic handles it)
  └─ write to SQLite · return body
```

---

## Handler contract

**Endpoints:** `GET https://api.groovepede.gregolsky.pl/v1/resolve` (album links)
and `/v1/artist` (artist image URL); `/healthz` returns `{ ok, commit }`.  
**Query params:** `/v1/resolve` mirrors Odesli — `url` (required),
`userCountry` (default `US`). `/v1/artist` takes `name` (required) and an
optional Deezer `albumId`.  
**Required header:** `x-gp-token: <ts>.<base64url-sig>` (ECDSA-P256; 5-minute
window; bound to the URL, or to `artist:<name>|<albumId>`)  
**Response shape:** verbatim Odesli JSON on success; `{ "_error": <status> }` on
failure. `/v1/artist` returns `{ image: string|null }` — a URL only, never image
bytes.  
**CORS:** explicit origin allowlist —
`https://groovepede.gregolsky.pl` plus `http://localhost:5173` for dev,
extendable via `ALLOWED_ORIGINS`. Never `*`.

### Cache keys

```
links:{userCountry}:{normalizedUrl}      TTL 60 days
artist:{normalizedArtistName}            TTL 30 days (negatives cached too)
```

`normalizedUrl` strips `si=` and `utm_*` while preserving service-specific
params (Apple Music album ids are path segments, so they're unaffected).

### Input allowlist (SSRF hygiene)

The handler rejects any `url` whose host is not one of:

| Service | Hosts |
|---|---|
| Spotify | `open.spotify.com` |
| Apple Music | `music.apple.com` |
| YouTube / YT Music | `music.youtube.com`, `youtube.com`, `www.youtube.com` |
| Deezer | `deezer.com`, `www.deezer.com` |
| Tidal | `tidal.com`, `listen.tidal.com` |
| Amazon Music | `music.amazon.com`, `music.amazon.co.uk`, `music.amazon.de` _(etc.)_ |
| Pandora | `pandora.com`, `www.pandora.com` |
| SoundCloud | `soundcloud.com`, `www.soundcloud.com` |

`albumId` on `/v1/artist` is validated as digits-only before it reaches a URL
path.

---

## Security model

| Control | Layer |
|---|---|
| `x-gp-token` signature + 5-min replay window | resolver |
| Origin allowlist (CORS) | resolver |
| Host allowlist (SSRF) | resolver |
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

---

## Client integration

- `frontend/src/js/config.js` — `ODESLI_BASE` points at the resolver;
  `GP_PRIVATE_KEY` comes from `VITE_GP_PRIVATE_KEY` (`.env.local` for dev, a
  GitHub Actions secret for CI). Generate the pair with `cd backend && make keygen`.
- `frontend/src/js/sign.js` — `signRequestToken(payload)` returns
  `"<ts>.<base64url(ECDSA-SHA256 over '${ts}\n${payload}')>"`.
- `frontend/src/js/api.js` — `resolveAlbum` and `fetchDeezerArtistImage` are the
  only callers; every add path funnels through `resolveAlbum`.

---

## Infrastructure layout

```
backend/
├── resolver-core.mjs    — transport-agnostic core: token verify, CORS, allowlist, Odesli + artist lookup
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

## Layer 2 (future — UPC-based fallback resolver)

When Odesli is unreachable, the resolver could fan out by UPC:

1. Retrieve UPC from the source service (Spotify `/v1/albums/{id}` →
   `external_ids.upc`)
2. Fan out: Deezer `GET /album/upc:{upc}`, iTunes `GET /lookup?upc={upc}`,
   Spotify `GET /search?q=upc:{upc}`
3. Emit `linksByPlatform` keyed to match `services.js` `odesliKeys`

Gaps: YouTube Music (no UPC lookup), Tidal (needs partner OAuth) — stay
Odesli-only. Not in current scope; today's fallback is MusicBrainz, client-side.

---

## Tests

**Backend unit** — `backend/resolver-core.test.mjs`, run with
`node --test backend/resolver-core.test.mjs` (and in CI):

- Cache miss → calls Odesli with app UA + optional key, caches body, returns it
- Cache hit → no Odesli call
- Unknown host → 400 before any outbound call
- Odesli non-200 → passthrough (same status, `{ _error: status }`)
- Missing `url` → 400
- Artist lookup: exact album-id hit, strict name match, mismatch rejection,
  blank-placeholder handling

**App** — `frontend/src/js/api.test.js` stubs the resolver URL;
`frontend/tests/*.spec.js` stub it through `tests/helpers.js`.

**Post-deploy smoke** — `cd frontend && npm run test:smoke` opens the deployed
site and exercises a real resolve, which is what catches signing-key drift
between `VITE_GP_PRIVATE_KEY` and the Pi's `GP_PUBLIC_KEY`.

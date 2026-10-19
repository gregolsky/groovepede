# CLAUDE.md

This file guide Claude Code (claude.ai/code) for work in this repo.

## Project Overview

Groovepede: local-first PWA, manage universal album listening queue. Paste links from Spotify, Apple Music, YouTube Music, Tidal, Deezer, more — no account, ever. Built Vite + vanilla ES modules, deploy via GitHub Pages.

No login, no user accounts anywhere in app. Spotify just one supported service: pasted links resolve and cross-link same way as any other service, via resolver's server-side Client Credentials app-auth (`backend/`) — no user OAuth, no consent screen.

## Repository layout

Two top-level workspaces:

- **`frontend/`** — PWA (Vite + vanilla ES modules). All npm commands run from here.
- **`backend/`** — self-hosted resolver stack for Raspberry Pi (Node resolver + nginx + certbot + fail2ban, Docker Compose). See
  `backend/README.md`.

## Architecture

- **`frontend/src/index.html`** — single-page app shell (Vite entry point)
- **`frontend/src/css/style.css`** — all styles, imported via JS
- **`frontend/public/sw.js`** — service worker for offline/PWA support (copied verbatim to dist)
- **`frontend/public/manifest.json`** — PWA manifest
- **`frontend/public/favicon.png`** — app icon

### Layers (`frontend/src/js/`)

Each layer imports only from layers below it. Never `ui/` from `services/`, never `infra/` from `domain/`.

| Layer | Dir | Rule |
|---|---|---|
| entry | `app.js`, `faq.js` | boot only: wire events, start share launch, first render |
| controllers + views | `ui/` | DOM lives here, nowhere else |
| use cases | `services/` | no DOM; return outcomes, take `onChange` callbacks |
| I/O | `infra/` | network, localStorage, beacon; no business rules |
| domain | `domain/` | pure album/link/backup/tag/service rules |
| helpers | `lib/` | generic, no app knowledge |

- **`app.js`** — entry: `bindEvents()`, `beginShareLaunch()`, `rerender()`, pending retry, untagged enrichment, service worker
- **`ui/state.js`** — UI store: `ui` frozen snapshot (live binding, read anywhere) + `setUi(patch)` (only writer, one rerender per change); `rerender()`, `visibleAlbums()` (every `data-index` indexes this list)
- **`ui/actions.js`** — command map `data-action` → handler; every listener (click, keys, swipe, back, file picker); keys/swipe/back reuse same commands
- **`ui/add-form.js`**, **`ui/explore.js`**, **`ui/profile.js`** — per-view controllers (explore owns slide animation; profile owns backup file I/O + import progress)
- **`ui/share-launch.js`** — share-target launch: `beginShareLaunch()` (sync, before any await) → `complete()`; `shareLanding()` = pure terminal-phase transition
- **`ui/render.js`**, **`ui/landing.js`** — pure HTML strings via escape-by-default `html` tagged template (`lib/html.js`); read nothing from storage
- **`ui/share-overlay.js`** — share overlay element (outside `#app`)
- **`services/queue.js`** — add from link (`addAlbumFromUrl` outcomes `added|exists|pending|failed`), `markListened`, `refreshAlbum`, backup export/replace
- **`services/album-details.js`** — explore data (artist info/photo, tracklist) session caches; failed fetch stays retry-eligible
- **`services/enrich.js`** — Last.fm/Deezer genre enrichment (`enrichWithLastfm`, `enrichUntagged` gated by `needsTagEnrichment`)
- **`services/pending.js`** — retry loop resolving pending stubs, per-stub backoff
- **`infra/api.js`** — network only: resolver (album extraction + cross-links + tracklists, see `backend/`), MusicBrainz, Last.fm, TheAudioDB. Never touches storage
- **`infra/storage.js`** — only localStorage module: queue (frozen cache; `updateAlbums`/`updateAlbum`/`replacePendingStub`), listened count, preferred service
- **`infra/beacon.js`** — failure beacon → resolver `/v1/log`; **`infra/sign.js`** — ECDSA-P256 `x-gp-token` signing; **`infra/signed-payloads.js`** — per-route signed strings (backend contract test imports it); **`infra/config.js`** — keys, URLs, throttle policy
- **`domain/albums.js`** — record shape/migration, `canonicalAlbumId`, `filterAlbums`, `mergeRefreshedAlbum`, `needsTagEnrichment`, `deezerAlbumId`
- **`domain/links.js`** — `parseMusicLink`, `extractAlbumId`; **`domain/backup.js`** — backup format + `sanitizeRecord` (untrusted import boundary); **`domain/tags.js`** — `canonicalTag`, `cleanTags`
- **`domain/music-services.js`** — supported-service registry; service labels, per-host album matching, search-link templates (`buildSearchUrl`), profile's "Listen on" options, every user-facing service list (`serviceListText`) derive from it. Static markup can't call it — add a service here, also update `src/faq.html` (`<details>` copy + FAQPage JSON-LD) and meta descriptions in `src/index.html`. Service goes here only if its album page (or a free keyless API) actually exposes extractable metadata — see per-service extractors in `backend/extractors.mjs`.
- **`lib/`** — `html.js` (escape-by-default templates), `throttle.js` (per-service pacing + 429 cooldown), `api-error.js` (the one transport-failure shape)

## Key Data Flow

1. User shares/pastes any album URL (Spotify, Apple Music, YouTube, Tidal, Deezer, etc.)
2. `parseMusicLink()` validates URL, identifies service
3. `resolveAlbum()` calls resolver, which fetches pasted album page itself, extracts title/artist/cover/year, cross-links Deezer + Apple Music → saved to localStorage as `links: { spotify?, apple?, youtube?, … }` (exact links only; search-link fallbacks for other services built on the fly by `domain/music-services.js`, not stored)
4. If resolver unreachable (retryable error), pending stub saved, retried on next app open via `resolvePending()`
5. `enrichWithLastfm()` fires async to fetch Last.fm tags → updates saved album, re-renders
6. Artist bio/similar artists fetched on-demand via `fetchLastfmArtist()` when user expands a card
7. Listen button opens user's preferred service (configurable in profile; falls back through available links)

## Development

All npm commands run from `frontend/`:

```
cd frontend
npm run dev        # Vite dev server at localhost:5173
npm run build      # Production build to dist/
npm run preview    # Preview production build locally
npm run test:unit  # Run Vitest unit tests
npm run test:e2e   # Run Playwright E2E tests
npm run test:mobile # Emulated-phone suite vs production build (vite preview)
npm test           # Run all tests (unit + E2E)
```

Resolver itself needs no API key from client's perspective — see `backend/README.md` to run it locally (or point `RESOLVER_BASE` at deployed one).

## Conventions

- All rendering is string-based HTML in `ui/render.js`/`ui/landing.js`; other DOM work only in `ui/` controllers (animation classes, focus, file I/O, delegated listeners). No inline handlers — behaviour markup can't carry goes in `ui/actions.js` (e.g. capture-phase landing-image load/error listeners). No CSP is set yet; keep the code CSP-ready
- Markup in `ui/render.js`/`ui/landing.js` built only with the `html` tagged template (`lib/html.js`): escapes every interpolated value unless it's an `html`/`raw()` fragment. Never plain template literal for markup, never `raw()` on data. Records come from imported backups + Last.fm → never trust any field. Imported records validated at boundary by `sanitizeRecord()` (domain/backup.js); Listen opens only `isSafeLinkUrl()` URLs (domain/music-services.js)
- UI state lives in `ui/state.js`: read `ui`, change only via `setUi(patch)` (one rerender per call); `rerender()` rebuilds full UI. Services never rerender themselves — they take an `onChange` callback (`rerender`, or `rerenderIfExploring` for explore data)
- New user action = a `data-action` in markup + one entry in `ui/actions.js`'s `COMMANDS`
- Queue changes go through `updateAlbums(fn)` / `updateAlbum(id, fn)` (infra/storage.js) — synchronous read-modify-write. Never `loadAlbums()` → `await` → `saveAlbums()`: stale snapshot undoes changes made during the await
- Album ids canonical: `canonicalAlbumId()` maps legacy Spotify id shapes to `spotify:<id>`; dedupe keys on id, not `sourceUrl` (short links make every share URL unique)
- Event handling: single delegated listener on `document.body` with `data-action` attributes
- External API calls go through `infra/api.js`, never throw. Every fetch has a deadline (`fetchWithTimeout` / `resolverGet`). One failure shape: a transport failure (network, timeout, 5xx, 429, a malformed body) returns an ApiError (`isApiError()`, `lib/api-error.js`); `null`/`[]` means the answer really is "nothing found"
- Failure rule, every API touch point: return failure to caller that reports it, OR report before swallowing (`reportApiFailure` → beacon → resolver logs). Report transport failures (network, timeout, 5xx, 429, bad body); not expected answers (404, not found). Backend: log every upstream failure via injected logger, never `console.*`
- Static assets (sw.js, manifest.json, favicon) go in `frontend/public/` — copied to `dist/` as-is
- CSS in `frontend/src/css/style.css`, imported from `app.js` so Vite processes it

## Testing

- **Unit tests** use Vitest (`npm run test:unit`). Test files co-located next to their module (`frontend/src/js/<layer>/*.test.js`).
  - Target `domain/` (pure) and `services/` (mock `infra/` with `vi.mock`): e.g. `parseMusicLink`, `filterAlbums`, `pickListenTarget`, `serviceListText`, `addAlbumFromUrl`, `resolvePending`, `loadAlbumDetails`, `shareLanding`
  - All new pure functions w/ business logic must have unit tests
- **E2E tests** use Playwright (`npm run test:e2e`). Test files live in `frontend/tests/`.
  - Stub third-party APIs via `stubExternals()` in `frontend/tests/helpers.js` — add
    any newly-called external host **there**, not per spec file, or the suite
    starts hitting the real network. Per-test overrides still work: Playwright
    resolves the last-registered route first.
  - Cover key user interactions end-to-end; no login anywhere in app, so no auth state to branch on
- **Mobile tests** (`npm run test:mobile`): Playwright device emulation (Pixel 7, Galaxy S9+; iPhone via `MOBILE_WEBKIT=1`, needs `sudo npx playwright install-deps webkit`) vs `vite preview` prod build. Files in `frontend/tests-mobile/`; shared probes/fixtures in `frontend/tests-lib/`. Reuse `stubExternals()` from `tests/helpers.js`. Not part of `npm test`. Tap targets: hard gate 24px (WCAG 2.5.8), sub-44px only reported. Real-device TWA check: `npm run test:android` (adb + emulator, needs built APK from `android/`; see `android/README.md`).

## Pre-push checklist

Always run before pushing (from `frontend/`):
1. `npm run build` — verify production build succeeds
2. `npm test` — verify all unit and E2E tests pass

If `backend/` changed, also run `node --test backend/resolver-core.test.mjs
backend/server.test.mjs` from repo root. `backend/` has a `package.json`
(pino, for structured logging — see `backend/logger.mjs`), so run `npm install`
inside `backend/` first if `node_modules` not there yet; Dockerfile does
its own `npm ci` as part of image build.
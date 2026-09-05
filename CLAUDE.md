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
- **`frontend/src/js/app.js`** — entry point: state management, event delegation, boot sequence
- **`frontend/src/js/api.js`** — calls our resolver (album-page extraction + cross-service links + tracklists, see `backend/`) + Last.fm API
- **`frontend/src/js/render.js`** — pure HTML string rendering (no virtual DOM, no templates)
- **`frontend/src/js/storage.js`** — localStorage read/write for albums, listen count, preferred service; link parsing, backup (de)serialisation, `filterAlbums` (visible-list source of truth)
- **`frontend/src/js/services.js`** — supported-service registry; service labels, per-host album matching, search-link templates (`buildSearchUrl`), profile's "Listen on" options, and every user-facing service list (`serviceListText`) all derive from it. Static markup can't call it — add a service here, also update `src/faq.html` (`<details>` copy + FAQPage JSON-LD) and meta descriptions in `src/index.html`. Service goes here only if its album page (or a free keyless API) actually exposes extractable metadata — see `backend/resolver-core.mjs`'s per-service extractors.
- **`frontend/src/js/sign.js`** — ECDSA-P256 request signing for resolver's `x-gp-token`
- **`frontend/src/js/throttle.js`** — per-service pacing + 429 cooldown, used by every outbound API call
- **`frontend/src/js/config.js`** — API keys, storage keys, resolver base URL, throttle policy
- **`frontend/public/sw.js`** — service worker for offline/PWA support (copied verbatim to dist)
- **`frontend/public/manifest.json`** — PWA manifest
- **`frontend/public/favicon.png`** — app icon

## Key Data Flow

1. User shares/pastes any album URL (Spotify, Apple Music, YouTube, Tidal, Deezer, etc.)
2. `parseMusicLink()` validates URL, identifies service
3. `resolveAlbum()` calls resolver, which fetches pasted album page itself, extracts title/artist/cover/year, cross-links Deezer + Apple Music → saved to localStorage as `links: { spotify?, apple?, youtube?, … }` (exact links only; search-link fallbacks for other services built on the fly by `services.js`, not stored)
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
npm test           # Run all tests (unit + E2E)
```

Resolver itself needs no API key from client's perspective — see `backend/README.md` to run it locally (or point `RESOLVER_BASE` at deployed one).

## Conventions

- All rendering is string-based HTML concat in `render.js` — no DOM manipulation elsewhere
- State lives in module-level vars in `app.js`; `rerender()` rebuilds full UI
- Event handling: single delegated listener on `document.body` with `data-action` attributes
- External API calls go through `api.js`; all return `null` on failure (no thrown errors)
- Static assets (sw.js, manifest.json, favicon) go in `frontend/public/` — copied to `dist/` as-is
- CSS in `frontend/src/css/style.css`, imported from `app.js` so Vite processes it

## Testing

- **Unit tests** use Vitest (`npm run test:unit`). Test files co-located as `frontend/src/js/*.test.js`.
  - Target pure/business-logic functions: `parseMusicLink`, `filterAlbums`, `resolveAlbum`, `pickListenUrl`, `pickListenTarget`, `linkedServiceNames`, `serviceListText`, `joinList`, `timeAgo`, `tagsByFrequency`, `artistInitials`, `normalizeAlbumStr`
  - All new pure functions w/ business logic must have unit tests
- **E2E tests** use Playwright (`npm run test:e2e`). Test files live in `frontend/tests/`.
  - Stub third-party APIs via `stubExternals()` in `frontend/tests/helpers.js` — add
    any newly-called external host **there**, not per spec file, or the suite
    starts hitting the real network. Per-test overrides still work: Playwright
    resolves the last-registered route first.
  - Cover key user interactions end-to-end; no login anywhere in app, so no auth state to branch on

## Pre-push checklist

Always run before pushing (from `frontend/`):
1. `npm run build` — verify production build succeeds
2. `npm test` — verify all unit and E2E tests pass

If `backend/` changed, also run `node --test backend/resolver-core.test.mjs
backend/server.test.mjs` from repo root. `backend/` has a `package.json`
(pino, for structured logging — see `backend/logger.mjs`), so run `npm install`
inside `backend/` first if `node_modules` not there yet; Dockerfile does
its own `npm ci` as part of image build.
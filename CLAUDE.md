# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Groovepede is a local-first PWA for managing a universal album listening queue. Paste links from Spotify, Apple Music, YouTube Music, Tidal, Deezer, and more — no account required. Built with Vite + vanilla ES modules, deployed via GitHub Pages.

Spotify is an optional connected service for users who want to sync their queue to a Spotify playlist. All other functionality (adding albums, browsing by genre, artist info) works without any login.

## Repository layout

Two top-level workspaces:

- **`frontend/`** — the PWA (Vite + vanilla ES modules). All npm commands run
  from here.
- **`backend/`** — the self-hosted resolver stack for the Raspberry Pi
  (Node resolver + nginx + certbot + fail2ban, Docker Compose). See
  `backend/README.md`.

## Architecture

- **`frontend/src/index.html`** — single-page app shell (Vite entry point)
- **`frontend/src/css/style.css`** — all styles, imported via JS
- **`frontend/src/js/app.js`** — entry point: state management, event delegation, boot sequence
- **`frontend/src/js/auth.js`** — Spotify OAuth PKCE flow (no backend); login is optional
- **`frontend/src/js/api.js`** — calls our resolver (album-page extraction + cross-service links, see `backend/`) + Spotify Web API + Last.fm API
- **`frontend/src/js/render.js`** — pure HTML string rendering (no virtual DOM, no templates)
- **`frontend/src/js/storage.js`** — localStorage read/write for albums, listen count, preferred service; link parsing, backup (de)serialisation, and `filterAlbums` (the visible-list source of truth)
- **`frontend/src/js/services.js`** — the supported-service registry; service labels, per-host album matching, search-link templates (`buildSearchUrl`), the profile's "Listen on" options and every user-facing service list (`serviceListText`) all derive from it. Static markup can't call it — when adding a service, also update `src/faq.html` (both the `<details>` copy and the FAQPage JSON-LD) and the meta descriptions in `src/index.html`. A service can only be added here if its album page (or a free keyless API) actually exposes extractable metadata — see `backend/resolver-core.mjs`'s per-service extractors.
- **`frontend/src/js/sign.js`** — ECDSA-P256 request signing for the resolver's `x-gp-token`
- **`frontend/src/js/throttle.js`** — per-service pacing + 429 cooldown used by every outbound API call
- **`frontend/src/js/config.js`** — API keys, storage keys, OAuth config, resolver base URL, throttle policy
- **`frontend/src/js/sync.js`** — optional Spotify playlist sync (only active when user is logged in)
- **`frontend/public/sw.js`** — service worker for offline/PWA support (copied verbatim to dist)
- **`frontend/public/manifest.json`** — PWA manifest
- **`frontend/public/favicon.png`** — app icon

## Key Data Flow

1. User shares/pastes any album URL (Spotify, Apple Music, YouTube, Tidal, Deezer, etc.)
2. `parseMusicLink()` validates the URL and identifies the service
3. `resolveAlbum()` calls our resolver, which fetches the pasted album page itself, extracts title/artist/cover/year, and cross-links Deezer + Apple Music → saved to localStorage with `links: { spotify?, apple?, youtube?, … }` (exact links only; search-link fallbacks for other services are built on the fly by `services.js`, not stored)
4. If the resolver is unreachable (retryable error), a pending stub is saved and retried on next app open via `resolvePending()`
5. `enrichWithLastfm()` fires asynchronously to fetch Last.fm tags → updates saved album and re-renders
6. Artist bio/similar artists fetched on-demand via `fetchLastfmArtist()` when user expands a card
7. Listen button opens the user's preferred service (configurable in profile; falls back through available links)

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

For local dev, update `REDIRECT` in `frontend/src/js/config.js` to `http://localhost:5173/` and add that URI to your Spotify Developer app. The resolver itself needs no API key — see `backend/README.md` for running it locally (or point `RESOLVER_BASE` at the deployed one).

## Conventions

- All rendering is string-based HTML concatenation in `render.js` — no DOM manipulation elsewhere
- State lives in module-level variables in `app.js`; `rerender()` rebuilds the full UI
- Event handling uses a single delegated listener on `document.body` with `data-action` attributes
- External API calls go through `api.js`; all return `null` on failure (no thrown errors)
- Static assets (sw.js, manifest.json, favicon) go in `frontend/public/` — copied to `dist/` as-is
- CSS is in `frontend/src/css/style.css`, imported from `app.js` so Vite processes it

## Testing

- **Unit tests** use Vitest (`npm run test:unit`). Test files are co-located as `frontend/src/js/*.test.js`.
  - Target pure/business-logic functions: `parseMusicLink`, `filterAlbums`, `resolveAlbum`, `pickListenUrl`, `pickListenTarget`, `linkedServiceNames`, `serviceListText`, `joinList`, `timeAgo`, `tagsByFrequency`, `artistInitials`, `normalizeAlbumStr`
  - All new pure functions with business logic must have unit tests
- **E2E tests** use Playwright (`npm run test:e2e`). Test files live in `frontend/tests/`.
  - Stub third-party APIs via `stubExternals()` in `frontend/tests/helpers.js` — add
    any newly-called external host **there**, not per spec file, or the suite
    starts hitting the real network. Per-test overrides still work: Playwright
    resolves the last-registered route first.
  - Cover auth flows and key user interactions; Spotify login is optional so logged-out paths must be covered too

## Pre-push checklist

Always run before pushing (from `frontend/`):
1. `npm run build` — verify production build succeeds
2. `npm test` — verify all unit and E2E tests pass

When `backend/` changed, also run `node --test backend/resolver-core.test.mjs`
from the repo root.

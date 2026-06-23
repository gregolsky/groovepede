# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Groovepede is a local-first PWA for managing a universal album listening queue. Paste links from Spotify, Apple Music, YouTube Music, Tidal, Deezer, and more — no account required. Built with Vite + vanilla ES modules, deployed via GitHub Pages.

Spotify is an optional connected service for users who want to sync their queue to a Spotify playlist. All other functionality (adding albums, browsing by genre, artist info) works without any login.

## Architecture

- **`src/index.html`** — single-page app shell (Vite entry point)
- **`src/css/style.css`** — all styles, imported via JS
- **`src/js/app.js`** — entry point: state management, event delegation, boot sequence
- **`src/js/auth.js`** — Spotify OAuth PKCE flow (no backend); login is optional
- **`src/js/api.js`** — Odesli (universal link resolver) + Spotify Web API + Last.fm API
- **`src/js/render.js`** — pure HTML string rendering (no virtual DOM, no templates)
- **`src/js/storage.js`** — localStorage read/write for albums, listen count, preferred service
- **`src/js/config.js`** — API keys, storage keys, OAuth config, Odesli base URL
- **`src/js/sync.js`** — optional Spotify playlist sync (only active when user is logged in)
- **`public/sw.js`** — service worker for offline/PWA support (copied verbatim to dist)
- **`public/manifest.json`** — PWA manifest
- **`public/favicon.png`** — app icon

## Key Data Flow

1. User shares/pastes any album URL (Spotify, Apple Music, YouTube, Tidal, Deezer, etc.)
2. `parseMusicLink()` validates the URL and identifies the service
3. `resolveAlbum()` calls the Odesli API to get cross-service links + metadata → saved to localStorage with `tags: []` and `links: { spotify?, apple?, youtube?, … }`
4. If Odesli is unreachable (retryable error), a pending stub is saved and retried on next app open via `resolvePending()`
5. `enrichWithLastfm()` fires asynchronously to fetch Last.fm tags → updates saved album and re-renders
6. Artist bio/similar artists fetched on-demand via `fetchLastfmArtist()` when user expands a card
7. Listen button opens the user's preferred service (configurable in profile; falls back through available links)

## Development

```
npm run dev        # Vite dev server at localhost:5173
npm run build      # Production build to dist/
npm run preview    # Preview production build locally
npm run test:unit  # Run Vitest unit tests
npm run test:e2e   # Run Playwright E2E tests
npm test           # Run all tests (unit + E2E)
```

For local dev, update `REDIRECT` in `src/js/config.js` to `http://localhost:5173/` and add that URI to your Spotify Developer app. Odesli requires no API key for development (10 req/min free tier).

## Conventions

- All rendering is string-based HTML concatenation in `render.js` — no DOM manipulation elsewhere
- State lives in module-level variables in `app.js`; `rerender()` rebuilds the full UI
- Event handling uses a single delegated listener on `document.body` with `data-action` attributes
- External API calls go through `api.js`; all return `null` on failure (no thrown errors)
- Static assets (sw.js, manifest.json, favicon) go in `public/` — copied to `dist/` as-is
- CSS is in `src/css/style.css`, imported from `app.js` so Vite processes it

## Testing

- **Unit tests** use Vitest (`npm run test:unit`). Test files are co-located as `src/js/*.test.js`.
  - Target pure/business-logic functions: `parseMusicLink`, `resolveAlbum`, `pickListenUrl`, `cleanTags`, `timeAgo`, `fmtDuration`, `attr`, `allTags`
  - All new pure functions with business logic must have unit tests
- **E2E tests** use Playwright (`npm run test:e2e`). Test files live in `tests/`.
  - Use `context.route()` to stub `api.song.link/**` (Odesli), Spotify, and Last.fm API responses
  - Cover auth flows and key user interactions; Spotify login is optional so logged-out paths must be covered too

## Pre-push checklist

Always run before pushing:
1. `npm run build` — verify production build succeeds
2. `npm test` — verify all unit and E2E tests pass

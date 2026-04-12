# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Groovepede is a local-first PWA for managing a Spotify album listening queue. No build step, no framework, no dependencies — plain HTML + native ES modules. Deployed via GitHub Pages.

## Architecture

- **`index.html`** — single-page app shell with all CSS inlined in `<style>`
- **`js/app.js`** — entry point: state management, event delegation, boot sequence
- **`js/auth.js`** — Spotify OAuth PKCE flow (no backend)
- **`js/api.js`** — Spotify Web API + Last.fm API calls (album metadata, artist info, tags)
- **`js/render.js`** — pure HTML string rendering (no virtual DOM, no templates)
- **`js/storage.js`** — localStorage read/write for albums and listen count
- **`js/config.js`** — API keys, storage keys, OAuth config
- **`sw.js`** — service worker for offline/PWA support

## Key Data Flow

1. User shares/pastes a Spotify album URL
2. `fetchAlbumMeta()` gets album data from Spotify API → saved to localStorage with `tags: []`
3. `enrichWithLastfm()` fires asynchronously to fetch Last.fm tags → updates saved album and re-renders
4. Artist bio/similar artists fetched on-demand via `fetchLastfmArtist()` when user expands a card

## Development

No build, lint, or test commands. Serve locally with any static server:

```
python3 -m http.server 8000
# or
npx serve .
```

For local dev, update `REDIRECT` in `js/config.js` to `http://localhost:8000/` and add that URI to your Spotify Developer app.

## Conventions

- All rendering is string-based HTML concatenation in `render.js` — no DOM manipulation elsewhere
- State lives in module-level variables in `app.js`; `rerender()` rebuilds the full UI
- Event handling uses a single delegated listener on `document.body` with `data-action` attributes
- External API calls go through `api.js`; all return `null` on failure (no thrown errors)

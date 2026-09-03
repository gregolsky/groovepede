# Groovepede — Technical Specifications

## Goal

Universal album listening queue. Users paste links from any supported music service, choose their preferred listening app, and tap Listen. No login, no accounts, anywhere.

---

## Supported services

| Slug | Service | Input accepted |
|---|---|---|
| `spotify` | Spotify | `open.spotify.com/album/…`, `spotify:album:<id>`, 22-char bare ID |
| `apple` | Apple Music | `music.apple.com/…/album/…` |
| `youtube` | YouTube / YT Music | `music.youtube.com/playlist?list=…`, `youtube.com/playlist?list=…` |
| `deezer` | Deezer | `deezer.com/album/…` |
| `tidal` | Tidal | `tidal.com/album/…`, `listen.tidal.com/album/…` |
| `pandora` | Pandora | `pandora.com/album/…` |

**Blocked at input (with clear error):** Bandcamp, Discogs, Amazon Music, SoundCloud
— the last two used to be supported, but neither album page has any
server-rendered metadata to extract (verified live — pure client-rendered JS
shells, no og:/JSON-LD, and SoundCloud's oEmbed endpoint 404s outright), so
the resolver has no way to read them.

---

## Album record schema

```js
{
  id:            string,    // '<service>:<serviceAlbumId>' (new records), e.g. 'spotify:4aaw…';
                             // 'mb:<mbid>' when resolved via the MusicBrainz fallback;
                             // legacy: bare Spotify album ID
  legacyId?:     string,    // old Spotify ID — set by migration on pre-pivot records
  sourceUrl:     string,    // the URL the user originally pasted
  title:         string,
  artist:        string,
  cover:         string | null,
  year:          string | null,
  tags:          string[],  // genre tags — primarily Last.fm; Deezer/MusicBrainz genres fill in when Last.fm is thin
  addedAt:       string,    // ISO 8601

  links: {                  // EXACT links only, from the resolver's cross-linking (see below).
    spotify?:    { url: string, nativeUri: string | null },
    apple?:      { url: string, nativeUri: string | null },
    youtube?:    { url: string, nativeUri: string | null },
    deezer?:     { url: string, nativeUri: string | null },
    tidal?:      { url: string, nativeUri: string | null },
    pandora?:    { url: string, nativeUri: string | null },
  },
  // NOT part of the stored record: best-effort SEARCH links for a service with
  // no exact entry above are built on the fly by services.js's buildSearchUrl()
  // at render time (see pickListenTarget in render.js) — never persisted, so
  // every album retroactively gains them as new services/templates are added.
}
```

### Migration

Pre-pivot records (`{ id, url }`) are upgraded lazily on read by `upgradeAlbumRecord(rec)`:
- `id` (Spotify album ID) → copied to `legacyId`; `id` unchanged
- `url` → `links.spotify.url`; `spotify:album:<id>` → `links.spotify.nativeUri`
- `url` → `sourceUrl`
- `links: {}` if no Spotify URL

Records with an existing `links` key are passed through unchanged (idempotent).

---

## Storage keys

| Key | Type | Purpose |
|---|---|---|
| `gp_albums` | JSON array | Album queue |
| `gp_done` | number string | Lifetime listened count |
| `gp_pref_service` | string slug | Preferred listening service (default: `'spotify'`) |

All keys are defined in `frontend/src/js/config.js`.

---

## API integrations

### Resolver (album-page extraction + cross-linking)

Odesli's public API was deprecated (2026-08). The browser can't fetch another
service's album page itself (CORS), so the self-hosted resolver fetches the
pasted URL server-side, extracts `{title, artist, cover, year}` with a small
per-service routine, then cross-links to Deezer and Apple/iTunes via their own
free keyless search APIs.

- **Base**: `https://api.groovepede.gregolsky.pl` (`RESOLVER_BASE` in config.js)
- **Endpoint**: `GET /v1/album?url=<encoded>`
- **Auth**: `x-gp-token`, an ECDSA-P256 signature over `"<ts>\n<url>"` (see `sign.js`)
- **Caching**: 60 days in the resolver's SQLite cache; resolved records then live
  in localStorage
- **Returns**: `{ id, service, title, artist, cover, year, tags, links }` — see
  `resolveAlbum()` in `api.js`, which adopts the response near-verbatim
- **Error handling**: non-200 → `{ _error: statusCode }`; network failure →
  `{ _error: 'network' }`; a fetch that succeeded but found no album (markup
  changed, or not really an album page) → `{ _error: 422 }`, non-retryable
- **Fallback**: `resolveAlbumResilient()` falls back to MusicBrainz (client-side,
  throttled) when the resolver errors or is in rate-limit cooldown — used on
  every interactive resolve (paste, share, refresh), not just the pending-retry loop
- See `backend/resolver-core.mjs` and `backend/README.md`

### Tracklist

`fetchAlbumTracks(albumId)` in `api.js` calls the resolver's `GET
/v1/tracks?albumId=<deezer id>` (same auth/caching model as `/v1/album`,
30-day TTL) to source the Explore card's tracklist from Deezer server-side —
`api.deezer.com` sends no CORS header, so the browser can't call it directly.
`albumId` is Deezer's own numeric album id, read off `links.deezer.url` via
`deezerAlbumId()`; no id means no tracklist fetch.

### Last.fm

- **Endpoints used**: `album.getinfo` and `artist.gettoptags` (tags),
  `artist.getinfo` (bio), `artist.getsimilar` (similar artists + tag fallback)
- **Auth**: API key only (`LASTFM_KEY` in config.js)
- **Called after** resolve; enriches `tags` in place (`year` comes from the
  resolver/MusicBrainz, not Last.fm)
- **Not used for artist images** — Last.fm has served the same placeholder for
  every artist since 2019; see the artist-image section below

### Artist images

Chain, first hit wins: TheAudioDB (browser-direct, CORS-enabled) → Deezer via
the resolver's `/v1/artist` (`api.deezer.com` sends no CORS header) → initials
avatar. Only image URLs are handled; the browser loads the image from the
source's own CDN.

---

## Key pure functions

### `parseMusicLink(raw)` — `storage.js`

Parses raw user input. Returns one of:
- `{ url, service }` — recognized album link, normalized to HTTPS URL
- `{ error }` — rejected input with a human-readable message
- `{ error: null }` — empty input

### `resolveAlbum(url)` — `api.js`

Calls the resolver. Returns a full album record (see schema above) or `{ _error }` on failure.

### `upgradeAlbumRecord(rec)` — `storage.js`

Converts legacy Spotify-only record to universal shape. Idempotent.

### `filterAlbums(albums, activeFilter, searchQuery)` — `storage.js`

The visible album list, after the tag filter and the search box. Single source of
truth: every `data-index` in the rendered markup is an index into this list, and
`app.js`'s click handlers resolve those indices against the same function.

### `pickListenTarget(album, prefService)` / `pickListenUrl(album, prefService)` — `render.js`

Resolves the best `{ url, service, exact }` to open for Listen, given the
user's preferred service. Exact links (from `album.links`) always win over a
best-effort search link built on the fly (`buildSearchUrl()` in `services.js`):
1. `album.links[prefService]?.nativeUri` (preferred, exact: opens native app)
2. `album.links[prefService]?.url` (preferred, exact: web fallback)
3. First available `nativeUri` across all services (any, exact)
4. First available `url` across all services (any, exact)
5. Search link on the preferred service, if `artist` + `title` are known (`exact: false`)
6. Search link on a fallback service, if the preferred slug isn't registered (`exact: false`)
7. `album.sourceUrl` (last resort — always `exact: true`, it's a real page)

`pickListenUrl` returns just the `url`.

### `serviceLabel(service)` — `services.js`

Returns human-readable name for a service slug (e.g., `'apple'` → `'Apple Music'`).
Re-exported from `render.js` for convenience.

---

## Add flow

```
user input
  → parseMusicLink()             // validate + normalize
  → resolveAlbumResilient(url)   // resolver, falling back to MusicBrainz on any error
  → saveResolvedAlbum()          // dedupe by id, persist, enrich
      → enrichWithLastfm()     // async: fill tags
  → rerender()
```

When the resolver is unreachable with a retryable error, a pending stub is
saved instead and retried by `resolvePending()` on next open.

---

## Listen button

Three states, via `renderListenBtn()` in `render.js`:
1. Exact link on the preferred service → `Listen` (or `Listen on <service>` where shown)
2. Exact link on another service → `Listen on <that service>` (never opens silently)
3. No exact link anywhere, but artist+title are known → `Find on <service>`
   (opens a search, styled and labelled distinctly from the exact states)
4. Nothing at all → disabled, `No link yet`

`data-url` attribute: result of `pickListenUrl(album, prefService)`.
Preferred service set in profile overlay; persisted to `gp_pref_service`.

---

## Backup format

```json
{ "version": 4, "exportedAt": "<ISO>", "albums": [...], "done": 42 }
```

Exports carry the full album record (cover, links, tags), so an import
restores instantly with no re-resolution.

Versions 1–4 are accepted on import:

| Version | On import |
|---|---|
| 1, 2 | Legacy Spotify-only records — migrated by `upgradeAlbumRecord`, restored directly |
| 3 | Lean export (`sourceUrl` only) — saved as pending stubs and re-resolved |
| 4 | Current — restored directly |

Entries with no title/artist fall back to a pending stub regardless of version.

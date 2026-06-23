# Groovepede — Technical Specifications

## Goal

Universal album listening queue. Users paste links from any supported music service, choose their preferred listening app, and tap Listen. No login required. Spotify OAuth is opt-in for the existing playlist-sync feature only.

---

## Supported services

| Slug | Service | Input accepted |
|---|---|---|
| `spotify` | Spotify | `open.spotify.com/album/…`, `spotify:album:<id>`, 22-char bare ID |
| `apple` | Apple Music | `music.apple.com/…/album/…` |
| `youtube` | YouTube / YT Music | `music.youtube.com/playlist?list=…`, `youtube.com/playlist?list=…` |
| `deezer` | Deezer | `deezer.com/album/…` |
| `tidal` | Tidal | `tidal.com/album/…`, `listen.tidal.com/album/…` |
| `amazon` | Amazon Music | `music.amazon.com/albums/…` |
| `pandora` | Pandora | `pandora.com/album/…` |
| `soundcloud` | SoundCloud | `soundcloud.com/…/sets/…` |

**Blocked at input (with clear error):** Bandcamp, Discogs.

---

## Album record schema

```js
{
  id:            string,    // Odesli entityUniqueId (new records); legacy: Spotify album ID
  legacyId?:     string,    // old Spotify ID — set by migration on pre-pivot records
  sourceUrl:     string,    // the URL the user originally pasted
  title:         string,
  artist:        string,
  cover:         string | null,
  year:          string | null,
  tags:          string[],  // Last.fm genre tags
  addedAt:       string,    // ISO 8601

  links: {                  // populated from Odesli linksByPlatform
    spotify?:    { url: string, nativeUri: string | null },
    apple?:      { url: string, nativeUri: string | null },
    youtube?:    { url: string, nativeUri: string | null },
    deezer?:     { url: string, nativeUri: string | null },
    tidal?:      { url: string, nativeUri: string | null },
    amazon?:     { url: string, nativeUri: string | null },
    pandora?:    { url: string, nativeUri: string | null },
    soundcloud?: { url: string, nativeUri: string | null },
  },

  firstTrackUri?: string,   // spotify:track:<id> — used by sync.js; only set on Spotify-sourced albums
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
| `gp_sync_enabled` | boolean string | Spotify sync on/off |
| `gp_sync_playlist_id` | string | Spotify playlist ID for sync |
| `gp_sync_last` | number string | Timestamp of last sync |
| `gp_sync_pending` | boolean string | Sync needed flag |
| `gp_cv` | string | Spotify OAuth code verifier |
| `gp_token` | JSON | Spotify access/refresh token |

---

## API integrations

### Odesli / Songlink

- **Base**: `https://api.song.link/v1-alpha.1`
- **Endpoint**: `GET /links?url=<encoded>&userCountry=US[&key=<key>]`
- **Auth**: optional API key (`ODESLI_API_KEY` in config.js, blank = anonymous)
- **Rate limit**: 10 req/min (free tier); cached indefinitely in localStorage after add
- **Returns**: `{ entityUniqueId, entitiesByUniqueId, linksByPlatform }` — see `resolveAlbum()` in `api.js`
- **Error handling**: non-200 → `{ _error: statusCode }`; network failure → `{ _error: 'network' }`

### Last.fm

- **Endpoints used**: `album.getinfo` (tags, year), `artist.getinfo` (bio, similar)
- **Auth**: API key only (`LASTFM_KEY` in config.js)
- **Called after** Odesli resolve; enriches `tags` and `year` in place

### Spotify (optional)

- **OAuth**: PKCE, no backend; scopes: `user-read-private`, `playlist-modify-private`
- **Used for**: sync queue → private Spotify playlist
- **Not required** to add albums or use Listen button

---

## Key pure functions

### `parseMusicLink(raw)` — `storage.js`

Parses raw user input. Returns one of:
- `{ url, service }` — recognized album link, normalized to HTTPS URL
- `{ error }` — rejected input with a human-readable message
- `{ error: null }` — empty input

### `resolveAlbum(url)` — `api.js`

Calls Odesli. Returns a full album record (see schema above) or `{ _error }` on failure.

### `upgradeAlbumRecord(rec)` — `storage.js`

Converts legacy Spotify-only record to universal shape. Idempotent.

### `pickListenUrl(album, prefService)` — `render.js`

Resolves the best URL to open for Listen, given the user's preferred service:
1. `album.links[prefService]?.nativeUri` (preferred: opens native app)
2. `album.links[prefService]?.url` (web fallback for preferred)
3. First available `nativeUri` across all services
4. First available `url` across all services
5. `album.sourceUrl` (last resort)

### `serviceLabel(service)` — `render.js`

Returns human-readable name for a service slug (e.g., `'apple'` → `'Apple Music'`).

---

## Add flow (Phase 3 target)

```
user input
  → parseMusicLink()       // validate + normalize
  → resolveAlbum(url)      // Odesli: get cross-service links + metadata
  → enrichWithLastfm()     // async: fill tags + year
  → saveAlbums()           // persist
  → rerender()
```

No Spotify API call required. Spotify sync (`schedulePush`) fires only if `tokenValid()`.

---

## Listen button

- Label: `Listen on <serviceLabel(prefService)>` (or `Listen` if no preferred service match)
- `data-url` attribute: result of `pickListenUrl(album, prefService)`
- Preferred service set in profile overlay; persisted to `gp_pref_service`

---

## Backup format

```json
{ "version": 2, "exportedAt": "<ISO>", "albums": [...], "done": 42 }
```

Version 1 backups (pre-pivot Spotify-only) are accepted and migrated on import.

---

## Phases

| # | Name | Status |
|---|---|---|
| 0 | Odesli client + universal link parser | Done |
| 1 | Album record migration | Done |
| 2 | Preferred service setting + Listen button rewrite | In progress |
| 3 | Add flow via Odesli (no Spotify auth) | Pending |
| 4 | Decouple boot from Spotify auth | Pending |
| 5 | Sync isolation (hide when logged out) | Pending |
| 6 | Copy, manifest, doc cleanup | Pending |

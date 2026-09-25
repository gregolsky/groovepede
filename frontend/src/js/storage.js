import { STORAGE_KEY, DONE_KEY, PREF_SERVICE_KEY } from './config.js';
import { SERVICES, findServiceByHost, isShortLinkHost, isShortLinkPath, isWebUrl, isSafeLinkUrl, serviceListText } from './services.js';

const DEFAULT_PREF_SERVICE = 'spotify';

// "Spotify, Apple Music, … or SoundCloud" — every service the parser accepts,
// derived from the registry so an unsupported-link error can never advertise a
// shorter list than parseMusicLink actually handles.
const SUPPORTED = () => serviceListText({ conj: 'or' });

export function upgradeAlbumRecord(rec) {
  if (rec.links) return rec; // already migrated
  const spotifyId = rec.id;
  const spotifyUrl = rec.url || null;
  const links = {};
  if (spotifyUrl) {
    links.spotify = {
      url: spotifyUrl,
      nativeUri: `spotify:album:${spotifyId}`,
    };
  }
  return { ...rec, sourceUrl: spotifyUrl || rec.sourceUrl || null, legacyId: spotifyId, links };
}

/**
 * One id per album, whatever era saved it. Spotify records have carried three
 * id shapes over the app's lifetime — a bare 22-char id (the original
 * login-era records), `SPOTIFY_ALBUM::<id>` (the Odesli era), and
 * `spotify:<id>` (the current resolver) — so the same album saved twice
 * across eras compared as two albums and was queued twice. Every other id
 * (`mb:`, `apple:`, `pending:`, …) is already canonical.
 */
export function canonicalAlbumId(id) {
  if (typeof id !== 'string') return id;
  if (/^[A-Za-z0-9]{22}$/.test(id)) return `spotify:${id}`;
  const odesli = id.match(/^SPOTIFY_ALBUM::([A-Za-z0-9]+)$/);
  return odesli ? `spotify:${odesli[1]}` : id;
}

/**
 * Bring stored records up to the current shape: the v1 links upgrade, a
 * canonical id, and — since canonical ids can reveal duplicates saved under
 * different eras' ids — one record per album (the earliest-saved one wins).
 * Runs on every read; the result is persisted by the next write.
 */
function normalizeAlbums(raw) {
  const seen = new Set();
  const out = [];
  for (const rec of raw.map(upgradeAlbumRecord)) {
    const id = canonicalAlbumId(rec.id);
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    out.push(id === rec.id ? rec : { ...rec, id });
  }
  return out;
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// loadAlbums() used to re-parse and re-migrate localStorage on every call —
// cheap per call, but it's called several times per rerender (getState(),
// visibleAlbums(), plus whatever a handler reads before dispatching). Keyed on
// the raw stored string rather than a dirty flag: a write from another tab (or
// a test seeding via localStorage.setItem directly, bypassing saveAlbums) just
// changes the raw string, so the next loadAlbums() call sees the mismatch and
// reparses — no separate invalidation path to keep in sync.
//
// The cached array and its records are deep-frozen. Nothing may mutate a
// loaded record except through updateAlbums/updateAlbum below, which clone
// before handing `fn` a mutable copy — a call site that mutates a loaded
// record directly now throws immediately (ES modules run in strict mode)
// instead of silently corrupting the cache every other caller shares.
let _cache = { raw: undefined, albums: undefined };

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function loadAlbums() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== _cache.raw) {
    let albums;
    try { albums = normalizeAlbums(JSON.parse(raw) || []); } catch { albums = []; }
    _cache = { raw, albums: deepFreeze(albums) };
  }
  return _cache.albums;
}

export function saveAlbums(a) {
  const raw = JSON.stringify(a);
  localStorage.setItem(STORAGE_KEY, raw);
  // Cache a JSON round-trip of `a`, not `a` itself: `a` is whatever the caller
  // (often a fresh structuredClone from updateAlbums below) still holds a
  // reference to, and this way the cache can never disagree with what
  // actually got persisted — nor can freezing it reach back and freeze
  // something the caller didn't mean to hand off.
  _cache = { raw, albums: deepFreeze(JSON.parse(raw)) };
}

/**
 * Read the stored queue, apply `fn`, and save — all synchronously, so no await
 * can land between the read and the write. Every change to the queue goes
 * through this (or updateAlbum): a caller that loads, awaits, then saves
 * writes back a stale snapshot and silently undoes whatever happened in
 * between (an album marked Done comes back, a just-added one disappears).
 * `fn` may return a new list, or mutate in place and return nothing — the
 * list it's handed is a fresh clone of the cache, never the frozen original.
 */
export function updateAlbums(fn) {
  const albums = structuredClone(loadAlbums());
  const next = fn(albums) ?? albums;
  saveAlbums(next);
  return next;
}

/**
 * Apply `fn` to one album by id, via the same synchronous read-modify-write.
 * `fn` may return a replacement record or mutate in place — again, a clone,
 * never the frozen cached record. Returns the stored record, or null —
 * without writing anything — when the album is no longer in the queue (e.g.
 * marked Done while an async lookup for it was in flight).
 */
export function updateAlbum(id, fn) {
  const albums = structuredClone(loadAlbums());
  const i = albums.findIndex(a => a.id === id);
  if (i === -1) return null;
  albums[i] = fn(albums[i]) ?? albums[i];
  saveAlbums(albums);
  return albums[i];
}

export function loadDone()    { return parseInt(localStorage.getItem(DONE_KEY) || '0'); }
export function saveDone(n)   { localStorage.setItem(DONE_KEY, String(n)); }

/**
 * The album list the UI actually shows, after the tag filter and the search box.
 *
 * Single source of truth on purpose: every `data-index` in the rendered markup
 * is an index into THIS list, and the click handlers resolve those indices
 * against it. If the renderer and the handlers ever computed it separately and
 * drifted, Done/Explore would silently act on the wrong album.
 */
export function filterAlbums(albums, activeFilter, searchQuery) {
  let list = activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));
  const q = (searchQuery || '').trim().toLowerCase();
  if (q) list = list.filter(a => (a.title || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q));
  return list;
}

export function extractAlbumId(url) {
  // Full URL: open.spotify.com/album/<id>, tolerating the locale-prefixed
  // share-sheet form open.spotify.com/intl-XX/album/<id>.
  const urlMatch = url.match(/spotify\.com\/(?:intl-[a-z]{2}\/)?album\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  // Spotify URI: spotify:album:<id>
  const uriMatch = url.match(/^spotify:album:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];
  // Bare album ID (22-char base62)
  if (/^[a-zA-Z0-9]{22}$/.test(url)) return url;
  return null;
}

export function serializeBackup(albums, done) {
  // Persist the full album record (snapshot), stripping only transient flags.
  // Cover art URL, links, and tags are all included so import is instant —
  // no re-resolution needed.
  const full = albums.map(({ _pending, _error, ...a }) => a);
  return JSON.stringify({ version: 4, exportedAt: new Date().toISOString(), albums: full, done });
}

const asText = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const TEXT_FIELDS = ['id', 'title', 'artist', 'year', 'service', 'addedAt'];

/**
 * Coerce one untrusted record to the shape the rest of the app assumes. An
 * imported backup is user-supplied JSON, so every field the UI renders or
 * opens is checked here, at the boundary: text fields must be text, tags a
 * list of strings, cover/sourceUrl http(s), and link URLs http(s) or spotify:.
 * Unknown fields pass through untouched — they're never rendered. `links`
 * stays absent when the record had none, so upgradeAlbumRecord still sees a
 * legacy (v1/v2) record as one. Returns null for anything that isn't an object.
 */
export function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = {
    ...raw,
    cover:     isWebUrl(raw.cover) ? raw.cover : null,
    sourceUrl: isWebUrl(raw.sourceUrl) ? raw.sourceUrl : null,
    tags:      Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string') : [],
  };
  for (const k of TEXT_FIELDS) if (k in raw) rec[k] = asText(raw[k]);
  if ('url' in raw) rec.url = isWebUrl(raw.url) ? raw.url : null;
  if ('links' in raw) {
    rec.links = {};
    const entries = raw.links && typeof raw.links === 'object' ? Object.entries(raw.links) : [];
    for (const [slug, e] of entries) {
      const url       = isSafeLinkUrl(e?.url)       ? e.url       : null;
      const nativeUri = isSafeLinkUrl(e?.nativeUri) ? e.nativeUri : null;
      if (url || nativeUri) rec.links[slug] = { url, nativeUri };
    }
  }
  return rec;
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || ![1, 2, 3, 4].includes(data.version) || !Array.isArray(data.albums) || typeof data.done !== 'number') {
    throw new Error('Invalid backup format');
  }

  const albums = data.albums.map(sanitizeRecord).filter(Boolean).map(album => {
    if (data.version === 3) {
      // Legacy lean export (v3): only sourceUrl/service/addedAt; must re-resolve.
      const sourceUrl = album.sourceUrl;
      if (!sourceUrl) return null;
      const service = album.service || parseMusicLink(sourceUrl).service;
      const stub = makePendingRecord(sourceUrl, service || 'spotify');
      stub.addedAt = album.addedAt || stub.addedAt;
      return stub;
    }

    // v1 / v2 / v4: carry metadata — restore directly, no resolve needed.
    const upgraded = upgradeAlbumRecord(album); // normalises links.spotify for v1/v2
    const sourceUrl = upgraded.sourceUrl;
    if (!sourceUrl) return null;

    if (upgraded.title && upgraded.artist) {
      // Full record: return as-is (non-pending); preserve addedAt from backup.
      const { _pending, _error, ...clean } = upgraded;
      return { ...clean, addedAt: album.addedAt || clean.addedAt };
    }

    // Metadata absent (sparse legacy entry) — fall back to pending stub.
    const service = upgraded.service || parseMusicLink(sourceUrl).service;
    const stub = makePendingRecord(sourceUrl, service || 'spotify');
    stub.addedAt = album.addedAt || stub.addedAt;
    return stub;
  }).filter(Boolean);

  return { albums: normalizeAlbums(albums), done: data.done };
}

/**
 * Merge a fresh resolve result into an existing album record.
 * Overwrites title/artist/cover/year/links; preserves id, sourceUrl,
 * addedAt, and tags (those are enriched separately).
 */
export function mergeRefreshedAlbum(existing, resolved) {
  return {
    ...existing,
    title:  resolved.title  ?? existing.title,
    artist: resolved.artist ?? existing.artist,
    cover:  resolved.cover  ?? existing.cover,
    year:   resolved.year   ?? existing.year,
    links:  { ...existing.links, ...resolved.links },
  };
}

export function getPreferredService() {
  const stored = localStorage.getItem(PREF_SERVICE_KEY);
  // A previously-chosen preference (e.g. amazon/soundcloud, dropped from the
  // registry) that no longer maps to a registered service falls back to the
  // default rather than silently rendering nothing selected.
  if (stored && SERVICES.some(s => s.slug === stored)) return stored;
  return DEFAULT_PREF_SERVICE;
}
/** True when the user has explicitly chosen a preferred service (not just the default). */
export function hasExplicitPreferredService() {
  return !!localStorage.getItem(PREF_SERVICE_KEY);
}
export function setPreferredService(s) {
  localStorage.setItem(PREF_SERVICE_KEY, s);
}

export function parseMusicLink(raw) {
  const s = (raw || '').trim();
  if (!s) return { error: null };

  // Spotify URI: spotify:album:<id>
  const spotifyUri = s.match(/^spotify:album:([a-zA-Z0-9]+)$/);
  if (spotifyUri) return { url: `https://open.spotify.com/album/${spotifyUri[1]}`, service: 'spotify' };

  // Spotify non-album URIs
  if (/^spotify:artist:/.test(s))              return { error: "That's an artist link — paste an album link instead" };
  if (/^spotify:track:/.test(s))               return { error: "That's a track link — paste the album link instead" };
  if (/^spotify:playlist:/.test(s))            return { error: "That's a playlist — paste an album link instead" };
  if (/^spotify:(show|episode|user):/.test(s)) return { error: "Paste a Spotify album link or URI" };
  if (/^spotify:/.test(s))                     return { error: "Couldn't find an album in that Spotify link" };

  // Bare 22-char Spotify album ID
  if (/^[a-zA-Z0-9]{22}$/.test(s)) return { url: `https://open.spotify.com/album/${s}`, service: 'spotify' };

  // A shared string can carry more than the link itself — e.g. the Spotify
  // app's "Share" sheet fills the Web Share `text` field with
  // "<Title> by <Artist> <url>", not the bare URL. Pull the first http(s) URL
  // out of it before falling through to "unsupported"; this is a no-op when
  // `s` is already a bare URL (it already matches ^https?:// below).
  // Known limitation: takes the FIRST URL found and doesn't disambiguate if
  // the text happens to contain more than one — fine for every share shape
  // seen in practice (one link per share), but a text with two URLs could
  // pick the wrong one silently.
  let candidate = s;
  if (!/^https?:\/\//.test(candidate)) {
    const embedded = candidate.match(/https?:\/\/\S+/);
    // Trailing punctuation a sentence would add around the link ("...xyz.", "(xyz)").
    if (embedded) candidate = embedded[0].replace(/[.,;:)\]"'!?]+$/, '');
  }

  if (!/^https?:\/\//.test(candidate))
    return { error: `Paste an album link from ${SUPPORTED()}` };

  let host, pathname;
  try {
    const parsed = new URL(candidate);
    host = parsed.hostname.replace(/^www\./, '');
    pathname = parsed.pathname;
  } catch { return { error: `Paste an album link from ${SUPPORTED()}` }; }

  // Blocked sources (not in the service registry)
  if (host.includes('bandcamp.com'))
    return { error: `Bandcamp isn't supported yet — paste a link from ${SUPPORTED()}` };
  if (host.includes('discogs.com'))
    return { error: `Discogs isn't supported yet — paste a link from ${SUPPORTED()}` };
  if (host === 'youtu.be')
    return { error: "That's a track — paste a YouTube playlist link for an album" };
  // Amazon Music and SoundCloud album pages are pure client-rendered JS shells
  // with no server-rendered metadata (verified — no og:/JSON-LD, and
  // SoundCloud's oEmbed endpoint 404s), so the resolver has no way to read
  // them. A named reason beats the generic "site isn't supported" below.
  if (host.includes('music.amazon.'))
    return { error: `Amazon Music links can't be read automatically — paste a link from ${SUPPORTED()}` };
  if (host === 'soundcloud.com')
    return { error: `SoundCloud links can't be read automatically — paste a link from ${SUPPORTED()}` };

  // Registry lookup — covers all supported services
  const svc = findServiceByHost(host);
  if (svc) {
    // A short link's destination can't be checked client-side — pass it
    // through as-is and let the resolver's redirect-following extractor
    // decide whether it's actually an album. Some short links share their
    // host with normal links (e.g. Spotify's /s/<code>), hence the separate
    // path-based check alongside the host-based one.
    if (isShortLinkHost(host) || isShortLinkPath(svc, pathname) || svc.albumMatch(candidate)) {
      return { url: candidate, service: svc.slug };
    }
    return { error: svc.nonAlbumError(candidate) || `Paste an album link from ${SUPPORTED()}` };
  }

  return { error: `That site isn't supported — paste an album link from ${SUPPORTED()}` };
}

export function makePendingRecord(url, service) {
  return {
    id:        'pending:' + url,
    sourceUrl: url,
    service,
    title:     null,
    artist:    null,
    cover:     null,
    year:      null,
    tags:      [],
    addedAt:   new Date().toISOString(),
    links:     {},
    _pending:  true,
  };
}

export function isRetryableResolveError(err) {
  if (err === 'network') return true;
  if (err === 429) return true;
  if (typeof err === 'number' && err >= 500) return true;
  return false;
}

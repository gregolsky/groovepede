import { STORAGE_KEY, DONE_KEY, PREF_SERVICE_KEY } from './config.js';
import { SERVICES, findServiceByHost, serviceListText } from './services.js';

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

export function loadAlbums()  { try { return (JSON.parse(localStorage.getItem(STORAGE_KEY)) || []).map(upgradeAlbumRecord); } catch { return []; } }
export function saveAlbums(a) { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); }
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

// Bare Spotify album ID for Web API calls. album.id is a resolver-assigned
// id (e.g. "spotify:<id>", or "SPOTIFY_ALBUM::<id>" on records resolved
// before the Odesli-proxy era), so it can't be passed to /v1/albums/<id>
// directly — derive it from the resolved Spotify link instead.
export function spotifyAlbumId(album) {
  const url = album?.links?.spotify?.url;
  return url ? extractAlbumId(url) : null;
}

export function serializeBackup(albums, done) {
  // Persist the full album record (snapshot), stripping only transient flags.
  // Cover art URL, links, tags, and firstTrackUri are all included so import
  // is instant — no re-resolution needed.
  const full = albums.map(({ _pending, _error, ...a }) => a);
  return JSON.stringify({ version: 4, exportedAt: new Date().toISOString(), albums: full, done });
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || ![1, 2, 3, 4].includes(data.version) || !Array.isArray(data.albums) || typeof data.done !== 'number') {
    throw new Error('Invalid backup format');
  }

  const albums = data.albums.map(album => {
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

  return { albums, done: data.done };
}

/**
 * Merge a fresh resolve result into an existing album record.
 * Overwrites title/artist/cover/year/links; preserves id, sourceUrl,
 * addedAt, tags, and firstTrackUri (those are enriched separately).
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

  if (!/^https?:\/\//.test(s))
    return { error: `Paste an album link from ${SUPPORTED()}` };

  let host;
  try { host = new URL(s).hostname.replace(/^www\./, ''); }
  catch { return { error: `Paste an album link from ${SUPPORTED()}` }; }

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
    if (svc.albumMatch(s)) return { url: s, service: svc.slug };
    return { error: svc.nonAlbumError(s) || `Paste an album link from ${SUPPORTED()}` };
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

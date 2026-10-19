/**
 * The album record: its shape across eras (migration, canonical ids), how a
 * resolve result folds into one, and the queue-level rules that only need the
 * records themselves. Pure — no storage, no network, no DOM.
 */
import { normalizeTags } from './tags.js';

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
 * Bring stored records up to the current shape: the v1 links upgrade,
 * canonical tags, a canonical id, and — since canonical ids can reveal
 * duplicates saved under different eras' ids — one record per album (the
 * earliest-saved one wins).
 * Runs on every read; the result is persisted by the next write.
 */
export function normalizeAlbums(raw) {
  const seen = new Set();
  const out = [];
  for (const rec of raw.map(upgradeAlbumRecord)) {
    const id = canonicalAlbumId(rec.id);
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    // Queues saved before resolver genres were canonicalized hold "Rock" next
    // to Last.fm's "rock"; fold them here so they collapse on the next write.
    const tags = Array.isArray(rec.tags) ? normalizeTags(rec.tags) : rec.tags;
    const tagsChanged = Array.isArray(rec.tags) && (tags.length !== rec.tags.length || tags.some((t, i) => t !== rec.tags[i]));
    out.push(id === rec.id && !tagsChanged ? rec : { ...rec, id, tags });
  }
  return out;
}

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

// 4-digit years and decades ("1990", "1990s") don't count as genre tags.
const YEAR_ONLY = /^\d{4}s?$/;

const TAG_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether boot should (re-)run Last.fm enrichment for this album: it has no
 * genre tags yet, and Last.fm hasn't been asked about it in the last 30 days.
 * Without the second condition, every album Last.fm knows nothing about cost
 * three-plus throttled lookups on every single app launch.
 * `tagsCheckedAt` can come from an imported backup — an unparseable value
 * just counts as never checked.
 */
export function needsTagEnrichment(album, now = Date.now()) {
  if (!album.artist || !album.title) return false;
  if ((album.tags || []).some(t => !YEAR_ONLY.test(t))) return false;
  // NaN (missing/garbage) and future stamps both fail the first comparison.
  const checkedAt = Date.parse(album.tagsCheckedAt);
  const recentlyChecked = checkedAt <= now && now - checkedAt < TAG_RECHECK_MS;
  return !recentlyChecked;
}

export function isRetryableResolveError(err) {
  if (err === 'network') return true;
  if (err === 429) return true;
  if (typeof err === 'number' && err >= 500) return true;
  return false;
}

/** The first-credited artist of a "A, B" credit — what Last.fm/Deezer/TheAudioDB know. */
export const primaryArtistOf = name => (name || '').split(',')[0].trim();

/** Deezer's numeric album id out of a links.deezer url, or null. */
export function deezerAlbumId(album) {
  const url = album?.links?.deezer?.url;
  return url ? (url.match(/\/album\/(\d+)/)?.[1] || null) : null;
}

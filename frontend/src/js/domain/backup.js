/**
 * The backup file format: export, and the validated import of untrusted JSON.
 * Pure — app code does the file picking/downloading and the saving.
 */
import { isWebUrl, isSafeLinkUrl } from './music-services.js';
import { upgradeAlbumRecord, normalizeAlbums, makePendingRecord } from './albums.js';
import { parseMusicLink } from './links.js';

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

  // A record with no usable metadata is re-resolved from its link.
  const pendingStub = (sourceUrl, service, addedAt) => {
    const stub = makePendingRecord(sourceUrl, service || parseMusicLink(sourceUrl).service || 'spotify');
    stub.addedAt = addedAt || stub.addedAt;
    return stub;
  };

  const albums = data.albums.map(sanitizeRecord).filter(Boolean).map(album => {
    if (data.version === 3) {
      // Legacy lean export (v3): only sourceUrl/service/addedAt; must re-resolve.
      return album.sourceUrl ? pendingStub(album.sourceUrl, album.service, album.addedAt) : null;
    }

    // v1 / v2 / v4: carry metadata — restore directly, no resolve needed.
    const upgraded = upgradeAlbumRecord(album); // normalises links.spotify for v1/v2
    if (!upgraded.sourceUrl) return null;

    if (upgraded.title && upgraded.artist) {
      // Full record: return as-is (non-pending); preserve addedAt from backup.
      const { _pending, _error, ...clean } = upgraded;
      return { ...clean, addedAt: album.addedAt || clean.addedAt };
    }

    // Metadata absent (sparse legacy entry) — fall back to pending stub.
    return pendingStub(upgraded.sourceUrl, upgraded.service, album.addedAt);
  }).filter(Boolean);

  return { albums: normalizeAlbums(albums), done: data.done };
}

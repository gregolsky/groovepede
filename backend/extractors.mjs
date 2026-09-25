/**
 * Which pasted URLs the resolver accepts (the host allowlist) and how each
 * service's album page — or free keyless API — is turned into
 * { serviceAlbumId, title, artist, cover, year, tags }.
 */

import { DEEZER_BASE, ITUNES_BASE, UpstreamFetchError, fetchUpstream, resolveRedirect } from './upstream.mjs';

// ── Input allowlist (SSRF hygiene) ──────────────────────────────────────────
// Hosts we are willing to fetch on the paste-er's behalf, mapped straight to
// the internal service slug — also doubles as "which extractor to run".
// Amazon Music and SoundCloud are deliberately absent: both album pages are
// pure client-rendered JS shells with no og:/JSON-LD server-rendered at all
// (verified live), and SoundCloud's oEmbed endpoint 404s outright — nothing
// here could ever extract metadata from either, so neither is in the registry.

export const SERVICE_HOSTS = new Map([
  ['open.spotify.com',   'spotify'],
  // Spotify's own share-sheet short links (the "Share" button in the mobile
  // app produces these, not an open.spotify.com URL) — extractSpotify follows
  // the redirect before doing anything else.
  ['spotify.link',       'spotify'],
  ['spotify.app.link',   'spotify'],
  ['music.apple.com',    'apple'],
  ['deezer.com',         'deezer'],
  ['www.deezer.com',     'deezer'],
  ['tidal.com',          'tidal'],
  ['listen.tidal.com',   'tidal'],
  ['music.youtube.com',  'youtube'],
  ['youtube.com',        'youtube'],
  ['www.youtube.com',    'youtube'],
  ['pandora.com',        'pandora'],
  ['www.pandora.com',    'pandora'],
]);

/** Resolve a URL's hostname to a service slug, trying the www-stripped form too. */
export function serviceForHost(hostname) {
  return SERVICE_HOSTS.get(hostname) || SERVICE_HOSTS.get(hostname.replace(/^www\./, '')) || null;
}

/**
 * Strip tracking params (si=, utm_*) while preserving service-specific params.
 * Returns the normalised URL string used as the cache key.
 */
export function normalizeUrl(rawUrl) {
  const u = new URL(rawUrl);
  for (const k of [...u.searchParams.keys()]) {
    if (k === 'si' || k.startsWith('utm_')) u.searchParams.delete(k);
  }
  return u.toString();
}

// ── Per-service metadata extraction ─────────────────────────────────────────
// Each extractor takes the parsed album URL and returns either:
//   - { serviceAlbumId, title, artist, cover, year, tags } on success
//   - null when the fetch succeeded but the page/response didn't look like an
//     album (markup changed, or it wasn't actually an album URL) — non-retryable
// A failed *fetch* (network/timeout/non-2xx) throws UpstreamFetchError instead,
// which the caller treats as retryable.

function metaTag(html, prop) {
  // Tolerant of attribute order and single/double quotes — property/content
  // can appear in either order in the wild. The quote character is captured
  // and back-referenced so an unescaped apostrophe/quote inside the content
  // (e.g. "Guns N' Roses") can't prematurely close the match.
  let m = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${prop}["'][^>]*content=(["'])(.*?)\\1`, 'i'));
  if (m) return decodeHtmlEntities(m[2]);
  m = html.match(new RegExp(`<meta[^>]*content=(["'])(.*?)\\1[^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decodeHtmlEntities(m[2]) : null;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // must decode last — otherwise "&amp;quot;" double-decodes to a literal quote
}

async function extractSpotify(urlObj, fetchImpl) {
  // Spotify's mobile-app "Share" sheet hands out short codes instead of a
  // direct open.spotify.com/album/<id> URL, in one of three shapes (all
  // confirmed live): the spotify.link/spotify.app.link hosts, or — same host
  // as a normal album link, so only the PATH gives it away —
  // open.spotify.com/s/<code> (redirects with a relative Location, e.g.
  // "/album/<id>?si=..."). Resolve the redirect first so the rest of this
  // function always deals with a real album URL.
  const host = urlObj.hostname.replace(/^www\./, '');
  const isShortLink = host !== 'open.spotify.com' || /^\/s\//.test(urlObj.pathname);
  let target = urlObj;
  if (isShortLink) {
    // UpstreamFetchError propagates as-is (same as every other fetchUpstream
    // call in this file) — the caller (albumRequest) already distinguishes
    // retryable network/5xx failures from permanent ones. A malformed
    // Location header throws a plain Error instead, which albumRequest's
    // catch-all treats as a failed (non-retryable) extraction.
    const finalUrl = await resolveRedirect(urlObj.toString(), fetchImpl);
    target = new URL(finalUrl);
    // The short link can point at anything Spotify shares (a track, artist,
    // playlist, podcast episode) — only a real album page is extractable.
    if (target.hostname.replace(/^www\./, '') !== 'open.spotify.com') return null;
  }
  const id = target.pathname.match(/\/album\/([A-Za-z0-9]+)/)?.[1];
  if (!id) return null;
  // The main open.spotify.com page is a bare client-rendered shell (verified
  // live — no title, no og: tags beyond og:site_name). The /embed variant is
  // server-rendered with a Next.js __NEXT_DATA__ blob carrying the full entity.
  const text = await fetchUpstream(`https://open.spotify.com/embed/album/${id}`, fetchImpl);
  const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let entity;
  try { entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity; } catch { return null; }
  if (!entity?.title) return null;
  const images = entity.visualIdentity?.image || [];
  const cover  = images.slice().sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0]?.url || null;
  const year   = typeof entity.releaseDate === 'string' ? entity.releaseDate.slice(0, 4) : null;
  return {
    serviceAlbumId: id,
    title:  entity.title || null,
    artist: entity.subtitle || null,
    cover,
    year:   year || null,
    tags:   [],
    // Only set when the pasted URL was a short link — tells albumRequest to
    // store the real album link instead of the (opaque, expiring) short code.
    ...(isShortLink ? { canonicalUrl: `https://open.spotify.com/album/${id}` } : {}),
  };
}

async function extractApple(urlObj, fetchImpl) {
  // Apple album URLs can carry more than one numeric segment (e.g. a track
  // anchor "?i=123" alongside the album id, or a numeric album title like
  // "/album/1984/..."). The album id is always the LAST numeric path segment.
  const matches = [...urlObj.pathname.matchAll(/\/(\d+)(?=\/|$)/g)];
  const id = matches.length ? matches[matches.length - 1][1] : null;
  if (!id) return null;
  const text = await fetchUpstream(`${ITUNES_BASE}/lookup?id=${id}&entity=album`, fetchImpl);
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  // Validate the lookup actually returned the id we asked for — iTunes'
  // /lookup can return unrelated results when the id doesn't match an album.
  const item = (data?.results || []).find(r =>
    r.wrapperType === 'collection' && r.collectionType === 'Album' && String(r.collectionId) === id);
  if (!item?.collectionName) return null;
  const cover = item.artworkUrl100 ? item.artworkUrl100.replace(/\d+x\d+bb\.(jpg|png)$/, '600x600bb.$1') : null;
  return {
    serviceAlbumId: id,
    title:  item.collectionName || null,
    artist: item.artistName || null,
    cover,
    year:   item.releaseDate ? item.releaseDate.slice(0, 4) : null,
    tags:   item.primaryGenreName ? [item.primaryGenreName] : [],
  };
}

async function extractDeezer(urlObj, fetchImpl) {
  const id = urlObj.pathname.match(/\/album\/(\d+)/)?.[1];
  if (!id) return null;
  const text = await fetchUpstream(`${DEEZER_BASE}/album/${id}`, fetchImpl);
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data?.error) {
    // Deezer reports quota-exceeded as an HTTP-200 envelope (error.code === 4),
    // not a real 429 — treat it as retryable rather than "this isn't an album".
    if (data.error.code === 4) throw new UpstreamFetchError(429);
    return null;
  }
  if (!data?.title) return null;
  return {
    serviceAlbumId: id,
    title:  data.title || null,
    artist: data.artist?.name || null,
    cover:  data.cover_xl || data.cover_big || null,
    year:   data.release_date ? data.release_date.slice(0, 4) : null,
    tags:   (data.genres?.data || []).map(g => g.name).filter(Boolean),
  };
}

async function extractTidal(urlObj, fetchImpl) {
  const id   = urlObj.pathname.match(/\/album\/(\d+)/)?.[1] || null;
  const text = await fetchUpstream(urlObj.toString(), fetchImpl);
  const ogTitle = metaTag(text, 'og:title');
  if (!ogTitle) return null;
  // Observed live: "<Artist> - <Album>". Split on the first " - " only, since
  // either half can itself legitimately contain a hyphen.
  const sep = ogTitle.indexOf(' - ');
  return {
    serviceAlbumId: id,
    title:  (sep > -1 ? ogTitle.slice(sep + 3) : ogTitle).trim() || null,
    artist: sep > -1 ? ogTitle.slice(0, sep).trim() : null,
    cover:  metaTag(text, 'og:image'),
    year:   null,
    tags:   [],
  };
}

async function extractYoutube(urlObj, fetchImpl) {
  const text = await fetchUpstream(`https://www.youtube.com/oembed?url=${encodeURIComponent(urlObj.toString())}&format=json`, fetchImpl);
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data?.title) return null;
  // Auto-generated "topic" channels (the common case for an album playlist)
  // suffix the artist name with " - Topic" — not part of the artist's name.
  const artist = (data.author_name || '').replace(/\s*-\s*Topic$/i, '').trim() || null;
  return {
    serviceAlbumId: urlObj.searchParams.get('list') || urlObj.pathname.match(/\/browse\/([\w-]+)/)?.[1] || null,
    title:  data.title || null,
    artist,
    cover:  data.thumbnail_url || null,
    year:   null,
    tags:   [],
  };
}

async function extractPandora(urlObj, fetchImpl) {
  const text = await fetchUpstream(urlObj.toString(), fetchImpl);
  const ogTitle = metaTag(text, 'og:title');
  if (!ogTitle) return null;
  // UNVERIFIED — Pandora is US-geofenced and every probe from a non-US host
  // during development came back geo-blocked, so this pattern ("<Title> by
  // <Artist>", the shape Pandora's own og:title used historically) could not
  // be confirmed against a live page. Falls through to a title-only record
  // rather than guessing at an artist split that might be wrong. If Pandora
  // never actually extracts in production (the Pi itself may face the same
  // geo-block), that's a real gap — see the production smoke suite.
  const m = ogTitle.match(/^(.*)\s+by\s+(.*)$/i);
  return {
    serviceAlbumId: null,
    title:  (m ? m[1] : ogTitle).trim() || null,
    artist: m ? m[2].trim() : null,
    cover:  metaTag(text, 'og:image'),
    year:   null,
    tags:   [],
  };
}

// Exported (not just internal) so a test can assert every SERVICE_HOSTS value
// has a matching entry here — catches drift automatically if a host is added
// without its extractor, or vice versa.
export const EXTRACTORS = {
  spotify: extractSpotify,
  apple:   extractApple,
  deezer:  extractDeezer,
  tidal:   extractTidal,
  youtube: extractYoutube,
  pandora: extractPandora,
};

export function slugFromPath(pathname) {
  return pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'unknown';
}

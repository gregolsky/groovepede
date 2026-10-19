/**
 * Pasted/shared text → a supported album link (or a user-facing reason it
 * isn't one). Pure; the per-service rules come from the registry in services.js.
 */
import { findServiceByHost, isShortLinkHost, isShortLinkPath, serviceListText } from './music-services.js';

// "Spotify, Apple Music, … or SoundCloud" — every service the parser accepts,
// derived from the registry so an unsupported-link error can never advertise a
// shorter list than parseMusicLink actually handles.
const SUPPORTED = () => serviceListText({ conj: 'or' });

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

// Central registry for all supported music services.
// SERVICE_LABELS and the per-host album-matching rules in parseMusicLink are
// all derived from this single list — add a service here and it flows through
// everywhere automatically.
//
// Amazon Music and SoundCloud are NOT here. Both album pages turned out to be
// pure client-rendered JS shells with no server-rendered metadata at all
// (verified live — no og: tags, no JSON-LD, and SoundCloud's oEmbed endpoint
// 404s outright), so the resolver has no way to extract a title/artist from
// either and neither can be supported. See backend/resolver-core.mjs.
//
// `searchUrl(artist, title)` builds a search-results link, used when an album
// doesn't have an exact cross-service link (see pickListenTarget in render.js)
// — these are best-effort search pages, not guaranteed to land on the right
// result, which is why the Listen button labels them "Find on X" rather than
// "Listen".

const q = (s) => encodeURIComponent(s || '');

export const SERVICES = [
  {
    slug: 'spotify',
    label: 'Spotify',
    hosts: ['open.spotify.com'],
    albumMatch: (url) => /\/album\//.test(url),
    nonAlbumError: (url) => {
      if (/\/artist\//.test(url))        return "That's an artist link — paste an album link instead";
      if (/\/track\//.test(url))         return "That's a track link — paste the album link instead";
      if (/\/playlist\//.test(url))      return "That's a playlist — paste an album link instead";
      if (/\/(show|episode)\//.test(url)) return "That's a podcast — paste an album link instead";
      return "Couldn't find an album in that Spotify link";
    },
    searchUrl: (artist, title) => `https://open.spotify.com/search/${q(`${artist} ${title}`)}/albums`,
  },
  {
    slug: 'apple',
    label: 'Apple Music',
    hosts: ['music.apple.com'],
    albumMatch: (url) => /\/album\//.test(url) && !/[?&]i=/.test(url),
    nonAlbumError: (url) => {
      if (/\/album\//.test(url) && /[?&]i=/.test(url)) return "That's a track — paste the album link instead";
      if (/\/artist\//.test(url))   return "That's an artist link — paste an album link instead";
      if (/\/playlist\//.test(url)) return "That's a playlist — paste an album link instead";
      return "Couldn't find an album in that Apple Music link";
    },
    searchUrl: (artist, title) => `https://music.apple.com/us/search?term=${q(`${artist} ${title}`)}`,
  },
  {
    slug: 'youtube',
    label: 'YouTube Music',
    hosts: ['music.youtube.com', 'youtube.com'],
    // Any YouTube URL is valid EXCEPT /watch (which is a single track)
    albumMatch: (url) => !/\/watch/.test(url),
    nonAlbumError: () => "That's a track — paste a YouTube playlist link for an album",
    searchUrl: (artist, title) => `https://music.youtube.com/search?q=${q(`${artist} ${title}`)}`,
  },
  {
    slug: 'deezer',
    label: 'Deezer',
    hosts: ['deezer.com'],
    albumMatch: (url) => /\/album\//.test(url),
    nonAlbumError: () => null,
    searchUrl: (artist, title) => `https://www.deezer.com/search/${q(`${artist} ${title}`)}`,
  },
  {
    slug: 'tidal',
    label: 'Tidal',
    hosts: ['tidal.com', 'listen.tidal.com'],
    albumMatch: (url) => /\/album\//.test(url),
    nonAlbumError: () => null,
    searchUrl: (artist, title) => `https://tidal.com/search?q=${q(`${artist} ${title}`)}`,
  },
  {
    slug: 'pandora',
    label: 'Pandora',
    hosts: ['pandora.com'],
    // Pandora album URLs never contain literal "/album/" — the real shape,
    // confirmed live, is /artist/<artist-slug>/<album-slug>/AL<id>
    // (e.g. /artist/daft-punk/discovery/ALnj5w9vqJX7gvZ). The AL id prefix
    // is what actually distinguishes an album from an artist page
    // (/artist/<slug>) or a track page (…/TR<id>).
    albumMatch: (url) => /\/artist\/[^/]+\/[^/]+\/AL/i.test(url),
    nonAlbumError: () => null,
    searchUrl: (artist, title) => `https://www.pandora.com/search/${q(`${artist} ${title}`)}`,
  },
];

// hostname → descriptor (e.g. 'open.spotify.com' → spotify descriptor)
const _BY_HOST = new Map();
for (const svc of SERVICES) {
  for (const host of svc.hosts) _BY_HOST.set(host, svc);
}

/** Find a service descriptor by the (www-stripped) hostname of a URL. */
export function findServiceByHost(host) {
  return _BY_HOST.get(host) || null;
}

export function serviceLabel(slug) {
  const svc = SERVICES.find(s => s.slug === slug);
  return svc ? svc.label : '';
}

/** Every supported service's display name, in registry order. */
export function serviceNames() {
  return SERVICES.map(s => s.label);
}

/**
 * The supported-service list as prose, for UI copy and error messages.
 *
 * Exists so the list is written down ONCE. It used to be hardcoded in eight
 * places that all disagreed — three services were advertised nowhere outside
 * the FAQ, and error messages named five while parsing accepted eight.
 *
 * NOTE: static markup can't call this. When adding a service, also update the
 * "Which services work?" answer in src/faq.html (both the <details> copy and
 * the FAQPage JSON-LD) and the meta descriptions in src/index.html.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.max]   cap the names shown; the rest become "and N more"
 * @param {string}  [opts.sep]   separator between names
 * @param {string}  [opts.conj]  final conjunction ('and', 'or'); '' to plain-join
 */
export function serviceListText({ max = 0, sep = ', ', conj = 'and' } = {}) {
  const names = serviceNames();

  // The "and N more" tail already reads as the conjunction, so plain-join it.
  if (max > 0 && names.length > max) {
    return [...names.slice(0, max), `and ${names.length - max} more`].join(sep);
  }
  return joinList(names, { sep, conj });
}

/**
 * "A" · "A and B" · "A, B, and C" — Oxford comma, configurable conjunction.
 * Used for any human-readable list of service names, including the subset of
 * services a single album happens to have links for.
 */
export function joinList(items, { sep = ', ', conj = 'and' } = {}) {
  if (!conj || items.length < 2) return items.join(sep);
  if (items.length === 2) return items.join(` ${conj} `);
  return items.slice(0, -1).join(sep) + `${sep}${conj} ` + items[items.length - 1];
}

/**
 * Best-effort search-results link for a service the album has no exact link
 * for. Returns null for an unregistered slug — callers treat that the same as
 * "no link at all" rather than opening a broken URL.
 */
export function buildSearchUrl(slug, artist, title) {
  const svc = SERVICES.find(s => s.slug === slug);
  return svc ? svc.searchUrl(artist, title) : null;
}

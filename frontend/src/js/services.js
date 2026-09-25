// Central registry for all supported music services.
// SERVICE_LABELS and the per-host album-matching rules in parseMusicLink are
// all derived from this single list — add a service here and it flows through
// everywhere automatically.
//
// Amazon Music and SoundCloud are NOT here. Both album pages turned out to be
// pure client-rendered JS shells with no server-rendered metadata at all
// (verified live — no og: tags, no JSON-LD, and SoundCloud's oEmbed endpoint
// 404s outright), so the resolver has no way to extract a title/artist from
// either and neither can be supported. See backend/extractors.mjs.
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
    // The mobile app's "Share" sheet hands out one of these short codes
    // instead of an open.spotify.com URL. What it points to can't be told
    // client-side (that needs following an HTTP redirect) — isShortLinkHost
    // makes parseMusicLink skip albumMatch for these and defer to the
    // resolver, whose extractSpotify (backend/extractors.mjs) follows the
    // redirect and rejects anything that isn't an album.
    shortLinkHosts: ['spotify.link', 'spotify.app.link'],
    // A THIRD short-link shape, confirmed live: the "Share" sheet's
    // "native-share-menu" path also hands out open.spotify.com/s/<code> —
    // same host as a normal album link, so shortLinkHosts can't catch it;
    // only the PATH marks it as a redirect. See isShortLinkPath.
    shortLinkPaths: [/^\/s\//],
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
// Hosts whose URL alone can't tell you what it points to (short links) —
// parseMusicLink skips albumMatch for these and lets the resolver decide.
const _SHORT_LINK_HOSTS = new Set();
for (const svc of SERVICES) {
  for (const host of svc.hosts) _BY_HOST.set(host, svc);
  for (const host of svc.shortLinkHosts || []) {
    _BY_HOST.set(host, svc);
    _SHORT_LINK_HOSTS.add(host);
  }
}

/** Find a service descriptor by the (www-stripped) hostname of a URL. */
export function findServiceByHost(host) {
  return _BY_HOST.get(host) || null;
}

/** True when `host` is a short-link host (see SERVICES[].shortLinkHosts). */
export function isShortLinkHost(host) {
  return _SHORT_LINK_HOSTS.has(host);
}

/** True for an http(s) URL — the only scheme a cover image or a pasted link may use. */
export function isWebUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v);
}

/**
 * True for a URL the Listen button may open: http(s), or a spotify: deep link
 * (the only native URI the resolver ever produces). Anything else — notably
 * javascript: and data:, which window.open would happily run — is refused.
 */
export function isSafeLinkUrl(v) {
  return isWebUrl(v) || (typeof v === 'string' && /^spotify:/i.test(v));
}

/**
 * True when `pathname` matches one of `svc`'s shortLinkPaths — a short link
 * that shares its host with normal links for the service (so isShortLinkHost
 * can't catch it) and is only distinguishable by path shape, e.g. Spotify's
 * open.spotify.com/s/<code> alongside a normal open.spotify.com/album/<id>.
 */
export function isShortLinkPath(svc, pathname) {
  return (svc?.shortLinkPaths || []).some(re => re.test(pathname));
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

// ── Choosing the link to open ─────────────────────────────────────────────────

/**
 * The link the Listen button will actually open, together with the service it
 * belongs to. The service matters for the label: when the album isn't on the
 * user's preferred service the button names the one it will open instead,
 * rather than silently sending them somewhere unexpected.
 *
 * Exact links (from the resolver — a real album page) always win over a
 * search link (a best-effort "search this service" URL built client-side from
 * artist+title, for a service the resolver couldn't cross-link to). `exact`
 * tells the caller which kind it got, since a search result isn't guaranteed
 * to be the right album the way an exact link is.
 *
 * @returns {{ url: string|null, service: string|null, exact: boolean }}
 *   service is null only when falling back to a pasted URL of unknown service.
 */
export function pickListenTarget(album, prefService) {
  const links = album.links || {};

  // 1. preferred service, exact — nativeUri then web url
  if (links[prefService]?.nativeUri) return { url: links[prefService].nativeUri, service: prefService, exact: true };
  if (links[prefService]?.url)       return { url: links[prefService].url,       service: prefService, exact: true };

  // 2. any service, exact — nativeUri then web url
  for (const [slug, entry] of Object.entries(links)) {
    if (entry?.nativeUri) return { url: entry.nativeUri, service: slug, exact: true };
  }
  for (const [slug, entry] of Object.entries(links)) {
    if (entry?.url) return { url: entry.url, service: slug, exact: true };
  }

  // 3. no exact cross-service link at all — the exact URL the user originally
  // pasted still beats a search fallback (an exact link they know is right
  // outranks a guess), so check it before ever reaching the search tiers.
  if (Object.keys(links).length === 0 && album.sourceUrl) {
    return { url: album.sourceUrl, service: album.service || null, exact: true };
  }

  // 4 & 5. search fallback — only meaningful once artist+title are actually
  // known (a pending/sparse record has nothing worth searching for).
  if (album.artist && album.title) {
    const prefSearch = buildSearchUrl(prefService, album.artist, album.title);
    if (prefSearch) return { url: prefSearch, service: prefService, exact: false };

    // prefService isn't in the registry — e.g. a preference saved before
    // Amazon Music/SoundCloud were dropped. Fall back to a known-good service
    // rather than giving up on a search link entirely.
    const fallback = SERVICES[0].slug;
    const anySearch = buildSearchUrl(fallback, album.artist, album.title);
    if (anySearch) return { url: anySearch, service: fallback, exact: false };
  }

  // 6. last resort — the link the user originally pasted (links is non-empty
  // here, just missing a usable url/nativeUri on every entry — vanishingly
  // rare, but the source link is still the right thing to fall back to)
  return { url: album.sourceUrl || null, service: album.sourceUrl ? (album.service || null) : null, exact: true };
}

export function pickListenUrl(album, prefService) {
  return pickListenTarget(album, prefService).url;
}

/** Display names of every service this album has a usable link for. */
export function linkedServiceNames(album) {
  return Object.entries(album.links || {})
    .filter(([, e]) => e?.url || e?.nativeUri)
    .map(([slug]) => serviceLabel(slug) || slug);
}

/**
 * True when the album has a usable link (url or nativeUri) for the preferred
 * service. Used to decide whether to show the Listen button as enabled or
 * disabled (with an X) — avoids silently opening a different service.
 */
export function isOnPreferredService(album, prefService) {
  const e = album.links?.[prefService];
  return !!(e && (e.url || e.nativeUri));
}

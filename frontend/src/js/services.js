// Central registry for all supported music services.
// ODESLI_KEY_MAP, SERVICE_LABELS, and the per-host album-matching rules in
// parseMusicLink are all derived from this single list — add a service here
// and it flows through everywhere automatically.

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
    odesliKeys: ['spotify'],
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
    odesliKeys: ['appleMusic'],
  },
  {
    slug: 'youtube',
    label: 'YouTube Music',
    hosts: ['music.youtube.com', 'youtube.com'],
    // Any YouTube URL is valid EXCEPT /watch (which is a single track)
    albumMatch: (url) => !/\/watch/.test(url),
    nonAlbumError: () => "That's a track — paste a YouTube playlist link for an album",
    odesliKeys: ['youtube', 'youtubeMusic'],
  },
  {
    slug: 'deezer',
    label: 'Deezer',
    hosts: ['deezer.com'],
    albumMatch: (url) => /\/album\//.test(url),
    nonAlbumError: () => null,
    odesliKeys: ['deezer'],
  },
  {
    slug: 'tidal',
    label: 'Tidal',
    hosts: ['tidal.com', 'listen.tidal.com'],
    albumMatch: (url) => /\/album\//.test(url),
    nonAlbumError: () => null,
    odesliKeys: ['tidal'],
  },
  {
    slug: 'amazon',
    label: 'Amazon Music',
    hosts: ['music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de', 'music.amazon.fr', 'music.amazon.co.jp'],
    albumMatch: (url) => /\/albums\//.test(url),
    nonAlbumError: () => null,
    odesliKeys: ['amazonMusic'],
  },
  {
    slug: 'pandora',
    label: 'Pandora',
    hosts: ['pandora.com'],
    albumMatch: (url) => /\/album\//.test(url),
    nonAlbumError: () => null,
    odesliKeys: ['pandora'],
  },
  {
    slug: 'soundcloud',
    label: 'SoundCloud',
    hosts: ['soundcloud.com'],
    albumMatch: (url) => /\/sets\//.test(url),
    nonAlbumError: () => null,
    odesliKeys: ['soundcloud'],
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

// Odesli linksByPlatform key → internal slug (e.g. 'appleMusic' → 'apple')
export const ODESLI_KEY_MAP = {};
for (const svc of SERVICES) {
  for (const key of svc.odesliKeys) {
    if (!(key in ODESLI_KEY_MAP)) ODESLI_KEY_MAP[key] = svc.slug;
  }
}

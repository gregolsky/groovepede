import { describe, it, expect } from 'vitest';
import { SERVICES, serviceNames, serviceListText, joinList, serviceLabel, findServiceByHost, buildSearchUrl, isWebUrl, isSafeLinkUrl, pickListenTarget, pickListenUrl, linkedServiceNames, isOnPreferredService } from './services.js';

describe('serviceNames', () => {
  it('returns every registered service label in registry order', () => {
    expect(serviceNames()).toEqual(SERVICES.map(s => s.label));
  });

  it('advertises every service the parser accepts (no service left unmentioned)', () => {
    // The whole point of the helper: parsing and copy can't drift apart.
    expect(serviceNames()).toHaveLength(SERVICES.length);
    expect(serviceNames()).toContain('Pandora');
    expect(serviceNames()).toContain('Tidal');
  });

  it('does not advertise Amazon Music or SoundCloud (neither is extractable)', () => {
    expect(serviceNames()).not.toContain('Amazon Music');
    expect(serviceNames()).not.toContain('SoundCloud');
  });
});

describe('serviceListText', () => {
  it('joins with an Oxford comma and "and" by default', () => {
    const text = serviceListText();
    expect(text.startsWith('Spotify, Apple Music, ')).toBe(true);
    expect(text).toContain(`, and ${serviceNames().at(-1)}`);
  });

  it('accepts an alternative conjunction for error messages', () => {
    expect(serviceListText({ conj: 'or' })).toContain(`, or ${serviceNames().at(-1)}`);
  });

  it('plain-joins when the conjunction is empty', () => {
    expect(serviceListText({ sep: ' · ', conj: '' })).toBe(serviceNames().join(' · '));
  });

  it('truncates to max and summarises the remainder', () => {
    const names = serviceNames();
    const text  = serviceListText({ max: 3, sep: ' · ' });
    expect(text).toBe(`${names[0]} · ${names[1]} · ${names[2]} · and ${names.length - 3} more`);
  });

  it('does not truncate when max is at or above the service count', () => {
    expect(serviceListText({ max: serviceNames().length })).not.toContain('more');
    expect(serviceListText({ max: 99 })).not.toContain('more');
  });

  it('summarises the remainder without a stray conjunction when capped at two', () => {
    const names = serviceNames();
    expect(serviceListText({ max: 2, sep: ', ' })).toBe(`${names[0]}, ${names[1]}, and ${names.length - 2} more`);
  });
});

describe('joinList', () => {
  it('returns a single item unchanged', () => {
    expect(joinList(['Tidal'])).toBe('Tidal');
  });
  it('joins two items with the conjunction only', () => {
    expect(joinList(['Tidal', 'Deezer'])).toBe('Tidal and Deezer');
  });
  it('uses an Oxford comma for three or more', () => {
    expect(joinList(['Tidal', 'Deezer', 'Pandora'])).toBe('Tidal, Deezer, and Pandora');
  });
  it('honours an alternative conjunction', () => {
    expect(joinList(['Tidal', 'Deezer'], { conj: 'or' })).toBe('Tidal or Deezer');
  });
  it('plain-joins when the conjunction is empty', () => {
    expect(joinList(['Tidal', 'Deezer'], { sep: ' · ', conj: '' })).toBe('Tidal · Deezer');
  });
  it('returns an empty string for an empty list', () => {
    expect(joinList([])).toBe('');
  });
});

describe('registry lookups', () => {
  it('maps hosts to their service', () => {
    expect(findServiceByHost('open.spotify.com')?.slug).toBe('spotify');
    expect(findServiceByHost('music.apple.com')?.slug).toBe('apple');
    expect(findServiceByHost('example.com')).toBe(null);
  });

  it('labels known slugs and returns empty for unknown ones', () => {
    expect(serviceLabel('tidal')).toBe('Tidal');
    expect(serviceLabel('nope')).toBe('');
    expect(serviceLabel('amazon')).toBe(''); // dropped from the registry
  });
});

describe('buildSearchUrl', () => {
  it('builds a search-results URL combining artist and title', () => {
    const url = buildSearchUrl('tidal', 'Electric Wizard', 'Dopethrone');
    expect(url).toContain('tidal.com');
    expect(url).toContain(encodeURIComponent('Electric Wizard Dopethrone'));
  });

  it('returns a distinct, plausible URL for every registered service', () => {
    for (const svc of SERVICES) {
      const url = buildSearchUrl(svc.slug, 'Radiohead', 'OK Computer');
      expect(url, `no search URL for "${svc.slug}"`).toBeTruthy();
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it('returns null for an unregistered slug', () => {
    expect(buildSearchUrl('amazon', 'Radiohead', 'OK Computer')).toBeNull();
    expect(buildSearchUrl('nope', 'Radiohead', 'OK Computer')).toBeNull();
  });
});

describe('isWebUrl / isSafeLinkUrl', () => {
  it('accepts http(s) for both', () => {
    for (const u of ['https://open.spotify.com/album/x', 'http://example.com/']) {
      expect(isWebUrl(u)).toBe(true);
      expect(isSafeLinkUrl(u)).toBe(true);
    }
  });
  it('accepts a spotify: deep link only as a link, not as a web URL', () => {
    expect(isSafeLinkUrl('spotify:album:abc')).toBe(true);
    expect(isWebUrl('spotify:album:abc')).toBe(false);
  });
  it('refuses script-capable and malformed values', () => {
    for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '', null, undefined, 42, {}]) {
      expect(isWebUrl(u)).toBe(false);
      expect(isSafeLinkUrl(u)).toBe(false);
    }
  });
});

// ── isOnPreferredService ──────────────────────────────────────────────────────

describe('isOnPreferredService', () => {
  it('returns true when preferred service has a url', () => {
    const album = { links: { spotify: { url: 'https://open.spotify.com/album/x', nativeUri: null } } };
    expect(isOnPreferredService(album, 'spotify')).toBe(true);
  });

  it('returns true when preferred service has a nativeUri only', () => {
    const album = { links: { spotify: { url: null, nativeUri: 'spotify:album:x' } } };
    expect(isOnPreferredService(album, 'spotify')).toBe(true);
  });

  it('returns true when preferred service has both url and nativeUri', () => {
    const album = { links: { spotify: { url: 'https://open.spotify.com/album/x', nativeUri: 'spotify:album:x' } } };
    expect(isOnPreferredService(album, 'spotify')).toBe(true);
  });

  it('returns false when preferred service is not in links (other services present)', () => {
    const album = {
      links: {
        apple: { url: 'https://music.apple.com/album/x', nativeUri: 'music://x' },
        deezer: { url: 'https://deezer.com/album/x', nativeUri: null },
      },
    };
    expect(isOnPreferredService(album, 'spotify')).toBe(false);
  });

  it('returns false when links object is empty', () => {
    expect(isOnPreferredService({ links: {} }, 'spotify')).toBe(false);
  });

  it('returns false when links is missing', () => {
    expect(isOnPreferredService({}, 'spotify')).toBe(false);
  });

  it('returns false when preferred entry has neither url nor nativeUri', () => {
    const album = { links: { spotify: { url: null, nativeUri: null } } };
    expect(isOnPreferredService(album, 'spotify')).toBe(false);
  });

  it('returns false when preferred entry exists but url is empty string', () => {
    const album = { links: { spotify: { url: '', nativeUri: '' } } };
    expect(isOnPreferredService(album, 'spotify')).toBe(false);
  });
});

// ── serviceLabel ──────────────────────────────────────────────────────────────

describe('serviceLabel', () => {
  it('returns Spotify for spotify', () => expect(serviceLabel('spotify')).toBe('Spotify'));
  it('returns Apple Music for apple', () => expect(serviceLabel('apple')).toBe('Apple Music'));
  it('returns YouTube Music for youtube', () => expect(serviceLabel('youtube')).toBe('YouTube Music'));
  it('returns Deezer for deezer', () => expect(serviceLabel('deezer')).toBe('Deezer'));
  it('returns Tidal for tidal', () => expect(serviceLabel('tidal')).toBe('Tidal'));
  it('returns Pandora for pandora', () => expect(serviceLabel('pandora')).toBe('Pandora'));
  it('returns empty string for unknown slug', () => expect(serviceLabel('whatever')).toBe(''));
  it('returns empty string for a dropped slug (amazon/soundcloud)', () => {
    expect(serviceLabel('amazon')).toBe('');
    expect(serviceLabel('soundcloud')).toBe('');
  });
});

// ── pickListenTarget ──────────────────────────────────────────────────────────
// The Listen button labels itself with the service it will actually open, so
// the URL and the service it belongs to have to be picked together.

describe('pickListenTarget', () => {
  it('reports the preferred service when the album is on it', () => {
    const album = { links: { spotify: { nativeUri: 'spotify:album:abc' }, apple: { url: 'https://music.apple.com/album/abc' } } };
    expect(pickListenTarget(album, 'spotify')).toEqual({ url: 'spotify:album:abc', service: 'spotify', exact: true });
  });

  it('names the fallback service when the preferred one has no link', () => {
    const album = { links: { apple: { url: 'https://music.apple.com/album/abc' } } };
    expect(pickListenTarget(album, 'spotify')).toEqual({ url: 'https://music.apple.com/album/abc', service: 'apple', exact: true });
  });

  it('keeps the url and service in step when a nativeUri wins over an earlier url', () => {
    const album = { links: { deezer: { url: 'https://deezer.com/album/1' }, tidal: { nativeUri: 'tidal://album/2' } } };
    // nativeUri beats url across services, so the label must say Tidal, not Deezer.
    expect(pickListenTarget(album, 'spotify')).toEqual({ url: 'tidal://album/2', service: 'tidal', exact: true });
  });

  it('falls back to the pasted url, tagged with the record’s own service, when there is nothing to search for', () => {
    const album = { sourceUrl: 'https://original.com/album', service: 'tidal', links: {} };
    expect(pickListenTarget(album, 'spotify')).toEqual({ url: 'https://original.com/album', service: 'tidal', exact: true });
  });

  it('reports a null service when the pasted url’s service is unknown', () => {
    const album = { sourceUrl: 'https://original.com/album', links: {} };
    expect(pickListenTarget(album, 'spotify')).toEqual({ url: 'https://original.com/album', service: null, exact: true });
  });

  it('returns nulls when there is nothing to open', () => {
    expect(pickListenTarget({ links: {} }, 'spotify')).toEqual({ url: null, service: null, exact: true });
  });

  // ── search fallback (no exact link anywhere, but artist+title are known) ────

  it('builds a search link on the preferred service when no exact link exists', () => {
    const album = { artist: 'Electric Wizard', title: 'Dopethrone', links: {} };
    const target = pickListenTarget(album, 'tidal');
    expect(target.exact).toBe(false);
    expect(target.service).toBe('tidal');
    expect(target.url).toContain('tidal.com');
    expect(target.url).toContain(encodeURIComponent('Electric Wizard Dopethrone'));
  });

  it('prefers an exact link on another service over a search on the preferred one', () => {
    const album = { artist: 'Radiohead', title: 'OK Computer', links: { deezer: { url: 'https://deezer.com/album/1' } } };
    expect(pickListenTarget(album, 'tidal')).toEqual({ url: 'https://deezer.com/album/1', service: 'deezer', exact: true });
  });

  it('falls back to a registered service’s search when the preferred slug no longer exists (e.g. dropped Amazon/SoundCloud)', () => {
    const album = { artist: 'Radiohead', title: 'OK Computer', links: {} };
    const target = pickListenTarget(album, 'amazon');
    expect(target.exact).toBe(false);
    expect(target.service).not.toBe('amazon');
    expect(target.url).toBeTruthy();
  });

  it('does not offer a search link when artist or title is unknown (nothing to search for)', () => {
    const album = { artist: null, title: null, sourceUrl: 'https://original.com/album', links: {} };
    // Falls straight through to the pasted url rather than a garbage search query.
    expect(pickListenTarget(album, 'tidal')).toEqual({ url: 'https://original.com/album', service: null, exact: true });
  });

  it('prefers the exact pasted url over a search fallback, even when artist/title are known', () => {
    // Regression: the pasted url is a link the user knows is right — a search
    // result is only a guess. When cross-linking hasn't found any exact link
    // yet, the known-good pasted url must win over building a search link.
    const album = { artist: 'Electric Wizard', title: 'Dopethrone', sourceUrl: 'https://original.com/album', service: 'tidal', links: {} };
    expect(pickListenTarget(album, 'spotify')).toEqual({ url: 'https://original.com/album', service: 'tidal', exact: true });
  });
});

// ── linkedServiceNames ────────────────────────────────────────────────────────

describe('linkedServiceNames', () => {
  it('lists the display names of services with a usable link', () => {
    const album = { links: { spotify: { url: 'x' }, apple: { nativeUri: 'y' } } };
    expect(linkedServiceNames(album)).toEqual(['Spotify', 'Apple Music']);
  });

  it('skips entries with neither url nor nativeUri', () => {
    const album = { links: { spotify: { url: 'x' }, tidal: { url: null, nativeUri: null } } };
    expect(linkedServiceNames(album)).toEqual(['Spotify']);
  });

  it('returns an empty list for a record with no links', () => {
    expect(linkedServiceNames({})).toEqual([]);
  });
});

// ── pickListenUrl ─────────────────────────────────────────────────────────────

const MULTI_LINKS_ALBUM = {
  sourceUrl: 'https://open.spotify.com/album/abc',
  links: {
    spotify: { url: 'https://open.spotify.com/album/abc', nativeUri: 'spotify:album:abc' },
    apple:   { url: 'https://music.apple.com/album/abc',  nativeUri: 'music://album/abc' },
    deezer:  { url: 'https://deezer.com/album/123',       nativeUri: null },
  },
};

describe('pickListenUrl', () => {
  it('returns nativeUri for preferred service when present', () => {
    expect(pickListenUrl(MULTI_LINKS_ALBUM, 'spotify')).toBe('spotify:album:abc');
  });

  it('returns web url when nativeUri is null for preferred service', () => {
    expect(pickListenUrl(MULTI_LINKS_ALBUM, 'deezer')).toBe('https://deezer.com/album/123');
  });

  it('returns nativeUri for apple when preferred', () => {
    expect(pickListenUrl(MULTI_LINKS_ALBUM, 'apple')).toBe('music://album/abc');
  });

  it('prefers preferred-service nativeUri over other services nativeUri', () => {
    const album = {
      sourceUrl: 'https://open.spotify.com/album/abc',
      links: {
        spotify: { url: 'https://open.spotify.com/album/abc', nativeUri: 'spotify:album:abc' },
        apple:   { url: 'https://music.apple.com/album/abc',  nativeUri: 'music://album/abc' },
      },
    };
    expect(pickListenUrl(album, 'apple')).toBe('music://album/abc');
  });

  it('falls back to first available nativeUri when preferred service not in links', () => {
    const url = pickListenUrl(MULTI_LINKS_ALBUM, 'tidal');
    expect(['spotify:album:abc', 'music://album/abc']).toContain(url);
  });

  it('falls back to first available url when no nativeUris and preferred missing', () => {
    const album = {
      sourceUrl: 'https://example.com/original',
      links: { deezer: { url: 'https://deezer.com/album/123', nativeUri: null } },
    };
    expect(pickListenUrl(album, 'tidal')).toBe('https://deezer.com/album/123');
  });

  it('falls back to sourceUrl when links is empty', () => {
    const album = { sourceUrl: 'https://original.com/album', links: {} };
    expect(pickListenUrl(album, 'spotify')).toBe('https://original.com/album');
  });

  it('falls back to sourceUrl when links is missing', () => {
    const album = { sourceUrl: 'https://original.com/album' };
    expect(pickListenUrl(album, 'spotify')).toBe('https://original.com/album');
  });

  it('returns null when no links and no sourceUrl', () => {
    expect(pickListenUrl({ links: {} }, 'spotify')).toBeNull();
  });

  it('handles legacy album with no links key', () => {
    const legacy = { sourceUrl: 'https://open.spotify.com/album/legacy' };
    expect(pickListenUrl(legacy, 'spotify')).toBe('https://open.spotify.com/album/legacy');
  });

  it('returns sourceUrl for a pending record (links is empty, sourceUrl set)', () => {
    const pending = {
      _pending: true,
      id: 'pending:https://music.apple.com/album/abc',
      sourceUrl: 'https://music.apple.com/album/abc',
      links: {},
    };
    expect(pickListenUrl(pending, 'apple')).toBe('https://music.apple.com/album/abc');
  });
});

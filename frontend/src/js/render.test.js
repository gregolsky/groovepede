import { describe, it, expect } from 'vitest';
import { tagsByFrequency, escapeHtml, highlightMatch, pickListenUrl, pickListenTarget, linkedServiceNames, serviceLabel, isOnPreferredService, timeAgo, artistInitials } from './render.js';

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

describe('tagsByFrequency', () => {
  it('returns empty array for no albums', () => {
    expect(tagsByFrequency([])).toEqual([]);
  });
  it('returns single tag for one album', () => {
    expect(tagsByFrequency([{ tags: ['rock'] }])).toEqual(['rock']);
  });
  it('sorts by frequency descending', () => {
    const albums = [
      { tags: ['rock', 'indie'] },
      { tags: ['rock', 'jazz'] },
      { tags: ['jazz'] },
    ];
    const result = tagsByFrequency(albums);
    expect(result[0]).toBe('jazz');   // count 2, alpha before rock
    expect(result[1]).toBe('rock');   // count 2
    expect(result[2]).toBe('indie');  // count 1
  });
  it('breaks ties alphabetically', () => {
    const albums = [{ tags: ['zebra', 'apple'] }, { tags: ['zebra', 'apple'] }];
    const result = tagsByFrequency(albums);
    expect(result).toEqual(['apple', 'zebra']);
  });
  it('ignores albums with undefined tags', () => {
    expect(tagsByFrequency([{}, { tags: ['pop'] }])).toEqual(['pop']);
  });
});

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });
  it('coerces non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('highlightMatch', () => {
  it('returns escaped text when query is empty', () => {
    expect(highlightMatch('Hello & World', '')).toBe('Hello &amp; World');
    expect(highlightMatch('Hello', null)).toBe('Hello');
  });
  it('wraps match in mark.hl', () => {
    expect(highlightMatch('The Beatles', 'beat')).toBe('The <mark class="hl">Beat</mark>les');
  });
  it('is case-insensitive', () => {
    const result = highlightMatch('Radiohead', 'radio');
    expect(result).toBe('<mark class="hl">Radio</mark>head');
  });
  it('only highlights first occurrence', () => {
    const result = highlightMatch('ha ha ha', 'ha');
    expect(result).toBe('<mark class="hl">ha</mark> ha ha');
  });
  it('returns escaped text when no match', () => {
    expect(highlightMatch('The Beatles', 'zz')).toBe('The Beatles');
  });
  it('escapes HTML in text before wrapping', () => {
    const result = highlightMatch('<b>Bold</b>', 'bold');
    expect(result).toContain('&lt;b&gt;');
    expect(result).toContain('<mark class="hl">Bold</mark>');
  });
  it('treats regex special chars in query as literals', () => {
    const result = highlightMatch('3.14', '3.1');
    expect(result).toBe('<mark class="hl">3.1</mark>4');
  });
});

// ── timeAgo ───────────────────────────────────────────────────────────────────

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}
const sec  = 1000;
const min  = 60 * sec;
const hour = 60 * min;
const day  = 24 * hour;
const week = 7 * day;

describe('timeAgo', () => {
  it('returns "just now" for less than 1 minute', () => {
    expect(timeAgo(isoAgo(30 * sec))).toBe('just now');
  });

  it('returns minutes for 1–59 min', () => {
    expect(timeAgo(isoAgo(5 * min))).toBe('5m ago');
    expect(timeAgo(isoAgo(59 * min))).toBe('59m ago');
  });

  it('returns hours for 1–23 h', () => {
    expect(timeAgo(isoAgo(2 * hour))).toBe('2h ago');
    expect(timeAgo(isoAgo(23 * hour))).toBe('23h ago');
  });

  it('returns days for 1–6 d', () => {
    expect(timeAgo(isoAgo(1 * day))).toBe('1d ago');
    expect(timeAgo(isoAgo(6 * day))).toBe('6d ago');
  });

  it('returns weeks for 1–4 w', () => {
    expect(timeAgo(isoAgo(1 * week))).toBe('1w ago');
    expect(timeAgo(isoAgo(4 * week))).toBe('4w ago');
  });

  it('returns months for ~5 weeks to 11 months', () => {
    expect(timeAgo(isoAgo(35 * day))).toBe('1mo ago');
    expect(timeAgo(isoAgo(90 * day))).toBe('2mo ago');
    expect(timeAgo(isoAgo(300 * day))).toBe('9mo ago');
  });

  it('returns years for 1+ years', () => {
    expect(timeAgo(isoAgo(400 * day))).toBe('1y ago');
    expect(timeAgo(isoAgo(730 * day))).toBe('2y ago');
  });
});

// ── artistInitials ────────────────────────────────────────────────────────────

describe('artistInitials', () => {
  it('takes one letter per word, up to two', () => {
    expect(artistInitials('Chelsea Wolfe')).toBe('CW');
    expect(artistInitials('Boards of Canada')).toBe('BO');
  });

  it('takes a single letter for a one-word name', () => {
    expect(artistInitials('Radiohead')).toBe('R');
  });

  it('uppercases accented letters without mangling them', () => {
    expect(artistInitials('Bölzer')).toBe('B');
    expect(artistInitials('Ärzte Band')).toBe('ÄB');
  });

  it('splits on commas as well as spaces (multi-artist credits)', () => {
    expect(artistInitials('Neurosis, Jarboe')).toBe('NJ');
  });

  it('skips leading punctuation to find the first real character', () => {
    expect(artistInitials('...And Oceans')).toBe('AO');
  });

  it('handles names starting with a digit', () => {
    expect(artistInitials('65daysofstatic')).toBe('6');
  });

  it('falls back to a music note rather than an empty circle', () => {
    expect(artistInitials('')).toBe('♪');
    expect(artistInitials(null)).toBe('♪');
    expect(artistInitials('   ')).toBe('♪');
    expect(artistInitials('!!!')).toBe('♪');
  });
});

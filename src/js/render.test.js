import { describe, it, expect } from 'vitest';
import { tagsByFrequency, escapeHtml, highlightMatch, pickListenUrl, serviceLabel } from './render.js';

// ── serviceLabel ──────────────────────────────────────────────────────────────

describe('serviceLabel', () => {
  it('returns Spotify for spotify', () => expect(serviceLabel('spotify')).toBe('Spotify'));
  it('returns Apple Music for apple', () => expect(serviceLabel('apple')).toBe('Apple Music'));
  it('returns YouTube Music for youtube', () => expect(serviceLabel('youtube')).toBe('YouTube Music'));
  it('returns Deezer for deezer', () => expect(serviceLabel('deezer')).toBe('Deezer'));
  it('returns Tidal for tidal', () => expect(serviceLabel('tidal')).toBe('Tidal'));
  it('returns Amazon Music for amazon', () => expect(serviceLabel('amazon')).toBe('Amazon Music'));
  it('returns Pandora for pandora', () => expect(serviceLabel('pandora')).toBe('Pandora'));
  it('returns SoundCloud for soundcloud', () => expect(serviceLabel('soundcloud')).toBe('SoundCloud'));
  it('returns empty string for unknown slug', () => expect(serviceLabel('whatever')).toBe(''));
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

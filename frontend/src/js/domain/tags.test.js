import { describe, it, expect } from 'vitest';
import { canonicalTag, normalizeTags, cleanTags } from './tags.js';

describe('canonicalTag', () => {
  it('lowercases and trims', () => {
    expect(canonicalTag('  Classic Rock ')).toBe('classic rock');
  });

  it("maps the services' own hip-hop genre names to hip-hop", () => {
    expect(canonicalTag('Rap/Hip Hop')).toBe('hip-hop');
    expect(canonicalTag('Hip-Hop/Rap')).toBe('hip-hop');
    expect(canonicalTag('hip hop')).toBe('hip-hop');
  });

  it('maps rnb spellings to r&b', () => {
    expect(canonicalTag('rnb')).toBe('r&b');
    expect(canonicalTag('R&B')).toBe('r&b');
  });
});

describe('normalizeTags', () => {
  it('dedupes case variants, keeping the first position', () => {
    expect(normalizeTags(['Pop', 'rock', 'pop', 'Rock'])).toEqual(['pop', 'rock']);
  });

  it('drops non-strings and empty tags', () => {
    expect(normalizeTags(['jazz', null, 42, '  ', 'soul'])).toEqual(['jazz', 'soul']);
  });
});

describe('cleanTags', () => {
  const tag = (name) => ({ name });

  it('lowercases tag names', () => {
    expect(cleanTags([tag('Post-Rock')])).toEqual(['post-rock']);
  });

  it('skips malformed entries instead of throwing', () => {
    expect(cleanTags([null, {}, { name: 42 }, tag('Rock')])).toEqual(['rock']);
  });

  it('drops 4-digit year and 2-digit decade tags', () => {
    expect(cleanTags([tag('1990'), tag('1990s'), tag('90s'), tag('shoegaze')])).toEqual(['shoegaze']);
  });

  it('drops known junk tags', () => {
    expect(cleanTags([tag('seen live'), tag('vinyl'), tag('awesome'), tag('ambient')])).toEqual(['ambient']);
  });

  it('canonicalizes near-duplicate spellings and dedupes the result', () => {
    expect(cleanTags([tag('hip hop'), tag('hiphop'), tag('HIP-HOP')])).toEqual(['hip-hop']);
  });

  it('drops a tag matching the artist name, case-insensitively', () => {
    expect(cleanTags([tag('Mogwai'), tag('post-rock')], 'mogwai')).toEqual(['post-rock']);
  });

  it('keeps tags unrelated to the artist name', () => {
    expect(cleanTags([tag('post-rock')], 'Mogwai')).toEqual(['post-rock']);
  });

  it('drops tags outside the length bounds', () => {
    expect(cleanTags([tag('a'), tag('x'.repeat(26)), tag('drone')])).toEqual(['drone']);
  });

  it('returns an empty array for an empty input', () => {
    expect(cleanTags([])).toEqual([]);
  });
});

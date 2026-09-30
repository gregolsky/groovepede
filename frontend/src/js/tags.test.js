import { describe, it, expect } from 'vitest';
import { canonicalTag, normalizeTags } from './tags.js';

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

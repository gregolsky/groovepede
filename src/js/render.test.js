import { describe, it, expect } from 'vitest';
import { tagsByFrequency, escapeHtml, highlightMatch } from './render.js';

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

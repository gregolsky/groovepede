import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tagsByFrequency, escapeHtml, highlightMatch, timeAgo, artistInitials, renderApp } from './render.js';

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

// ── renderApp: every interpolated value is escaped ────────────────────────────
// Records reach the renderer from imported backup files (user-supplied JSON)
// and Last.fm crowd tags, so no field can be assumed to be plain text.

describe('renderApp escaping', () => {
  const PAYLOAD = '<svg onload=alert(1)>';
  const baseState = {
    activeFilter: 'all', loadingAdd: false, artistCache: {}, trackCache: {},
    exploreIndex: null, addError: null, profileOpen: false, searchQuery: '',
    tagsExpanded: false, addOpen: false, prefService: 'spotify',
    importProgress: null, importSummary: null, refreshingId: null,
  };
  const hostile = {
    id: `x"${PAYLOAD}`, title: 'T', artist: 'A', year: PAYLOAD, tags: [PAYLOAD],
    addedAt: new Date().toISOString(), sourceUrl: 'https://open.spotify.com/album/x',
    links: { spotify: { url: 'https://open.spotify.com/album/x' } },
  };

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: { gp_albums: JSON.stringify([hostile]) },
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('escapes tags (filter chips and card tags), year and id in the queue view', () => {
    const el = { innerHTML: '' };
    renderApp(el, baseState);
    expect(el.innerHTML).not.toContain(PAYLOAD);
    expect(el.innerHTML).not.toContain('x"<');
  });

  it('escapes year in the explore view', () => {
    const el = { innerHTML: '' };
    renderApp(el, { ...baseState, exploreIndex: 0, artistCache: { A: { bio: '' } } });
    expect(el.innerHTML).not.toContain(PAYLOAD);
  });

  it('escapes the add-form error message', () => {
    const el = { innerHTML: '' };
    renderApp(el, { ...baseState, addOpen: true, addError: PAYLOAD });
    expect(el.innerHTML).not.toContain(PAYLOAD);
  });
});

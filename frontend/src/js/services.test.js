import { describe, it, expect } from 'vitest';
import { SERVICES, serviceNames, serviceListText, joinList, serviceLabel, findServiceByHost, ODESLI_KEY_MAP } from './services.js';

describe('serviceNames', () => {
  it('returns every registered service label in registry order', () => {
    expect(serviceNames()).toEqual(SERVICES.map(s => s.label));
  });

  it('advertises every service the parser accepts (no service left unmentioned)', () => {
    // The whole point of the helper: parsing and copy can't drift apart.
    expect(serviceNames()).toHaveLength(SERVICES.length);
    expect(serviceNames()).toContain('SoundCloud');
    expect(serviceNames()).toContain('Pandora');
    expect(serviceNames()).toContain('Amazon Music');
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
    expect(serviceLabel('soundcloud')).toBe('SoundCloud');
    expect(serviceLabel('nope')).toBe('');
  });

  it('maps every Odesli key to a registered slug', () => {
    const slugs = SERVICES.map(s => s.slug);
    for (const slug of Object.values(ODESLI_KEY_MAP)) expect(slugs).toContain(slug);
  });
});

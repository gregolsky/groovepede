import { describe, it, expect } from 'vitest';
import { extractAlbumId, parseMusicLink } from './links.js';
import { SERVICES } from './music-services.js';

describe('extractAlbumId', () => {
  it('extracts id from full Spotify URL', () => {
    expect(extractAlbumId('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
  it('extracts id from Spotify URI', () => {
    expect(extractAlbumId('spotify:album:4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
  it('accepts a bare 22-char album ID', () => {
    expect(extractAlbumId('4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
  it('returns null for an artist URL', () => {
    expect(extractAlbumId('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(extractAlbumId('not a url')).toBeNull();
  });
  it('extracts id from a locale-prefixed intl-XX share-sheet URL', () => {
    expect(extractAlbumId('https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
});

describe('parseMusicLink', () => {
  // ── Spotify ──────────────────────────────────────────────────────────────────
  it('accepts Spotify album URL', () => {
    const r = parseMusicLink('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
    expect(r.error).toBeUndefined();
  });
  it('normalizes Spotify URI to URL', () => {
    const r = parseMusicLink('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
  });
  it('normalizes bare 22-char Spotify ID to URL', () => {
    const r = parseMusicLink('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
  });
  // ── Spotify short links (spotify.link / spotify.app.link) ──────────────────
  it('accepts a spotify.link short link and defers to the resolver', () => {
    const r = parseMusicLink('https://spotify.link/aBcD1234');
    expect(r.url).toBe('https://spotify.link/aBcD1234');
    expect(r.service).toBe('spotify');
    expect(r.error).toBeUndefined();
  });
  it('accepts a spotify.app.link short link', () => {
    const r = parseMusicLink('https://spotify.app.link/aBcD1234');
    expect(r.url).toBe('https://spotify.app.link/aBcD1234');
    expect(r.service).toBe('spotify');
  });
  it('accepts open.spotify.com/s/<code> — a third short-link shape, same host as a normal link', () => {
    // Confirmed live: this is what Spotify's "Share" sheet actually hands out
    // ("native-share-menu"), redirecting to /album/<id>?si=...&utm_source=...
    const r = parseMusicLink('https://open.spotify.com/s/kpXKvHx');
    expect(r.url).toBe('https://open.spotify.com/s/kpXKvHx');
    expect(r.service).toBe('spotify');
    expect(r.error).toBeUndefined();
  });

  // ── Link embedded in shared text (Spotify's Web Share "text" field) ────────
  it('extracts a Spotify URL from text sharing it alongside a title/artist', () => {
    const r = parseMusicLink('Aeropsia by Steve Hauschildt https://open.spotify.com/album/3dgWhwqZHz4KSUX586c3U4');
    expect(r.url).toBe('https://open.spotify.com/album/3dgWhwqZHz4KSUX586c3U4');
    expect(r.service).toBe('spotify');
    expect(r.error).toBeUndefined();
  });
  it('extracts a spotify.link short link embedded in shared text', () => {
    const r = parseMusicLink('Check out this album https://spotify.link/aBcD1234 on Spotify');
    expect(r.url).toBe('https://spotify.link/aBcD1234');
    expect(r.service).toBe('spotify');
  });
  it('strips trailing sentence punctuation off an embedded URL', () => {
    const r = parseMusicLink('Listen here: https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy.');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
  });
  it('still rejects text with no URL at all', () => {
    const r = parseMusicLink('Aeropsia by Steve Hauschildt');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });
  it('still applies non-album rejection to a URL embedded in text', () => {
    const r = parseMusicLink('check out this artist https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.error).toMatch(/artist/i);
    expect(r.url).toBeUndefined();
  });

  it('rejects Spotify artist URL with artist error', () => {
    const r = parseMusicLink('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.error).toMatch(/artist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify track URL with track error', () => {
    const r = parseMusicLink('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify playlist URL with playlist error', () => {
    const r = parseMusicLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(r.error).toMatch(/playlist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify podcast with podcast error', () => {
    const r = parseMusicLink('https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL');
    expect(r.error).toMatch(/podcast/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify artist URI', () => {
    const r = parseMusicLink('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.error).toMatch(/artist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify track URI', () => {
    const r = parseMusicLink('spotify:track:11dFghVXANMlKmJXsNCbNl');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify playlist URI', () => {
    const r = parseMusicLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    expect(r.error).toMatch(/playlist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify show URI', () => {
    const r = parseMusicLink('spotify:show:2MAi0BvDc6GTFvKFPXnkCL');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });

  // ── Apple Music ───────────────────────────────────────────────────────────────
  it('accepts Apple Music album URL', () => {
    const r = parseMusicLink('https://music.apple.com/us/album/ok-computer/1097861328');
    expect(r.service).toBe('apple');
    expect(r.url).toBe('https://music.apple.com/us/album/ok-computer/1097861328');
    expect(r.error).toBeUndefined();
  });
  it('rejects Apple Music track URL (?i= param) with track error', () => {
    const r = parseMusicLink('https://music.apple.com/us/album/ok-computer/1097861328?i=1097861624');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Apple Music artist URL with artist error', () => {
    const r = parseMusicLink('https://music.apple.com/us/artist/radiohead/657515');
    expect(r.error).toMatch(/artist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Apple Music playlist URL with playlist error', () => {
    const r = parseMusicLink('https://music.apple.com/us/playlist/hot-hits/pl.abc123');
    expect(r.error).toMatch(/playlist/i);
    expect(r.url).toBeUndefined();
  });

  // ── YouTube / YouTube Music ───────────────────────────────────────────────────
  it('accepts YouTube Music playlist URL', () => {
    const r = parseMusicLink('https://music.youtube.com/playlist?list=OLAK5uy_abc123');
    expect(r.service).toBe('youtube');
    expect(r.error).toBeUndefined();
  });
  it('accepts YouTube playlist URL', () => {
    const r = parseMusicLink('https://www.youtube.com/playlist?list=PLabc123');
    expect(r.service).toBe('youtube');
    expect(r.error).toBeUndefined();
  });
  it('rejects YouTube single-video URL with track error', () => {
    const r = parseMusicLink('https://www.youtube.com/watch?v=abc123');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects youtu.be short link with track error', () => {
    const r = parseMusicLink('https://youtu.be/abc123');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });

  // ── Deezer ────────────────────────────────────────────────────────────────────
  it('accepts Deezer album URL', () => {
    const r = parseMusicLink('https://www.deezer.com/album/302127');
    expect(r.service).toBe('deezer');
    expect(r.error).toBeUndefined();
  });
  it('rejects Deezer track URL', () => {
    const r = parseMusicLink('https://www.deezer.com/track/1234567');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });

  // ── Tidal ─────────────────────────────────────────────────────────────────────
  it('accepts Tidal album URL', () => {
    const r = parseMusicLink('https://tidal.com/album/26026362');
    expect(r.service).toBe('tidal');
    expect(r.error).toBeUndefined();
  });
  it('accepts Tidal listen subdomain URL', () => {
    const r = parseMusicLink('https://listen.tidal.com/album/26026362');
    expect(r.service).toBe('tidal');
    expect(r.error).toBeUndefined();
  });
  it('rejects Tidal track URL', () => {
    const r = parseMusicLink('https://tidal.com/track/26026363');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });

  // ── Pandora ───────────────────────────────────────────────────────────────────
  // Real shape confirmed live: /artist/<artist-slug>/<album-slug>/AL<id> —
  // there is no literal "/album/" segment. The AL id prefix is what actually
  // distinguishes an album from an artist page or a track page.
  it('accepts Pandora album URL', () => {
    const r = parseMusicLink('https://www.pandora.com/artist/daft-punk/discovery/AL1234567890');
    expect(r.service).toBe('pandora');
    expect(r.error).toBeUndefined();
  });
  it('rejects Pandora artist URL', () => {
    const r = parseMusicLink('https://www.pandora.com/artist/some-artist');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });
  it('rejects Pandora track URL', () => {
    const r = parseMusicLink('https://www.pandora.com/artist/daft-punk/one-more-time/TR1234567890');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });

  // ── Amazon Music / SoundCloud — dropped, not in the registry ────────────────────
  // Neither album page has any server-rendered metadata to extract (verified —
  // pure client-rendered JS shells, and SoundCloud's oEmbed 404s), so both are
  // rejected with a named reason rather than accepted.
  it('rejects Amazon Music with a specific error', () => {
    const r = parseMusicLink('https://music.amazon.com/albums/B08XYZ1234');
    expect(r.error).toMatch(/amazon music/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Amazon Music on any regional domain', () => {
    const r = parseMusicLink('https://music.amazon.co.uk/albums/B08XYZ1234');
    expect(r.error).toMatch(/amazon music/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects SoundCloud with a specific error', () => {
    const r = parseMusicLink('https://soundcloud.com/artist-name/sets/album-name');
    expect(r.error).toMatch(/soundcloud/i);
    expect(r.url).toBeUndefined();
  });

  // ── Every registered service has at least one accepting fixture ────────────────
  // Backstop for the explicit cases above: fails loudly if a service is added to
  // SERVICES without ever being exercised here, instead of shipping untested.
  it('accepts a representative URL for every service in the registry', () => {
    const fixtures = {
      spotify: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
      apple:   'https://music.apple.com/us/album/ok-computer/1097861328',
      youtube: 'https://music.youtube.com/playlist?list=OLAK5uy_abc123',
      deezer:  'https://www.deezer.com/album/302127',
      tidal:   'https://tidal.com/album/26026362',
      pandora: 'https://www.pandora.com/artist/daft-punk/discovery/AL1234567890',
    };
    for (const svc of SERVICES) {
      expect(fixtures, `no fixture URL for service "${svc.slug}"`).toHaveProperty(svc.slug);
      const r = parseMusicLink(fixtures[svc.slug]);
      expect(r.service, `${svc.slug} fixture did not resolve to itself`).toBe(svc.slug);
      expect(r.error, `${svc.slug} fixture was unexpectedly rejected`).toBeUndefined();
    }
  });

  // ── Blocked sources ───────────────────────────────────────────────────────────
  it('rejects Bandcamp with specific error', () => {
    const r = parseMusicLink('https://radiohead.bandcamp.com/album/ok-computer');
    expect(r.error).toMatch(/bandcamp/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Discogs with specific error', () => {
    const r = parseMusicLink('https://www.discogs.com/release/123456');
    expect(r.error).toMatch(/discogs/i);
    expect(r.url).toBeUndefined();
  });

  // ── Unknown / garbage ─────────────────────────────────────────────────────────
  it('returns null error for empty string', () => {
    const r = parseMusicLink('');
    expect(r.error).toBeNull();
    expect(r.url).toBeUndefined();
  });
  it('rejects unknown URL with generic error', () => {
    const r = parseMusicLink('https://example.com/foo');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });
  it('rejects garbage text with generic error', () => {
    const r = parseMusicLink('blah blah blah');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });
});

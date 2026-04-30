import { describe, it, expect } from 'vitest';
import { extractAlbumId, validateAlbumInput } from './storage.js';

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
});

describe('validateAlbumInput', () => {
  it('returns id for a valid album URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.error).toBeNull();
  });
  it('returns id for a valid Spotify URI', () => {
    const r = validateAlbumInput('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.error).toBeNull();
  });
  it('returns id for a bare album ID', () => {
    const r = validateAlbumInput('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.error).toBeNull();
  });
  it('returns null id and no error for empty string', () => {
    const r = validateAlbumInput('');
    expect(r.id).toBeNull();
    expect(r.error).toBeNull();
  });
  it('returns artist error for artist URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/artist/i);
  });
  it('returns artist error for artist URI', () => {
    const r = validateAlbumInput('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/artist/i);
  });
  it('returns track error for track URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/track/i);
  });
  it('returns playlist error for playlist URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/playlist/i);
  });
  it('returns podcast error for show URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/podcast/i);
  });
  it('returns podcast error for episode URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/podcast/i);
  });
  it('returns generic spotify error for unknown spotify path', () => {
    const r = validateAlbumInput('https://open.spotify.com/user/someuser');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/spotify/i);
  });
  it('returns non-spotify error for other URL', () => {
    const r = validateAlbumInput('https://www.youtube.com/watch?v=abc');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/spotify/i);
  });
  it('returns generic error for garbage text', () => {
    const r = validateAlbumInput('blah blah blah');
    expect(r.id).toBeNull();
    expect(r.error).toBeTruthy();
  });
});

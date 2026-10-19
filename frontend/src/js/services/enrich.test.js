import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enrichWithLastfm } from './enrich.js';
import { _setThrottles } from '../infra/api.js';
import { loadAlbums } from '../infra/storage.js';

/** No-op throttles, so pacing never slows or bleeds between tests. */
const noopThrottle = () => ({ run: fn => fn(), coolingDown: () => false });
function resetThrottles() {
  _setThrottles({ resolver: noopThrottle(), musicbrainz: noopThrottle(), lastfm: noopThrottle(), audiodb: noopThrottle(), deezer: noopThrottle() });
}

describe('enrichWithLastfm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockFetchSequence(responses) {
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => responses[i++] })
    );
  }

  function seedAlbum(id) {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id, sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: [], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
  }

  it('merges artist tags before album tags, dropping duplicates from the album side', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }, { name: 'ambient', count: 8 }] } }, // artist.gettoptags
      { album: { tags: { tag: [{ name: 'ambient' }, { name: 'drone' }] } } },                  // album.getinfo
    ]);
    const onUpdate = vi.fn();
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer', onUpdate);
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock', 'ambient', 'drone']);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('preserves the album\'s existing resolver-supplied tags, merging Last.fm tags on top instead of overwriting them', async () => {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id: 'album-1', sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: ['Alternative'], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [{ name: 'ambient' }] } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['alternative', 'post-rock', 'ambient']);
  });

  it('collapses a stored service genre and the same Last.fm tag that differ only in case', async () => {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id: 'album-1', sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: ['Rock', 'Rap/Hip Hop'], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
    mockFetchSequence([
      { toptags: { tag: [{ name: 'rock', count: 10 }, { name: 'hip hop', count: 10 }] } },
      { album: { tags: { tag: [{ name: 'art rock' }] } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['rock', 'hip-hop', 'art rock']);
  });

  it('does not duplicate an existing resolver-supplied tag that Last.fm also returns', async () => {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id: 'album-1', sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: ['post-rock'], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [{ name: 'ambient' }] } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock', 'ambient']);
  });

  it('caps merged tags at 7', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [1, 2, 3, 4, 5].map(n => ({ name: `artist-tag-${n}`, count: 10 })) } },
      { album: { tags: { tag: [1, 2, 3, 4, 5].map(n => ({ name: `album-tag-${n}` })) } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toHaveLength(7);
    expect(album.tags).toEqual(['artist-tag-1', 'artist-tag-2', 'artist-tag-3', 'artist-tag-4', 'artist-tag-5', 'album-tag-1', 'album-tag-2']);
  });

  it('falls back to similar-artist tags when artist and album sources return nothing', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [] } },                                                    // artist.gettoptags — empty
      { album: { tags: {} } },                                                     // album.getinfo — empty
      { similarartists: { artist: [{ name: 'Sim1' }, { name: 'Sim2' }] } },        // artist.getsimilar
      { toptags: { tag: [{ name: 'shoegaze', count: 20 }] } },                     // Sim1 toptags
      { toptags: { tag: [{ name: 'shoegaze', count: 20 }] } },                     // Sim2 toptags
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toContain('shoegaze');
  });

  it('stamps tagsCheckedAt when Last.fm answered, even with nothing to add', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [] } },                 // artist.gettoptags — empty
      { album: { tags: {} } },                  // album.getinfo — ran, empty
      { similarartists: { artist: [] } },       // artist.getsimilar — empty
    ]);
    const onUpdate = vi.fn();
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer', onUpdate);
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual([]);
    expect(Date.parse(album.tagsCheckedAt)).not.toBeNaN();
    expect(onUpdate).not.toHaveBeenCalled(); // nothing visible changed
  });

  it('leaves no stamp when Last.fm itself failed, so the next boot retries', async () => {
    seedAlbum('album-1');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    expect(loadAlbums().find(a => a.id === 'album-1').tagsCheckedAt).toBeUndefined();
  });

  function seedAlbumWithDeezerLink(id) {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id, sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: [], addedAt: '2024-01-01T00:00:00.000Z',
      links: { deezer: { url: 'https://www.deezer.com/album/302127', nativeUri: null } },
    }]));
  }

  it('fills in with Deezer genres when Last.fm returns fewer than 3 tags', async () => {
    seedAlbumWithDeezerLink('album-1');
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } }, // artist.gettoptags — 1 tag
      { album: { tags: { tag: [] } } },                          // album.getinfo — empty
      { image: null, genres: ['Rock', 'Alternative'] },          // resolver /v1/artist
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock', 'rock', 'alternative']);
  });

  it('does not undo queue changes made while it was awaiting the network (lost update)', async () => {
    // Enrichment awaits Last.fm and then Deezer. If the user marks an album
    // Done or adds one in that window, writing back a snapshot taken BEFORE the
    // awaits would resurrect the Done album and drop the new one.
    seedAlbumWithDeezerLink('album-1');
    const queue = JSON.parse(localStorage.getItem('gp_albums'));
    queue.push({ ...queue[0], id: 'album-2', links: {} });
    localStorage.setItem('gp_albums', JSON.stringify(queue));

    const responses = [
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } }, // artist.gettoptags — thin
      { album: { tags: { tag: [] } } },                          // album.getinfo
      { image: null, genres: ['Rock'] },                         // resolver /v1/artist
    ];
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const body = responses[calls++];
      if (calls === 3) {
        // Mid-enrichment: album-2 marked Done, album-3 added.
        const now = JSON.parse(localStorage.getItem('gp_albums')).filter(a => a.id !== 'album-2');
        now.push({ ...now[0], id: 'album-3', tags: [], links: {} });
        localStorage.setItem('gp_albums', JSON.stringify(now));
      }
      return Promise.resolve({ ok: true, json: async () => body });
    });

    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const ids = loadAlbums().map(a => a.id);
    expect(ids).toEqual(['album-1', 'album-3']);
    expect(loadAlbums()[0].tags).toEqual(['post-rock', 'rock']);
  });

  it('does not query Deezer when Last.fm is thin but the album has no Deezer link', async () => {
    seedAlbum('album-1'); // no links.deezer
    let calls = 0;
    const responses = [
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [] } } },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const body = responses[calls++];
      return Promise.resolve({ ok: true, json: async () => body });
    });
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    expect(calls).toBe(2);
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock']);
  });

  it('returns early without fetching when artistName is falsy', async () => {
    seedAlbum('album-1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onUpdate = vi.fn();
    await enrichWithLastfm('album-1', '', 'OK Computer', onUpdate);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not write or call onUpdate when the album id is not in storage', async () => {
    // No seedAlbum() — storage is empty.
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [] } } },
    ]);
    const onUpdate = vi.fn();
    await enrichWithLastfm('missing-id', 'Radiohead', 'OK Computer', onUpdate);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(loadAlbums()).toEqual([]);
  });
});

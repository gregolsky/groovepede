import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every API touch point either returns its failure to a caller that reports
// it, or reports it itself before swallowing it. Transport failures — network,
// timeout, 5xx, 429, a malformed body — are reported; an expected answer (a
// 404, "not found") is not. The beacon is mocked here so the reports can be
// asserted; in its own file so the mock can't leak into api.test.js.
vi.mock('./beacon.js', () => ({ reportFailure: vi.fn() }));

const { reportFailure } = await import('./beacon.js');
const {
  resolveAlbum, resolveAlbumMusicBrainz, fetchLastfmAlbum, fetchAudiodbArtistImage,
  fetchDeezerArtistData, _setThrottles,
} = await import('./api.js');

const noop = () => ({ run: fn => fn(), coolingDown: () => false });
const respond = (status, body = {}) => vi.spyOn(globalThis, 'fetch').mockResolvedValue({
  ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body,
});
const reject = () => vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
const reported = () => reportFailure.mock.calls.map(([kind, f]) => `${kind} ${f.msg}`);

beforeEach(() => {
  vi.restoreAllMocks();
  reportFailure.mockClear();
  _setThrottles({ resolver: noop(), musicbrainz: noop(), lastfm: noop(), audiodb: noop(), deezer: noop() });
});

describe('resolveAlbum (/v1/album)', () => {
  it('reports a network failure and returns a retryable error', async () => {
    reject();
    expect(await resolveAlbum('https://open.spotify.com/album/x')).toEqual({ _error: 'network' });
    expect(reported()).toEqual(['api-failed /v1/album network']);
  });

  it('reports a 5xx', async () => {
    respond(503);
    await resolveAlbum('https://open.spotify.com/album/x');
    expect(reported()).toEqual(['api-failed /v1/album 503']);
  });

  it('does not report a 4xx — that is an answer the caller reports as the add outcome', async () => {
    respond(400);
    expect(await resolveAlbum('https://open.spotify.com/album/x')).toEqual({ _error: 400 });
    expect(reported()).toEqual([]);
  });

  it('rejects and reports a 200 body without an id, instead of saving an id-less record', async () => {
    respond(200, { title: 'T' });
    expect(await resolveAlbum('https://open.spotify.com/album/x')).toEqual({ _error: 'network' });
    expect(reported()).toEqual(['api-failed /v1/album bad-response']);
  });

  it('reports a malformed body as bad-response, not as a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad json'); },
    });
    await resolveAlbum('https://open.spotify.com/album/x');
    expect(reported()).toEqual(['api-failed /v1/album bad-response']);
  });
});

describe('the touch points that swallow their failures report them first', () => {
  it('MusicBrainz url lookup: reports a network failure, not a 404', async () => {
    reject();
    await resolveAlbumMusicBrainz('https://open.spotify.com/album/x', 'spotify');
    expect(reported()).toEqual(['api-failed musicbrainz:url network']);

    reportFailure.mockClear();
    respond(404);
    await resolveAlbumMusicBrainz('https://open.spotify.com/album/x', 'spotify');
    expect(reported()).toEqual([]);
  });

  it('Last.fm: reports a 5xx, naming the method', async () => {
    respond(500);
    expect(await fetchLastfmAlbum('A', 'T')).toEqual({ _error: 500 });
    expect(reported()).toEqual(['api-failed lastfm:album.getinfo 500']);
  });

  it('TheAudioDB: reports a network failure', async () => {
    reject();
    expect(await fetchAudiodbArtistImage('A')).toEqual({ _error: 'network' });
    expect(reported()).toEqual(['api-failed audiodb:search network']);
  });

  it('/v1/artist: reports a 5xx', async () => {
    respond(502);
    expect(await fetchDeezerArtistData('A', '1')).toEqual({ _error: 502 });
    expect(reported()).toEqual(['api-failed /v1/artist 502']);
  });
});

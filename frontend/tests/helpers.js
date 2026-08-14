/**
 * Shared E2E fixtures.
 *
 * The point of this file is `stubExternals`. Every spec needs the same third-
 * party APIs stubbed, and when they were stubbed inline per file, adding a new
 * external call to the app meant remembering to update seven spec files — the
 * artist-image work added TheAudioDB and the suite quietly started hitting the
 * real network until someone noticed. One list here, stubbed everywhere.
 *
 * Playwright resolves routes last-registered-first, so a spec can still call
 * context.route() afterwards to override any of these for a single test.
 */

export const KEYS = {
  TOKEN:   'gp_token',
  EXPIRY:  'gp_expiry',
  REFRESH: 'gp_refresh',
  ALBUMS:  'gp_albums',
  DONE:    'gp_done',
};

export const SPOTIFY_ALBUM_ID = 'abc123def456ghi789jklm';
export const SPOTIFY_URL = `https://open.spotify.com/album/${SPOTIFY_ALBUM_ID}`;

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** An Odesli/resolver response shaped exactly like the real one. */
export function makeOdesliResponse({ title = 'Test Album', artist = 'Test Artist', ...overrides } = {}) {
  const entityId = `SPOTIFY_ALBUM::${SPOTIFY_ALBUM_ID}`;
  return {
    entityUniqueId: entityId,
    userCountry: 'US',
    pageUrl: `https://song.link/s/${SPOTIFY_ALBUM_ID}`,
    entitiesByUniqueId: {
      [entityId]: {
        id: SPOTIFY_ALBUM_ID,
        type: 'album',
        title,
        artistName: artist,
        thumbnailUrl: 'https://example.com/cover.jpg',
        apiProvider: 'spotify',
        platforms: ['spotify'],
      },
    },
    linksByPlatform: {
      spotify: {
        url: SPOTIFY_URL,
        nativeAppUriMobile: `spotify:album:${SPOTIFY_ALBUM_ID}`,
        entityUniqueId: entityId,
      },
    },
    ...overrides,
  };
}

/**
 * Stub every third-party host the app can reach, so no test ever depends on the
 * network. Enrichment sources answer "nothing found" by default, which is the
 * quiet path — tests that care about tags or artist images override them.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {object}  [opts]
 * @param {object|number|null} [opts.odesli]  resolver response body, or a bare
 *        HTTP status to fail with. null leaves the resolver unstubbed.
 */
export async function stubExternals(context, { odesli = makeOdesliResponse() } = {}) {
  // Artist images (browser-direct) — "no such artist".
  await context.route('https://www.theaudiodb.com/**', route => route.fulfill(json({ artists: null })));
  // Last.fm tags / artist info — empty payload, no tags applied.
  await context.route('https://ws.audioscrobbler.com/**', route => route.fulfill(json({})));
  // MusicBrainz is only reached as the resolver's fallback; 404 = "no match".
  await context.route('https://musicbrainz.org/**', route => route.fulfill(json({}, 404)));

  if (odesli !== null) {
    await context.route('https://api.groovepede.gregolsky.pl/**', route =>
      route.fulfill(typeof odesli === 'number' ? json({}, odesli) : json(odesli))
    );
  }
}

/** Seed the queue (and optionally the listened counter) before the app boots. */
export async function seedAlbums(context, albums, done) {
  await context.addInitScript(({ keys, albums, done }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify(albums));
    if (done !== undefined) localStorage.setItem(keys.DONE, String(done));
  }, { keys: KEYS, albums, done });
}

/**
 * Put the app in a logged-in state: a valid (non-expired) token plus the /me
 * response the boot sequence fetches.
 */
export async function loginAs(context, profile = { display_name: 'Test User', images: [] }) {
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN, 'valid_token');
    localStorage.setItem(keys.EXPIRY, String(Date.now() + 3600000));
  }, { keys: KEYS });

  await context.route('https://api.spotify.com/v1/me', route => route.fulfill(json(profile)));
}

/** Three albums with distinct titles, artists and tags — enough to test filtering. */
export const SAMPLE_ALBUMS = [
  { id: 'a1', title: 'Kind of Blue', artist: 'Miles Davis',    url: '', cover: null, year: '1959', tags: ['jazz'],     addedAt: new Date().toISOString() },
  { id: 'a2', title: 'Blue Lines',   artist: 'Massive Attack', url: '', cover: null, year: '1991', tags: ['trip-hop'], addedAt: new Date().toISOString() },
  { id: 'a3', title: 'Revolver',     artist: 'The Beatles',    url: '', cover: null, year: '1966', tags: ['rock'],     addedAt: new Date().toISOString() },
];

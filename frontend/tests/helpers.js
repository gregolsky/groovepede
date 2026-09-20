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
  ALBUMS:  'gp_albums',
  DONE:    'gp_done',
};

export const SPOTIFY_ALBUM_ID = 'abc123def456ghi789jklm';
export const SPOTIFY_URL = `https://open.spotify.com/album/${SPOTIFY_ALBUM_ID}`;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** A /v1/album response shaped exactly like the real resolver's (backend/resolver-core.mjs). */
export function makeAlbumResponse({ title = 'Test Album', artist = 'Test Artist', ...overrides } = {}) {
  return {
    id: `spotify:${SPOTIFY_ALBUM_ID}`,
    service: 'spotify',
    title,
    artist,
    cover: 'https://example.com/cover.jpg',
    year: null,
    tags: [],
    links: {
      spotify: { url: SPOTIFY_URL, nativeUri: `spotify:album:${SPOTIFY_ALBUM_ID}` },
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
 * @param {object|number|null} [opts.resolver]  /v1/album response body, or a
 *        bare HTTP status to fail with. null leaves the resolver unstubbed.
 */
export async function stubExternals(context, { resolver = makeAlbumResponse() } = {}) {
  // Catch-all, registered FIRST so every specific route below — and any a spec
  // adds later — takes precedence. Anything else off localhost never reaches
  // the network: images get a 1×1 PNG, everything else is aborted. Fixture
  // cover URLs (https://img/cover, https://example.com/cover.jpg) used to go to
  // the real network, and since page.goto waits for the load event, a slow DNS
  // lookup for them could hold goto past a short-lived UI state (the share
  // overlay lasts ~1.5s) — one source of the suite's timing flakes.
  await context.route(url => !LOCAL_HOSTS.has(url.hostname), route =>
    route.request().resourceType() === 'image'
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG })
      : route.abort());

  // Artist images (browser-direct) — "no such artist".
  await context.route('https://www.theaudiodb.com/**', route => route.fulfill(json({ artists: null })));
  // Last.fm tags / artist info — empty payload, no tags applied.
  await context.route('https://ws.audioscrobbler.com/**', route => route.fulfill(json({})));
  // MusicBrainz is only reached as the resolver's fallback; 404 = "no match".
  await context.route('https://musicbrainz.org/**', route => route.fulfill(json({}, 404)));

  if (resolver !== null) {
    await context.route('https://api.groovepede.gregolsky.pl/**', route =>
      route.fulfill(typeof resolver === 'number' ? json({}, resolver) : json(resolver))
    );
  }
}

/**
 * Hold every resolver request open until the test calls the returned
 * `release()`, then answer with `body`. Lets a test observe a loading phase for
 * as long as it needs — a fixed sleep races the assertions. Register it after
 * stubExternals(): the last-registered route wins.
 */
export async function gatedResolver(context, body) {
  let release;
  const held = new Promise(r => { release = r; });
  await context.route('https://api.groovepede.gregolsky.pl/**', async route => {
    await held;
    await route.fulfill(json(body));
  });
  return release;
}

/** Make the page believe it was launched as an installed PWA (display-mode: standalone). */
export function fakeStandalone(context) {
  return context.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(display-mode: standalone)') {
        return { matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} };
      }
      return orig(query);
    };
  });
}

/** Seed the queue (and optionally the listened counter) before the app boots. */
export async function seedAlbums(context, albums, done) {
  await context.addInitScript(({ keys, albums, done }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify(albums));
    if (done !== undefined) localStorage.setItem(keys.DONE, String(done));
  }, { keys: KEYS, albums, done });
}

/** Three albums with distinct titles, artists and tags — enough to test filtering. */
export const SAMPLE_ALBUMS = [
  { id: 'a1', title: 'Kind of Blue', artist: 'Miles Davis',    url: '', cover: null, year: '1959', tags: ['jazz'],     addedAt: new Date().toISOString() },
  { id: 'a2', title: 'Blue Lines',   artist: 'Massive Attack', url: '', cover: null, year: '1991', tags: ['trip-hop'], addedAt: new Date().toISOString() },
  { id: 'a3', title: 'Revolver',     artist: 'The Beatles',    url: '', cover: null, year: '1966', tags: ['rock'],     addedAt: new Date().toISOString() },
];

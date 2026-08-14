export const CLIENT_ID    = 'f92bb3efa7834769a202cd583d3ddf5f';
export const REDIRECT     = 'https://groovepede.gregolsky.pl/';
export const SCOPES       = 'user-read-private';
export const SYNC_SCOPES  = 'user-read-private playlist-modify-private';
export const LASTFM_KEY   = '85219c8fc56c9e7cde4a4b9cb8a303d1';
export const STORAGE_KEY  = 'gp_albums';
export const DONE_KEY     = 'gp_done';
export const TOKEN_KEY    = 'gp_token';
export const EXPIRY_KEY   = 'gp_expiry';
export const VERIFIER_KEY = 'gp_verifier';
export const REFRESH_KEY  = 'gp_refresh';
export const SYNC_ENABLED_KEY  = 'gp_sync_enabled';
export const SYNC_PLAYLIST_KEY = 'gp_sync_playlist_id';
export const SYNC_LAST_KEY     = 'gp_sync_last';
export const SYNC_PENDING_KEY  = 'gp_sync_pending';
export const PREF_SERVICE_KEY  = 'gp_pref_service';

// Resolver proxy — server-side Odesli proxy that bypasses the CORS block.
// All resolution goes through this; ODESLI_BASE no longer points at Odesli directly.
// See: specs/resolver-proxy.md, backend/
export const ODESLI_BASE = 'https://api.groovepede.gregolsky.pl';
// ECDSA-P256 private key (PKCS8 DER, base64) used to sign x-gp-token per request.
// Injected at build time — never in source. Set VITE_GP_PRIVATE_KEY in .env.local
// for dev, or as a GitHub Actions secret for CI. Ships in the bundle at runtime
// (see specs/resolver-proxy.md § Security for the threat model).
export const GP_PRIVATE_KEY = import.meta.env.VITE_GP_PRIVATE_KEY ?? '';
// ODESLI_API_KEY is now handled server-side in the Lambda; unused from the client.
export const ODESLI_API_KEY = '';

export const MUSICBRAINZ_BASE  = 'https://musicbrainz.org/ws/2';
export const COVERART_BASE     = 'https://coverartarchive.org';

// Per-service throttle policy. minIntervalMs = 60_000 / rpm (with headroom).
// isRateLimited / retryAfterOf are wired in api.js per-service.
export const THROTTLE = {
  // Odesli: 60/min per IP; 1 100 ms ≈ 54/min — comfortably under the limit.
  odesli:      { minIntervalMs: 1_100,  cooldownMs: 60_000, maxCooldownMs: 300_000 },
  // MusicBrainz: ~1 req/s guideline; 1 200 ms is safe.
  musicbrainz: { minIntervalMs: 1_200,  cooldownMs: 60_000, maxCooldownMs: 300_000 },
  // Last.fm: generous ceiling (~300/min); pace at 200 ms (5/s) to avoid bursts.
  lastfm:      { minIntervalMs:   200,  cooldownMs: 30_000, maxCooldownMs:  60_000 },
  // Spotify Web API: ~180/min sustained; Retry-After header honoured by throttler.
  spotify:     { minIntervalMs:   334,  cooldownMs: 30_000, maxCooldownMs: 300_000 },
  // TheAudioDB free tier (key 123) is shared and rate-limited; pace politely.
  audiodb:     { minIntervalMs: 1_000,  cooldownMs: 60_000, maxCooldownMs: 300_000 },
  // Deezer via our own resolver — nginx allows 10r/s; 500 ms is well under.
  deezer:      { minIntervalMs:   500,  cooldownMs: 30_000, maxCooldownMs: 300_000 },
};

// TheAudioDB — artist images, called directly from the browser (it sends
// Access-Control-Allow-Origin: *). `123` is the free public key documented in
// their API guide. Deezer has better coverage but sends no CORS header, so it
// goes through the resolver instead (see fetchArtistImage in api.js).
export const AUDIODB_BASE = 'https://www.theaudiodb.com/api/v1/json/123';

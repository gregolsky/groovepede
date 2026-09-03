export const LASTFM_KEY   = '85219c8fc56c9e7cde4a4b9cb8a303d1';
export const STORAGE_KEY  = 'gp_albums';
export const DONE_KEY     = 'gp_done';
export const PREF_SERVICE_KEY  = 'gp_pref_service';

// Resolver — server-side album-page fetch + extraction that bypasses the CORS
// block (browsers can't fetch another service's album page directly).
// All resolution goes through this. See: specs/resolver-proxy.md, backend/
export const RESOLVER_BASE = 'https://api.groovepede.gregolsky.pl';
// ECDSA-P256 private key (PKCS8 DER, base64) used to sign x-gp-token per request.
// Injected at build time — never in source. Set VITE_GP_PRIVATE_KEY in .env.local
// for dev, or as a GitHub Actions secret for CI. Ships in the bundle at runtime
// (see specs/resolver-proxy.md § Security for the threat model).
export const GP_PRIVATE_KEY = import.meta.env.VITE_GP_PRIVATE_KEY ?? '';

export const MUSICBRAINZ_BASE  = 'https://musicbrainz.org/ws/2';
export const COVERART_BASE     = 'https://coverartarchive.org';

// Per-service throttle policy. minIntervalMs = 60_000 / rpm (with headroom).
// isRateLimited / retryAfterOf are wired in api.js per-service.
export const THROTTLE = {
  // Our own resolver: nginx allows 10r/s per IP; 1 100 ms ≈ 54/min — comfortably under it.
  resolver:    { minIntervalMs: 1_100,  cooldownMs: 60_000, maxCooldownMs: 300_000 },
  // MusicBrainz: ~1 req/s guideline; 1 200 ms is safe.
  musicbrainz: { minIntervalMs: 1_200,  cooldownMs: 60_000, maxCooldownMs: 300_000 },
  // Last.fm: generous ceiling (~300/min); pace at 200 ms (5/s) to avoid bursts.
  lastfm:      { minIntervalMs:   200,  cooldownMs: 30_000, maxCooldownMs:  60_000 },
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

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
export const ODESLI_BASE       = 'https://api.song.link/v1-alpha.1';
// Odesli: 60 req/min per IP (source: Odesli support). A registered API key
// raises the per-key ceiling but does not change the IP-level limit.
// Request a key: developers@song.link
export const ODESLI_API_KEY    = '';

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
};

/**
 * Fetching from upstream services: the one fetchUpstream() every extractor,
 * cross-link and handler goes through (timeout, User-Agent, response-size
 * cap), redirect following for short links, the error type that tells a
 * failed fetch apart from a successful fetch with nothing useful in it, and
 * the upstream base URLs.
 */

export const UA            = 'Groovepede-Resolver/1.0 (+https://groovepede.gregolsky.pl)';
export const DEEZER_BASE   = 'https://api.deezer.com';
export const ITUNES_BASE   = 'https://itunes.apple.com';
export const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';
export const SPOTIFY_API_BASE      = 'https://api.spotify.com/v1';

// ── Upstream fetch helper ────────────────────────────────────────────────────
// Every extractor fetches exactly one upstream URL (a service's own album page,
// or a free keyless JSON API) through this, so the timeout, UA, and response
// size cap live in one place rather than N near-duplicates.

const FETCH_TIMEOUT_MS = 8_000;   // under nginx's 10s proxy_read_timeout for /v1/album
const MAX_RESPONSE_BYTES = 512 * 1024; // album pages run 25-800KB in practice; well clear of that

/** Thrown when the upstream fetch itself failed (network/timeout/non-2xx) — as
 * opposed to a successful fetch whose body just didn't contain what we wanted.
 * The distinction matters: the former should be retryable by the client
 * (isRetryableResolveError in frontend/src/js/storage.js), the latter shouldn't. */
export class UpstreamFetchError extends Error {
  constructor(status, cause) {
    // `cause` carries the real fetch failure (DNS, TLS, abort, …) that would
    // otherwise be discarded — see fetchUpstream below. Standard Error
    // chaining (Node >= 16.9), so err.cause?.message is always safe to log.
    super(`upstream fetch failed (${status || 'network'})`, cause !== undefined ? { cause } : undefined);
    this.status = status; // 0/undefined = network/timeout, else the upstream's HTTP status
  }
}

/** Read a Response body up to maxBytes, streaming when the runtime supports it
 * (real fetch/undici) and falling back to res.text() for test fixtures that
 * don't implement a streamable .body. */
async function readLimitedText(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    out += decoder.decode(value, { stream: true });
    if (total > maxBytes) { reader.cancel().catch(() => {}); break; }
  }
  return out;
}

/**
 * Fetch one upstream URL and return its body as text.
 * Throws UpstreamFetchError on timeout, network failure, or a non-2xx status
 * — callers let that propagate up to the request handler, which maps it to a
 * retryable {_error}. A successful-but-empty/unparseable body is the caller's
 * problem (extraction genuinely failed), not this helper's.
 */
export async function fetchUpstream(url, fetchImpl = fetch, opts = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: opts.method || 'GET',
        headers: { 'User-Agent': UA, 'Accept': '*/*', ...opts.headers },
        body: opts.body,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new UpstreamFetchError(0, err);
    }
    if (!res.ok) throw new UpstreamFetchError(res.status);
    try {
      // Read inside the same try/finally as the fetch itself, so the abort
      // timer covers the body read too — a slow/stalled body would otherwise
      // hang past FETCH_TIMEOUT_MS since the timer was cleared right after
      // headers arrived.
      return await readLimitedText(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      throw new UpstreamFetchError(0, err); // aborted mid-read = same as a timeout
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow a chain of HTTP redirects without downloading any response body —
 * used for Spotify's share-sheet short links (spotify.link/spotify.app.link),
 * which 30x straight to the real open.spotify.com URL. `redirect: 'manual'`
 * so a redirect to something we don't want to extract (a track, an artist)
 * never costs an extra fetch of that page's body.
 *
 * ONE AbortController/timer covers every hop (not a fresh FETCH_TIMEOUT_MS
 * per hop) — this is conceptually a single fetchUpstream-equivalent
 * operation, and extractSpotify makes one more fetch (the /embed/ page)
 * right after this returns. Budgeting per-hop would let a short link cost
 * multiple independent 8s windows, pushing /v1/album's worst case past
 * nginx's proxy_read_timeout for `location /` (see the comment there).
 *
 * Only http(s) targets are followed: a redirect hands trust to whatever
 * Location header spotify.link/spotify.app.link returns, not just to
 * Spotify's own DNS, so this fetches that target BEFORE the final
 * open.spotify.com host check in extractSpotify runs — worth constraining
 * the scheme explicitly rather than relying on fetchImpl to reject it.
 *
 * Throws UpstreamFetchError(400, …) — a permanent, non-retryable failure —
 * once maxHops is exceeded or a hop's scheme isn't http(s), since neither is
 * a transient condition a client retry would fix.
 */
export async function resolveRedirect(url, fetchImpl, maxHops = 3) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= maxHops; hop++) {
      const { protocol } = new URL(current);
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new UpstreamFetchError(400, new Error(`unsupported redirect scheme: ${protocol}`));
      }
      let res;
      try {
        res = await fetchImpl(current, {
          method: 'GET',
          headers: { 'User-Agent': UA, 'Accept': '*/*' },
          redirect: 'manual',
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new UpstreamFetchError(0, err);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new UpstreamFetchError(res.status);
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new UpstreamFetchError(res.status);
      return current;
    }
    throw new UpstreamFetchError(400, new Error('too many redirects'));
  } finally {
    clearTimeout(timer);
  }
}

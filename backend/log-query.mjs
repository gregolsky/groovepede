/**
 * The query-string part of the resolver's access-log line.
 *
 * nginx logs the client IP, so it logs API paths without their query
 * (nginx/app.conf.template). The diagnostics live here instead, where no IP is
 * logged: which album URL failed to resolve, which artist lookup came back
 * empty. Only selected params are kept, and from a pasted album URL only what
 * identifies the album — never the share/tracking ids that point back at the
 * person who shared it.
 */

const MAX_VALUE = 200;

// Logged as-is (truncated). Anything not listed here is dropped.
const PLAIN_PARAMS = ['name', 'albumId', 'userCountry'];

// Share/tracking params services append to album links. `si` (Spotify,
// YouTube) identifies the sharing account; the rest are campaign noise.
const TRACKING_PARAM = /^(si|sci|fbclid|gclid|igsh|igshid|feature|utm_.*)$/i;

const clip = (s) => (s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);

/** A pasted album URL minus its tracking params and fragment. */
export function sanitizeAlbumUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return clip(raw); }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return clip(url.toString());
}

/**
 * The selected query params of a request URL, for the access log, or
 * undefined when it has none. `token` is a credential: its presence is
 * recorded, never its value.
 */
export function logQuery(u) {
  const q = {};
  const p = u.searchParams;
  if (p.has('url'))   q.url = sanitizeAlbumUrl(p.get('url'));
  for (const key of PLAIN_PARAMS) {
    if (p.has(key)) q[key] = clip(p.get(key));
  }
  if (p.has('token')) q.token = true;
  return Object.keys(q).length ? q : undefined;
}

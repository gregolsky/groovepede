/**
 * Client error beacon — reports uncaught JS errors and explicit app-level
 * failures to the resolver's /v1/log endpoint (see backend/resolver-core.mjs's
 * logRequest), so a failure that only ever showed up in one user's own
 * browser console is visible from `docker compose logs -f resolver`.
 *
 * Fire-and-forget by design: never throws, never retries, never awaited by
 * its caller — a broken beacon must never become a second bug on top of the
 * one it's trying to report.
 *
 * Disabled entirely when no signing key is configured (a dev build without
 * VITE_GP_PRIVATE_KEY): an unsigned POST would just be a 403 in the
 * resolver's own logs, adding noise instead of removing it.
 */
import { RESOLVER_BASE, GP_PRIVATE_KEY } from './config.js';
import { signRequestToken } from './sign.js';

const MAX_REPORTS_PER_SESSION = 10; // a render-loop error must not turn into a self-inflicted flood
const MAX_FIELD_CHARS = 500;

let sentCount = 0;
const seen = new Set(); // `${kind}|${msg}` — the same failure is reported once per session, not once per occurrence

/** Test-only reset — module state is otherwise a session-lifetime singleton. */
export function _resetBeaconState() { sentCount = 0; seen.clear(); }

function truncate(v, max = MAX_FIELD_CHARS) {
  if (v == null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

async function send(payload) {
  if (!GP_PRIVATE_KEY) return;
  const key = `${payload.kind}|${payload.msg}`;
  if (seen.has(key) || sentCount >= MAX_REPORTS_PER_SESSION) return;
  seen.add(key);
  sentCount++;

  try {
    const body = JSON.stringify({
      kind:    truncate(payload.kind, 40),
      msg:     truncate(payload.msg),
      stack:   truncate(payload.stack),
      route:   truncate(payload.route, 100),
      albumId: truncate(payload.albumId, 40),
      service: truncate(payload.service, 40),
      ua:      truncate(navigator.userAgent, 200),
    });
    const token = await signRequestToken('log');
    const url   = `${RESOLVER_BASE}/v1/log`;

    // sendBeacon is preferred — it's the API built for exactly this: firing
    // reliably even as the page unloads (an error right before navigating
    // away or closing a share-target tab is a real case here). It can't set
    // custom headers though, so the signed token rides as a query param
    // instead; the resolver's /v1/log route accepts either (see server.mjs).
    if (typeof navigator.sendBeacon === 'function') {
      const ok = navigator.sendBeacon(
        `${url}?token=${encodeURIComponent(token)}`,
        new Blob([body], { type: 'application/json' }),
      );
      if (ok) return;
    }

    // Fallback for environments without sendBeacon (or that reject the
    // payload, e.g. over its size quota) — keepalive gives it a similar
    // best-effort chance to complete past page unload.
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gp-token': token },
      body,
      keepalive: true,
    });
  } catch {
    // Never throw from a diagnostic path.
  }
}

/**
 * Report an explicit app-level failure — a resolve that failed, a tracklist
 * that came back empty with a known reason, etc. `fields.msg` is what gets
 * deduped on, so keep it stable per failure type (a raw HTTP status, not a
 * message that embeds e.g. a timestamp).
 */
export function reportFailure(kind, fields = {}) {
  send({ kind, msg: fields.msg ?? '', stack: fields.stack, route: fields.route, albumId: fields.albumId, service: fields.service });
}

let _initialized = false;

/** Wire up uncaught-error reporting. Call once at boot. Idempotent. */
export function initBeacon() {
  if (_initialized) return;
  _initialized = true;
  window.addEventListener('error', e => {
    send({ kind: 'uncaught-error', msg: e.message || String(e.error || 'unknown error'), stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    send({ kind: 'unhandled-rejection', msg: reason?.message || String(reason), stack: reason?.stack });
  });
}

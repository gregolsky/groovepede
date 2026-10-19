// Its own dependency-free module so the views (render.js) can tell a failed
// lookup from an empty one without importing the network layer.

/**
 * The one failure shape every api.js function returns on a transport
 * failure — a timeout, a 5xx, a 429, a malformed body, "network". `code` is
 * either an HTTP status or one of api.js's rejectionReason() strings. Never an
 * expected "no" answer (a 404, "no such artist") — those are `null`/`[]`,
 * a real (if empty) result.
 *
 * A plain `_error` property, not a class, so the throttle's own
 * `_error === 429` cooldown check (is429 in api.js) keeps seeing it with no
 * translation layer — the throttle wraps the raw return value of the function
 * it paces, before api.js gets a chance to look at it. Frozen so nothing
 * downstream mutates a value that error-message code may hold onto.
 */
export function apiError(code, extra) {
  return Object.freeze({ _error: code, ...extra });
}

/** True for any value built by apiError() above — the one failure shape. */
export function isApiError(x) {
  return !!x && typeof x === 'object' && '_error' in x;
}

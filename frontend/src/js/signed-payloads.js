/**
 * The exact string the client signs for each resolver route (see sign.js).
 * The resolver rebuilds the same string from the request and verifies the
 * token against it, so these must match backend/resolver-core.mjs byte for
 * byte — a mismatch is a 403 on every request to that route.
 *
 * Dependency-free on purpose: backend/resolver-core.test.mjs imports this file
 * and signs over its output, so a change on either side fails that contract
 * test instead of breaking in production.
 */
export const signedPayload = {
  album:  url => url,
  tracks: albumId => `tracks:${albumId}`,
  artist: (name, albumId) => `artist:${name}|${albumId || ''}`,
  log:    () => 'log',
};

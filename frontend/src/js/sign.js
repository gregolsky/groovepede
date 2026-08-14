/**
 * Client-side request signing for the Groovepede resolver proxy.
 *
 * Produces a short-lived ECDSA-P256 signed token bound to the request payload, so
 * a token sniffed from network traffic is only valid for that one request and
 * only for 5 minutes (the resolver's replay window).
 *
 * Token format:  "<unix_seconds>.<base64url(ieee-p1363 signature)>"
 * Signed payload: UTF-8 bytes of "`${ts}\n${payload}`" — the album URL for
 * /v1/resolve, `artist:<name>|<albumId>` for /v1/artist.
 *
 * The private key (VITE_GP_PRIVATE_KEY) is a base64-encoded PKCS8 DER blob.
 * The matching public key (GP_PUBLIC_KEY on the resolver) is base64-encoded SPKI DER.
 */

import { GP_PRIVATE_KEY } from './config.js';

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

let _keyPromise = null;

function getKey() {
  if (_keyPromise) return _keyPromise;
  if (!GP_PRIVATE_KEY) return (_keyPromise = Promise.resolve(null));
  _keyPromise = crypto.subtle
    .importKey(
      'pkcs8',
      Uint8Array.from(atob(GP_PRIVATE_KEY), c => c.charCodeAt(0)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    .catch(() => null);
  return _keyPromise;
}

/**
 * Return a signed token for `payload`, or '' if no private key is configured.
 * The resolver reconstructs the same payload string and verifies against it, so
 * the two must match byte for byte. Key import is cached after first use.
 */
export async function signRequestToken(payload) {
  const key = await getKey();
  if (!key) return '';
  const ts  = String(Math.floor(Date.now() / 1000));
  const msg = new TextEncoder().encode(`${ts}\n${payload}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg);
  return `${ts}.${b64url(sig)}`;
}

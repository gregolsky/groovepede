/**
 * Client-side request signing for the Groovepede resolver proxy.
 *
 * Produces a short-lived ECDSA-P256 signed token bound to the album URL so that
 * a token sniffed from network traffic is only valid for that one URL and only for
 * 5 minutes (the Lambda's replay window).
 *
 * Token format:  "<unix_seconds>.<base64url(ieee-p1363 signature)>"
 * Signed payload: UTF-8 bytes of "`${ts}\n${url}`"
 *
 * The private key (VITE_GP_PRIVATE_KEY) is a base64-encoded PKCS8 DER blob.
 * The matching public key (GP_PUBLIC_KEY on the Lambda) is a base64-encoded SPKI DER blob.
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
 * Return a signed request token for `url`, or '' if no private key is configured.
 * Called once per resolveAlbum() invocation; key import is cached after first use.
 */
export async function signRequestToken(url) {
  const key = await getKey();
  if (!key) return '';
  const ts  = String(Math.floor(Date.now() / 1000));
  const msg = new TextEncoder().encode(`${ts}\n${url}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg);
  return `${ts}.${b64url(sig)}`;
}

/** Reset cached key — tests only. */
export function _resetKey() { _keyPromise = null; }

import { CLIENT_ID, REDIRECT, SCOPES, TOKEN_KEY, EXPIRY_KEY, VERIFIER_KEY, REFRESH_KEY } from './config.js';

function randomStr(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function sha256(plain) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function getToken()   { return localStorage.getItem(TOKEN_KEY); }
export function tokenValid() { return !!getToken() && Date.now() < parseInt(localStorage.getItem(EXPIRY_KEY) || '0'); }
export function hasSession() { return tokenValid() || !!localStorage.getItem(REFRESH_KEY); }
export function clearToken() { [TOKEN_KEY, EXPIRY_KEY, VERIFIER_KEY, REFRESH_KEY].forEach(k => localStorage.removeItem(k)); }

export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(EXPIRY_KEY, Date.now() + data.expires_in * 1000);
      if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
      return true;
    }
  } catch { /* silent fail */ }
  return false;
}

export async function login() {
  const verifier  = randomStr(64);
  const challenge = await sha256(verifier);
  localStorage.setItem(VERIFIER_KEY, verifier);
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  window.location = 'https://accounts.spotify.com/authorize?' + p;
}

export async function exchangeCode(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT, client_id: CLIENT_ID,
      code_verifier: localStorage.getItem(VERIFIER_KEY),
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem(TOKEN_KEY, data.access_token);
    localStorage.setItem(EXPIRY_KEY, Date.now() + data.expires_in * 1000);
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
    localStorage.removeItem(VERIFIER_KEY);
    return true;
  }
  return false;
}

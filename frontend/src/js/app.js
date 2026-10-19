/**
 * Entry point: styles, then boot. Everything else lives in its layer —
 * see "Architecture" in CLAUDE.md.
 */
import '../css/style.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/geist-mono';
import { initBeacon, reportFailure } from './infra/beacon.js';
import { enrichUntagged } from './services/enrich.js';
import { rerender } from './ui/state.js';
import { bindEvents } from './ui/actions.js';
import { beginShareLaunch } from './ui/share-launch.js';
import { resolvePendingAlbums } from './ui/profile.js';

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Offline support is optional, so a failed registration is reported and
  // otherwise ignored (it used to be an unhandled rejection).
  navigator.serviceWorker.register('sw.js')
    .catch(err => reportFailure('sw-register-failed', { msg: err?.name || String(err) }));
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) window.location.reload();
  });
}

async function boot() {
  bindEvents();
  initBeacon();
  // First, before any await: a share launch shows its overlay in frame one.
  const share = beginShareLaunch(window.location.search);
  if (navigator.storage?.persist) navigator.storage.persist();

  rerender();
  resolvePendingAlbums(); // stubs left over from previous sessions
  await share?.complete();

  enrichUntagged(rerender);
  registerServiceWorker();
}

boot();

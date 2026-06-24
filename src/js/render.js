import { tokenValid, hasSession } from './auth.js';
import { loadAlbums, loadDone, getPreferredService } from './storage.js';
import { isSyncEnabled, getSyncStatus, getPlaylistId } from './sync.js';
import { serviceLabel } from './services.js';

const SPOTIFY_ICON = 'M84 0C37.6 0 0 37.6 0 84s37.6 84 84 84 84-37.6 84-84S130.4 0 84 0zm38.5 121.2c-1.5 2.5-4.8 3.3-7.3 1.7-20-12.2-45.2-15-74.9-8.2-2.9.7-5.7-1.1-6.4-4-.7-2.9 1.1-5.7 4-6.4 32.5-7.4 60.4-4.2 82.9 9.5 2.5 1.6 3.3 4.9 1.7 7.4zm10.3-22.8c-2 3.1-6.1 4.1-9.2 2.1-22.9-14.1-57.8-18.1-84.9-9.9-3.4 1-7.1-.9-8.2-4.3-1-3.4.9-7.1 4.3-8.2 31-9.4 69.5-4.9 95.8 11.2 3.1 2 4.1 6.1 2.2 9.1zm.9-23.7C108.4 59 63.5 57.6 37.8 65.5c-4.1 1.2-8.4-1.1-9.6-5.2-1.2-4.1 1.1-8.4 5.2-9.6 29.7-9 79.1-7.3 110.3 11 3.7 2.2 4.9 6.9 2.7 10.5-2.1 3.7-6.9 4.9-10.5 2.7z';

function spotifyIcon(w, h) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 168 168" fill="currentColor"><path d="${SPOTIFY_ICON}"/></svg>`;
}

// Last.fm icon — stylised "lfm" scrobble mark
function lastfmIcon(w, h) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M11.07 15.73l-.7-1.9s-1.14 1.27-2.84 1.27c-1.5 0-2.57-1.31-2.57-3.4 0-2.68 1.35-3.64 2.68-3.64 1.92 0 2.52 1.24 3.04 2.84l.7 2.12c.7 2.12 2.02 3.82 5.8 3.82 2.72 0 4.56-1.68 4.56-3.84 0-2.24-1.28-3.4-3.68-3.96l-1.12-.24c-1.24-.28-1.6-.76-1.6-1.56 0-.92.72-1.46 1.88-1.46 1.28 0 1.96.48 2.08 1.64l2.66-.32c-.24-2.32-1.8-3.28-4.6-3.28-2.4 0-4.48 1.12-4.48 3.76 0 1.8.88 2.96 3.08 3.48l1.2.28c1.44.32 2.08.88 2.08 1.88 0 1.12-.96 1.76-2.28 1.76-2.2 0-3.08-1.16-3.6-2.72l-.72-2.12C11.67 8.17 10.23 6.5 7.15 6.5 3.87 6.5 2 8.9 2 11.73c0 2.68 1.44 5.32 5.27 5.32 2.16 0 3.8-1.32 3.8-1.32z"/>
  </svg>`;
}

const CHECKMARK_SVG = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5,6 4.5,9 10.5,3"/></svg>`;
const PLAY_SVG      = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>`;
const X_SVG         = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;

function todayStr() { return new Date().toISOString().slice(0, 10); }

function timeAgo(iso) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function allTags(albums) {
  const s = new Set();
  albums.forEach(a => (a.tags || []).forEach(t => s.add(t)));
  return [...s].sort();
}

export function tagsByFrequency(albums) {
  const counts = {};
  for (const album of albums) {
    for (const tag of (album.tags || [])) counts[tag] = (counts[tag] || 0) + 1;
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const q = query.trim().toLowerCase();
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + '<mark class="hl">' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>'
    + escapeHtml(text.slice(idx + q.length));
}

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export { serviceLabel };

export function pickListenUrl(album, prefService) {
  const links = album.links || {};

  // 1. preferred service nativeUri
  if (links[prefService]?.nativeUri) return links[prefService].nativeUri;
  // 2. preferred service web url
  if (links[prefService]?.url) return links[prefService].url;

  // 3. first available nativeUri from any service
  for (const entry of Object.values(links)) {
    if (entry?.nativeUri) return entry.nativeUri;
  }
  // 4. first available url from any service
  for (const entry of Object.values(links)) {
    if (entry?.url) return entry.url;
  }

  // 5. last resort
  return album.sourceUrl || null;
}

/**
 * True when the album has a usable link (url or nativeUri) for the preferred
 * service. Used to decide whether to show the Listen button as enabled or
 * disabled (with an X) — avoids silently opening a different service.
 */
export function isOnPreferredService(album, prefService) {
  const e = album.links?.[prefService];
  return !!(e && (e.url || e.nativeUri));
}

/**
 * Render the Listen button for a resolved album.
 * Disabled + X icon when the album isn't on the user's preferred service.
 * @param {object} album
 * @param {string} prefService
 * @param {{ showService?: boolean }} opts — show "Listen on Spotify" vs "Listen"
 */
function renderListenBtn(album, prefService, { showService = false } = {}) {
  const svcName = serviceLabel(prefService);
  if (isOnPreferredService(album, prefService)) {
    const url = pickListenUrl(album, prefService);
    const label = showService ? `Listen on ${escapeHtml(svcName)}` : 'Listen';
    return `<button class="btn btn-listen" data-action="listen" data-url="${attr(url)}">${PLAY_SVG} ${label}</button>`;
  }
  return `<button class="btn btn-listen btn-listen--unavailable" disabled title="${attr(`Not available on ${svcName}`)}">${X_SVG} Not on ${escapeHtml(svcName)}</button>`;
}

// ── Auth area ─────────────────────────────────────────────────────────────────

export function renderAuthArea(el, userProfile) {
  if (!hasSession()) {
    el.innerHTML = `
      <div class="auth-area-logged-out">
        <button class="profile-icon-btn" data-action="open-profile" aria-label="Profile &amp; settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
          </svg>
        </button>
        <button class="auth-btn auth-btn--small" data-action="login">${spotifyIcon(14, 14)} Connect Spotify</button>
      </div>`;
    return;
  }
  const img  = userProfile?.images?.[0]?.url;
  const name = userProfile?.display_name || '';
  el.innerHTML = `
    <div class="user-pill">
      <button class="user-avatar-btn" data-action="open-profile" aria-label="Your profile">
        ${img ? `<img class="user-avatar" src="${attr(img)}" alt="">` : spotifyIcon(20, 20)}
      </button>
      ${name ? `<span class="user-name">${name}</span>` : ''}
    </div>`;
}

// ── Empty-state hero (shown when queue has 0 albums) ─────────────────────────

function renderHero({ loadingAdd, addError, addOpen }) {
  const addSection = addOpen ? `
    <div class="landing-add-open">
      <div class="add-reveal">
        <input class="add-input" id="url-input" placeholder="Paste a music album link from Spotify, Apple Music, YouTube…">
        <button class="add-btn" data-action="add" ${loadingAdd ? 'disabled' : ''}>
          ${loadingAdd ? '<div class="spinner"></div>' : 'Add'}
        </button>
      </div>
      ${addError ? `<div class="add-error">${addError}</div>` : ''}
    </div>` : `
    <button class="auth-btn landing-cta" data-action="toggle-add">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      Paste a music album link
    </button>
    <p class="landing-note">Spotify &middot; Apple Music &middot; YouTube Music &middot; Tidal &middot; Deezer &middot; and more</p>`;

  return `
    <div class="landing">
      <div class="landing-hero">
        <div class="landing-hero-text">
          <h2 class="landing-headline">Never lose a great album<br>recommendation again.</h2>
          <p class="landing-sub">Paste a link from any streaming service, explore by genre, and check albums off as you listen.</p>
          ${addSection}
          <p class="landing-hero-faq"><a href="faq.html" class="landing-hero-faq-link">Frequently asked questions →</a></p>
        </div>
        <div class="landing-hero-visual">
          <div class="landing-logo-wrap">
            <div class="landing-logo-rings"></div>
            <img class="landing-logo" src="favicon.png" alt="Groovepede">
          </div>
        </div>
      </div>

      <div class="landing-features">
        <div class="landing-feature">
          <div class="landing-feature-img-wrap">
            <img class="landing-feature-img" src="img/feature-save.webp" width="1081" height="808" alt="" onerror="this.style.visibility='hidden'" loading="lazy">
            <div class="landing-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FD287" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                <polyline points="16 6 12 2 8 6"/>
                <line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
            </div>
          </div>
          <div class="landing-feature-body">
            <h3>Save from anywhere</h3>
            <p>Paste links from Spotify, Apple Music, YouTube Music, Tidal, Deezer, and more. Or share directly from your phone's music app.</p>
          </div>
        </div>
        <div class="landing-feature">
          <div class="landing-feature-img-wrap">
            <img class="landing-feature-img" src="img/feature-genres.webp" width="1081" height="808" alt="" onerror="this.style.visibility='hidden'" loading="lazy">
            <div class="landing-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FD287" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
            </div>
          </div>
          <div class="landing-feature-body">
            <h3>Auto-tagged genres</h3>
            <p>Every album is enriched with genre tags from Last.fm. Filter your queue by mood or style at a glance.</p>
          </div>
        </div>
        <div class="landing-feature">
          <div class="landing-feature-img-wrap">
            <img class="landing-feature-img" src="img/feature-local.webp" width="1081" height="808" alt="" onerror="this.style.visibility='hidden'" loading="lazy">
            <div class="landing-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FD287" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
          </div>
          <div class="landing-feature-body">
            <h3>Fully local</h3>
            <p>Your queue lives in your browser's storage. Nothing is sent to our servers &mdash; because there are none.</p>
          </div>
        </div>
      </div>

      <div class="landing-steps">
        <h3 class="landing-section-title">How it works</h3>
        <div class="landing-timeline">
          <div class="landing-timeline-step">
            <div class="landing-timeline-num">1</div>
            <img class="landing-timeline-img" src="img/step-paste.webp" width="1081" height="808" alt="" onerror="this.style.visibility='hidden'" loading="lazy">
            <strong class="landing-timeline-title">Paste a link</strong>
            <p class="landing-timeline-caption">Copy an album URL from any supported service and paste it in. Or share directly from your phone's music app.</p>
          </div>
          <div class="landing-timeline-step">
            <div class="landing-timeline-num">2</div>
            <img class="landing-timeline-img" src="img/step-service.webp" width="1081" height="808" alt="" onerror="this.style.visibility='hidden'" loading="lazy">
            <strong class="landing-timeline-title">Pick your service</strong>
            <p class="landing-timeline-caption">Set your preferred streaming service in the profile so the Listen button always opens in the right app.</p>
          </div>
          <div class="landing-timeline-step">
            <div class="landing-timeline-num">3</div>
            <img class="landing-timeline-img" src="img/step-listen.webp" width="1081" height="808" alt="" onerror="this.style.visibility='hidden'" loading="lazy">
            <strong class="landing-timeline-title">Listen. Done. Repeat.</strong>
            <p class="landing-timeline-caption">When you're ready, tap Listen. Tap Done when finished to track your progress.</p>
          </div>
        </div>
      </div>

    </div>`;
}

// ── Profile overlay ───────────────────────────────────────────────────────────

function renderSyncSection() {
  const enabled = isSyncEnabled();
  const { status, lastSyncedAt, lastError } = getSyncStatus();

  let statusLine = '';
  if (enabled) {
    if (status === 'syncing') {
      statusLine = '<span class="sync-status sync-status--active">Syncing…</span>';
    } else if (status === 'error') {
      statusLine = `<span class="sync-status sync-status--error">${attr(lastError || 'Sync failed')}</span>`;
    } else if (lastSyncedAt) {
      const secs = Math.round((Date.now() - lastSyncedAt) / 1000);
      const ago  = secs < 60 ? 'just now' : secs < 3600 ? Math.floor(secs / 60) + 'm ago' : Math.floor(secs / 3600) + 'h ago';
      statusLine = `<span class="sync-status">Synced ${ago}</span>`;
    } else {
      statusLine = '<span class="sync-status">Not synced yet</span>';
    }
  }

  return `
    <div class="profile-sync">
      <div class="profile-sync-row">
        <div class="profile-sync-label">
          <span class="profile-sync-title">Sync to Spotify playlist</span>
          ${enabled ? statusLine : '<span class="sync-status">Keeps your queue safe across devices</span>'}
        </div>
        <button class="sync-toggle ${enabled ? 'sync-toggle--on' : ''}" data-action="toggle-sync" aria-pressed="${enabled}">
          <span class="sync-toggle-knob"></span>
        </button>
      </div>
    </div>`;
}

const PREF_SERVICE_OPTIONS = [
  { slug: 'spotify',    label: 'Spotify' },
  { slug: 'apple',      label: 'Apple Music' },
  { slug: 'youtube',    label: 'YouTube Music' },
  { slug: 'deezer',     label: 'Deezer' },
  { slug: 'tidal',      label: 'Tidal' },
  { slug: 'amazon',     label: 'Amazon Music' },
];

function renderPrefServiceSection(prefService) {
  return `
    <div class="profile-pref-service">
      <div class="profile-pref-service-label">Listen on</div>
      <div class="profile-pref-service-options">
        ${PREF_SERVICE_OPTIONS.map(({ slug, label }) => `
        <label class="pref-service-option${prefService === slug ? ' active' : ''}">
          <input type="radio" name="pref-service" value="${slug}" data-action="set-pref-service" ${prefService === slug ? 'checked' : ''}>
          ${label}
        </label>`).join('')}
      </div>
    </div>`;
}

function renderProfile(userProfile, prefService) {
  const loggedIn = hasSession();
  const img    = userProfile?.images?.[0]?.url;
  const name   = userProfile?.display_name || '';
  const id     = userProfile?.id || '';
  const albums = loadAlbums();
  const tags   = allTags(albums);
  return `
    <div class="profile">
      <div class="profile-nav">
        <button class="profile-back" data-action="close-profile">← Back</button>
      </div>
      <div class="profile-body">
        ${loggedIn && img ? `<img class="profile-avatar" src="${attr(img)}" alt="">` : ''}
        ${loggedIn && name ? `<div class="profile-name">${name}</div>` : ''}
        ${loggedIn && id   ? `<div class="profile-id">@${attr(id)}</div>` : ''}
        <div class="profile-stats">
          <div class="stat"><div class="stat-num">${albums.length}</div><div class="stat-label">queued</div></div>
          <div class="stat"><div class="stat-num green">${loadDone()}</div><div class="stat-label">listened</div></div>
          <div class="stat"><div class="stat-num">${tags.length}</div><div class="stat-label">tags</div></div>
        </div>
        ${renderPrefServiceSection(prefService)}
        ${loggedIn ? renderSyncSection() : `
        <div class="profile-connect">
          <div class="profile-connect-label">Sync to Spotify (optional)</div>
          <div class="profile-connect-desc">Connect to back up your queue as a private Spotify playlist and keep it in sync across devices.</div>
          <button class="auth-btn profile-connect-btn" data-action="login">${spotifyIcon(14, 14)} Connect with Spotify</button>
        </div>`}
        <div class="profile-actions">
          <button class="profile-action-btn" data-action="export-data">Export queue</button>
          <button class="profile-action-btn" data-action="import-data">Import queue</button>
          <input type="file" id="profile-import-input" accept="application/json" style="display:none">
        </div>
        ${loggedIn ? `
        <details class="profile-advanced">
          <summary class="profile-advanced-summary">Advanced</summary>
          <div class="profile-advanced-body">
            <p class="profile-advanced-desc">Restore replaces your current queue with the contents of your Spotify playlist. This cannot be undone.</p>
            <button class="profile-action-btn" data-action="restore-sync" ${!isSyncEnabled() || !getPlaylistId() ? 'disabled' : ''}>Restore from Spotify playlist</button>
          </div>
        </details>
        <div class="profile-actions profile-actions--bottom">
          <button class="auth-btn secondary" data-action="logout">Log out of Spotify</button>
        </div>` : ''}
      </div>
    </div>`;
}

// ── Import summary modal ──────────────────────────────────────────────────────

function renderImportSummaryModal({ added, failed }) {
  return `
  <div class="import-summary-overlay" role="dialog" aria-modal="true" aria-label="Import complete">
    <div class="import-summary">
      <div class="import-summary-top">
        <h2 class="import-summary-title">Import complete</h2>
        <button class="import-summary-close" data-action="close-import-summary" aria-label="Dismiss">✕</button>
      </div>
      <p class="import-summary-added">
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="#0FD287" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1.5,6 4.5,9 10.5,3"/></svg>
        ${added} album${added !== 1 ? 's' : ''} added to your queue
      </p>
      ${failed.length ? `
      <div class="import-summary-failed">
        <p class="import-summary-failed-title">${failed.length} link${failed.length !== 1 ? 's' : ''} couldn't be resolved</p>
        <ul class="import-summary-failed-list">
          ${failed.map(u => `<li><a class="import-summary-link" href="${attr(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a></li>`).join('')}
        </ul>
        <button class="profile-action-btn import-summary-copy" data-action="copy-import-links">Copy links</button>
      </div>` : ''}
      <button class="auth-btn import-summary-dismiss" data-action="close-import-summary">Done</button>
    </div>
  </div>`;
}

// ── Main app ──────────────────────────────────────────────────────────────────

export function renderApp(el, { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex, addError, profileOpen, userProfile, searchQuery, tagsExpanded, addOpen, prefService, importProgress, importSummary }) {
  const albums  = loadAlbums();
  let visible = activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));
  const q = searchQuery?.trim().toLowerCase();
  if (q) visible = visible.filter(a => (a.title || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q));

  if (profileOpen) {
    el.innerHTML = renderProfile(userProfile, prefService);
    return;
  }

  if (exploreIndex !== null) {
    const album  = visible[exploreIndex];
    const cached = album ? artistCache[album.artist] : null;
    const tracks = album ? (trackCache[album.id] || null) : null;
    el.innerHTML = renderExploreCard(album, cached, tracks, exploreIndex, visible.length, prefService);
    return;
  }

  // Empty queue → show the hero landing. Exception: if an import summary is
  // waiting, keep it visible over the (now-empty) queue so the user sees the result.
  if (albums.length === 0) {
    let html = renderHero({ loadingAdd, addError, addOpen });
    if (importSummary) html += renderImportSummaryModal(importSummary);
    el.innerHTML = html;
    return;
  }

  const addedToday = albums.filter(a => (a.addedAt || '').slice(0, 10) === todayStr()).length;

  let html = `
    <div class="stats">
      <div class="stat"><div class="stat-num">${albums.length}</div><div class="stat-label">queued</div></div>
      <div class="stat"><div class="stat-num green">${loadDone()}</div><div class="stat-label">listened</div></div>
      <div class="stat"><div class="stat-num">${addedToday}</div><div class="stat-label">added today</div></div>
    </div>
    <div class="top-toolbar">
      <div class="search-wrap">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="search-input" id="search-input" placeholder="Search albums or artists…" value="${attr(searchQuery || '')}" autocomplete="off">
        ${searchQuery ? `<button class="search-clear" data-action="clear-search" aria-label="Clear search">&times;</button>` : ''}
      </div>
      <button class="add-toggle${addOpen ? ' active' : ''}" data-action="toggle-add" aria-expanded="${addOpen}">+ Add</button>
    </div>
    ${addOpen ? `
    <div class="add-reveal">
      <input class="add-input" id="url-input" placeholder="Paste an album link from Spotify, Apple Music, YouTube…">
      <button class="add-btn" data-action="add" ${loadingAdd ? 'disabled' : ''}>
        ${loadingAdd ? '<div class="spinner"></div>' : 'Add'}
      </button>
    </div>
    ${addError ? `<div class="add-error">${addError}</div>` : ''}` : ''}`;

  if (importProgress) {
    const pct      = importProgress.total > 0 ? (importProgress.done / importProgress.total * 100) : 0;
    const waiting  = (importProgress.retrying || 0) > 0;
    const label    = waiting
      ? `Rate limited — retrying&hellip; <span class="import-progress-retry">(${importProgress.retrying})</span> &bull; ${importProgress.done} / ${importProgress.total}`
      : `Fetching links &amp; tags &mdash; <span>${importProgress.done} / ${importProgress.total}</span>`;
    html += `
    <div class="import-progress${waiting ? ' import-progress--waiting' : ''}">
      <div class="import-progress-label">${label}</div>
      <div class="import-progress-track"><div class="import-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
  }

  const tagFreqList = tagsByFrequency(albums);
  if (tagFreqList.length) {
    const TOP_N = 6;
    const showMore = tagFreqList.length > 7;
    let displayTags;
    if (showMore && !tagsExpanded) {
      let topN = tagFreqList.slice(0, TOP_N);
      if (activeFilter !== 'all' && !topN.includes(activeFilter)) topN[TOP_N - 1] = activeFilter;
      displayTags = topN;
    } else {
      displayTags = tagFreqList;
    }
    html += `
      <div class="filter-bar">
        <button class="filter-chip ${activeFilter === 'all' ? 'active' : ''}" data-action="filter" data-tag="all">All</button>
        ${displayTags.map(t => `
        <button class="filter-chip ${activeFilter === t ? 'active' : ''}" data-action="filter" data-tag="${attr(t)}">${t}</button>`).join('')}
        ${showMore ? `<button class="tag-more" data-action="toggle-tags">${tagsExpanded ? 'Less ▴' : 'More ▾'}</button>` : ''}
      </div>`;
  }

  html += '<div class="list">';
  html += visible.length ? renderCards(visible, albums, searchQuery, prefService) : renderEmpty(activeFilter, searchQuery);
  html += '</div>';

  if (importSummary) html += renderImportSummaryModal(importSummary);
  el.innerHTML = html;
}

function renderEmpty(activeFilter, searchQuery) {
  const icon = `<div class="empty-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#444" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="#444" stroke="none"/></svg></div>`;
  if (searchQuery?.trim()) {
    return `<div class="empty">${icon}<div class="empty-title">No matches for &ldquo;${escapeHtml(searchQuery.trim())}&rdquo;</div><div class="empty-body"><button class="empty-clear" data-action="clear-search">Clear search</button></div></div>`;
  }
  const noTag = activeFilter !== 'all';
  if (noTag) {
    return `<div class="empty">${icon}<div class="empty-title">No albums with this tag</div><div class="empty-body">Try a different filter.</div></div>`;
  }
  // "All" filter but no albums — shouldn't normally be reached now that albums.length===0
  // goes to the hero; but guard just in case (e.g. pending records only / cleared mid-render)
  return `<div class="empty">${icon}<div class="empty-title">Nothing here</div><div class="empty-body">Tap <strong>+ Add</strong> to paste a link.</div></div>`;
}

function renderPendingCard(album, visibleIdx) {
  const svcLabel = serviceLabel(album.service) || 'Music link';
  const listenUrl = album.sourceUrl || null;
  return `
    <div class="card card--pending" id="card-${attr(album.id)}">
      <div class="card-main">
        <div class="card-cover">
          <div class="card-cover-placeholder card-cover-placeholder--pending">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#444" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
        </div>
        <div class="card-body">
          <div class="card-title card-title--pending">${escapeHtml(svcLabel)}</div>
          <div class="card-artist card-artist--pending">Looking up details…</div>
          <div class="card-meta">Added ${timeAgo(album.addedAt)} · resolving</div>
        </div>
        <div class="card-actions">
          ${listenUrl ? `
          <button class="btn btn-listen" data-action="listen" data-url="${attr(listenUrl)}">${PLAY_SVG} Listen</button>` : ''}
          <button class="btn btn-done" data-action="done" data-index="${visibleIdx}">${CHECKMARK_SVG} Done</button>
        </div>
      </div>
    </div>`;
}

function renderCards(visible, albums, searchQuery, prefService) {
  return visible.map((album, visibleIdx) => {
    if (album._pending) return renderPendingCard(album, visibleIdx);

    const tagHtml = [
      album.year ? `<span class="tag year">${album.year}</span>` : '',
      ...(album.tags || []).map(t => `<span class="tag genre" data-action="filter" data-tag="${attr(t)}">${escapeHtml(t)}</span>`),
    ].filter(Boolean).join('');

    return `
      <div class="card" id="card-${album.id}" data-action="explore" data-index="${visibleIdx}" role="button" tabindex="0" style="--i:${visibleIdx}">
        <div class="card-main">
          <div class="card-cover">
            ${album.cover
              ? `<img src="${attr(album.cover)}" alt="" loading="lazy">`
              : `<div class="card-cover-placeholder">
                   <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1">
                     <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>
                     <circle cx="12" cy="12" r="1.5" fill="#333" stroke="none"/>
                   </svg>
                 </div>`}
          </div>
          <div class="card-body">
            <div class="card-title">${highlightMatch(album.title || 'Unknown album', searchQuery)}</div>
            <div class="card-artist">${highlightMatch(album.artist || '', searchQuery)}</div>
            ${tagHtml ? `<div class="card-tags">${tagHtml}</div>` : ''}
            <div class="card-meta">Added ${timeAgo(album.addedAt)}</div>
          </div>
          <div class="card-actions">
            ${renderListenBtn(album, prefService)}
            <button class="btn btn-done" data-action="done" data-index="${visibleIdx}">${CHECKMARK_SVG} Done</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Explore card ──────────────────────────────────────────────────────────────

function renderExploreCard(album, cached, tracks, index, total, prefService) {
  const hasPrev = index > 0;
  const hasNext = index < total - 1;
  const loading = !cached;

  const image      = cached?.image     || null;
  const fullBio    = cached?.fullBio   || '';
  const similar    = cached?.similar   || [];
  const tags       = cached?.tags      || [];
  const genres     = cached?.genres    || [];
  const spotifyUrl = cached?.spotifyUrl || null;
  const lastfmUrl  = cached?.lastfmUrl  || null;
  const mergedTags = [...new Set([...genres, ...tags])];

  const links = [
    lastfmUrl  ? `<a class="explore-link explore-link--lastfm" href="${attr(lastfmUrl)}" target="_blank">${lastfmIcon(12, 12)} Last.fm</a>` : '',
  ].filter(Boolean).join('');

  const tracklistHtml = tracks === null
    ? `<div class="explore-loading">Loading tracks…</div>`
    : tracks.length
      ? `<ol class="explore-tracklist">
          ${tracks.map(t => `
            <li class="explore-track">
              <span class="explore-track-name">${escapeHtml(t.name)}</span>
              <span class="explore-track-dur">${fmtDuration(t.duration_ms)}</span>
            </li>`).join('')}
        </ol>`
      : '';

  return `
    <div class="explore">
      <div class="explore-nav">
        <button class="explore-back" data-action="close-explore">← Back</button>
        <span class="explore-counter">${index + 1} / ${total}</span>
        <div class="explore-arrows">
          <button class="explore-arrow" data-action="explore-prev" ${hasPrev ? '' : 'disabled'} aria-label="Previous">‹</button>
          <button class="explore-arrow" data-action="explore-next" ${hasNext ? '' : 'disabled'} aria-label="Next">›</button>
        </div>
      </div>

      ${loading ? `<div class="explore-loading" style="margin-top:48px;text-align:center">Loading…</div>` : `

      <div class="explore-album">
        ${album.cover ? `<img class="explore-album-cover" src="${attr(album.cover)}" alt="${attr(album.title || '')}">` : ''}
        <div class="explore-album-meta">
          <h3 class="explore-album-title">${escapeHtml(album.title || 'Unknown album')}</h3>
          ${album.year ? `<span class="explore-album-year">${album.year}</span>` : ''}
        </div>
        <div class="explore-album-actions">
          ${renderListenBtn(album, prefService, { showService: true })}
          <button class="btn btn-done" data-action="explore-done" data-index="${index}">Done</button>
        </div>
        ${tracklistHtml}
      </div>

      <div class="explore-artist">
        <div class="explore-artist-hero">
          ${image
            ? `<img class="explore-artist-image" src="${attr(image)}" alt="${attr(album.artist)}">`
            : `<div class="explore-artist-image explore-artist-image--placeholder"></div>`}
          <div class="explore-artist-info">
            <h2 class="explore-artist-name">${escapeHtml(album.artist || '')}</h2>
            ${mergedTags.length ? `<div class="explore-tags">${mergedTags.map(t => `<span class="tag genre">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            <div class="explore-links">
              ${spotifyUrl ? `<a class="explore-link explore-link--spotify" href="${attr(spotifyUrl)}" target="_blank">${spotifyIcon(12, 12)} Follow on Spotify</a>` : ''}
              ${links}
            </div>
          </div>
        </div>
        ${fullBio ? `<p class="explore-bio">${fullBio}</p>` : ''}
        ${similar.length ? `
          <div class="explore-section-label">Similar artists</div>
          <div class="similar-list">
            ${similar.map(a => `<a class="similar-chip" href="${attr(a.url)}" target="_blank">${escapeHtml(a.name)}</a>`).join('')}
          </div>` : ''}
      </div>

      `}
    </div>`;
}

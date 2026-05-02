import { tokenValid, hasSession } from './auth.js';
import { loadAlbums, loadDone } from './storage.js';

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

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Auth area ─────────────────────────────────────────────────────────────────

export function renderAuthArea(el, userProfile) {
  if (!hasSession()) {
    el.innerHTML = `
      <button class="auth-btn" data-action="login">
        ${spotifyIcon(14, 14)} Connect Spotify
      </button>`;
    return;
  }
  const img  = userProfile?.images?.[0]?.url;
  const name = userProfile?.display_name || '';
  el.innerHTML = `
    <div class="user-pill">
      ${img  ? `<img class="user-avatar" src="${attr(img)}" alt="">` : ''}
      ${name ? `<span class="user-name">${name}</span>` : ''}
      <button class="auth-btn secondary" data-action="logout">Log out</button>
    </div>`;
}

// ── Main app ──────────────────────────────────────────────────────────────────

export function renderApp(el, { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex, addError }) {
  const albums  = loadAlbums();
  const visible = activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));

  if (exploreIndex !== null) {
    const album  = visible[exploreIndex];
    const cached = album ? artistCache[album.artist] : null;
    const tracks = album ? (trackCache[album.id] || null) : null;
    el.innerHTML = renderExploreCard(album, cached, tracks, exploreIndex, visible.length);
    return;
  }

  if (!hasSession()) {
    el.innerHTML = `
      <div class="landing">
        <div class="landing-hero">
          <img class="landing-logo" src="favicon.png" alt="Groovepede">
          <h2 class="landing-headline">Never lose a great album<br>recommendation again.</h2>
          <p class="landing-sub">A lightweight listening inbox for Spotify albums. Save picks from your phone's share sheet, explore them by genre, and check them off as you listen.</p>
          <button class="auth-btn landing-cta" data-action="login">
            ${spotifyIcon(16, 16)} Connect with Spotify
          </button>
          <p class="landing-note">Free &middot; No account &middot; Your queue stays in your browser</p>
        </div>

        <div class="landing-features">
          <div class="landing-feature">
            <div class="landing-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                <polyline points="16 6 12 2 8 6"/>
                <line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
            </div>
            <h3>Share from Spotify</h3>
            <p>Tap Share &rarr; Groovepede from the Spotify app. Albums appear instantly with cover art and genre tags.</p>
          </div>
          <div class="landing-feature">
            <div class="landing-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
            </div>
            <h3>Auto-tagged genres</h3>
            <p>Every album is enriched with genre tags from Last.fm. Filter your queue by mood or style at a glance.</p>
          </div>
          <div class="landing-feature">
            <div class="landing-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <h3>Fully local</h3>
            <p>Your queue lives in your browser's storage. Nothing is sent to our servers &mdash; because there are none.</p>
          </div>
        </div>

        <div class="landing-steps">
          <h3 class="landing-section-title">How it works</h3>
          <ol class="landing-step-list">
            <li><strong>Open &amp; install</strong> &mdash; Connect with Spotify and add Groovepede to your home screen.</li>
            <li><strong>Share albums</strong> &mdash; In the Spotify app, tap Share on any album and choose Groovepede.</li>
            <li><strong>Listen &amp; done</strong> &mdash; When you're ready, tap Listen. Tap Done when finished to track your progress.</li>
          </ol>
        </div>

        <div class="landing-faq">
          <h3 class="landing-section-title">FAQ</h3>
          <details class="faq-item">
            <summary>Is it free?</summary>
            <p>Yes, completely. No subscription, no ads, no upsell.</p>
          </details>
          <details class="faq-item">
            <summary>What Spotify data does it access?</summary>
            <p>Only your display name and profile picture (<code>user-read-private</code> scope) so we can show your avatar. We never read your listening history, playlists, or library.</p>
          </details>
          <details class="faq-item">
            <summary>Where is my queue stored?</summary>
            <p>Entirely in your browser's <code>localStorage</code>. Nothing leaves your device.</p>
          </details>
          <details class="faq-item">
            <summary>Does it work on iPhone?</summary>
            <p>Yes &mdash; the app works in Safari on iOS. The Android share-sheet integration isn't available on iPhone (Apple limits PWA share targets), but you can paste any Spotify album link directly into the add bar.</p>
          </details>
          <details class="faq-item">
            <summary>Can I use it on desktop?</summary>
            <p>Yes. Install it as a PWA from Chrome or Edge, or just use it in any browser tab. Paste Spotify album links into the add bar to queue them.</p>
          </details>
        </div>
      </div>`;
    return;
  }

  const tags       = allTags(albums);
  const addedToday = albums.filter(a => (a.addedAt || '').slice(0, 10) === todayStr()).length;

  let html = `
    <div class="stats">
      <div class="stat"><div class="stat-num">${albums.length}</div><div class="stat-label">queued</div></div>
      <div class="stat"><div class="stat-num green">${loadDone()}</div><div class="stat-label">listened</div></div>
      <div class="stat"><div class="stat-num">${addedToday}</div><div class="stat-label">added today</div></div>
    </div>
    <div class="add-bar">
      <input class="add-input" id="url-input" placeholder="Paste a Spotify album link or ID…">
      <button class="add-btn" data-action="add" ${loadingAdd ? 'disabled' : ''}>
        ${loadingAdd ? '<div class="spinner"></div>' : 'Add'}
      </button>
    </div>
    ${addError ? `<div class="add-error">${addError}</div>` : ''}`;

  if (tags.length) {
    html += `
      <div class="filter-bar">
        <button class="filter-chip ${activeFilter === 'all' ? 'active' : ''}" data-action="filter" data-tag="all">All</button>
        ${tags.map(t => `
        <button class="filter-chip ${activeFilter === t ? 'active' : ''}" data-action="filter" data-tag="${attr(t)}">${t}</button>`).join('')}
      </div>`;
  }

  html += '<div class="list">';
  html += visible.length ? renderCards(visible, albums) : renderEmpty(activeFilter);
  html += '</div>';

  el.innerHTML = html;
}

function renderEmpty(activeFilter) {
  const noTag = activeFilter !== 'all';
  return `
    <div class="empty">
      <div class="empty-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#444" stroke-width="1.2">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>
          <circle cx="12" cy="12" r="1.5" fill="#444" stroke="none"/>
        </svg>
      </div>
      <div class="empty-title">${noTag ? 'No albums with this tag' : 'Nothing queued yet'}</div>
      <div class="empty-body">${noTag ? 'Try a different filter.' : 'Share a Spotify album link to this app,<br>or paste one in the bar above.'}</div>
    </div>`;
}

function renderCards(visible, albums) {
  return visible.map((album, visibleIdx) => {
    const realIndex = albums.indexOf(album);

    const tagHtml = [
      album.year ? `<span class="tag year">${album.year}</span>` : '',
      ...(album.tags || []).map(t => `<span class="tag genre" data-action="filter" data-tag="${attr(t)}">${t}</span>`),
    ].filter(Boolean).join('');

    return `
      <div class="card" id="card-${album.id}" data-action="explore" data-index="${visibleIdx}" role="button" tabindex="0">
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
            <div class="card-title">${album.title || 'Unknown album'}</div>
            <div class="card-artist">${album.artist || ''}</div>
            ${tagHtml ? `<div class="card-tags">${tagHtml}</div>` : ''}
            <div class="card-meta">Added ${timeAgo(album.addedAt)}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-listen" data-action="listen" data-url="${attr(album.url)}">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
              Listen
            </button>
            <button class="btn btn-done" data-action="done" data-index="${visibleIdx}">${CHECKMARK_SVG} Done</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Explore card ──────────────────────────────────────────────────────────────

function renderExploreCard(album, cached, tracks, index, total) {
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
              <span class="explore-track-name">${t.name}</span>
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
          <h3 class="explore-album-title">${album.title || 'Unknown album'}</h3>
          ${album.year ? `<span class="explore-album-year">${album.year}</span>` : ''}
        </div>
        <div class="explore-album-actions">
          <button class="btn btn-listen" data-action="listen" data-url="${attr(album.url)}">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
            Listen on Spotify
          </button>
          <button class="btn btn-done" data-action="done" data-index="${index}">Done</button>
        </div>
        ${tracklistHtml}
      </div>

      <div class="explore-artist">
        <div class="explore-artist-hero">
          ${image
            ? `<img class="explore-artist-image" src="${attr(image)}" alt="${attr(album.artist)}">`
            : `<div class="explore-artist-image explore-artist-image--placeholder"></div>`}
          <div class="explore-artist-info">
            <h2 class="explore-artist-name">${album.artist}</h2>
            ${mergedTags.length ? `<div class="explore-tags">${mergedTags.map(t => `<span class="tag genre">${t}</span>`).join('')}</div>` : ''}
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
            ${similar.map(a => `<a class="similar-chip" href="${attr(a.url)}" target="_blank">${a.name}</a>`).join('')}
          </div>` : ''}
      </div>

      `}
    </div>`;
}

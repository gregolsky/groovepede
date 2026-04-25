import { tokenValid, hasSession } from './auth.js';
import { loadAlbums, loadDone } from './storage.js';

const SPOTIFY_ICON = 'M84 0C37.6 0 0 37.6 0 84s37.6 84 84 84 84-37.6 84-84S130.4 0 84 0zm38.5 121.2c-1.5 2.5-4.8 3.3-7.3 1.7-20-12.2-45.2-15-74.9-8.2-2.9.7-5.7-1.1-6.4-4-.7-2.9 1.1-5.7 4-6.4 32.5-7.4 60.4-4.2 82.9 9.5 2.5 1.6 3.3 4.9 1.7 7.4zm10.3-22.8c-2 3.1-6.1 4.1-9.2 2.1-22.9-14.1-57.8-18.1-84.9-9.9-3.4 1-7.1-.9-8.2-4.3-1-3.4.9-7.1 4.3-8.2 31-9.4 69.5-4.9 95.8 11.2 3.1 2 4.1 6.1 2.2 9.1zm.9-23.7C108.4 59 63.5 57.6 37.8 65.5c-4.1 1.2-8.4-1.1-9.6-5.2-1.2-4.1 1.1-8.4 5.2-9.6 29.7-9 79.1-7.3 110.3 11 3.7 2.2 4.9 6.9 2.7 10.5-2.1 3.7-6.9 4.9-10.5 2.7z';

function spotifyIcon(w, h) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 168 168" fill="currentColor"><path d="${SPOTIFY_ICON}"/></svg>`;
}

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

export function renderApp(el, { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex }) {
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
      <div class="login-screen">
        <img class="login-logo" src="favicon.png" alt="Groovepede">
        <h2>Never lose a great album recommendation again.</h2>
        <p>Groovepede is a minimalist listening queue for Spotify albums. Save albums, browse them by genre, and check them off as you listen.</p>
        <ul class="login-features">
          <li>Share Spotify albums straight from your phone</li>
          <li>Auto-tagged with genres from Last.fm</li>
          <li>Deep artist info and track listings on every album</li>
          <li>Works offline — install it as an app</li>
        </ul>
        <button class="auth-btn" data-action="login">
          ${spotifyIcon(16, 16)} Connect with Spotify
        </button>
        <p class="login-privacy">Local-first. Your queue stays in your browser — nothing is sent anywhere except Spotify and Last.fm for metadata.</p>
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
    </div>`;

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
            <button class="btn btn-done" data-action="done" data-index="${visibleIdx}">Done</button>
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
    spotifyUrl ? `<a class="explore-link" href="${attr(spotifyUrl)}" target="_blank">${spotifyIcon(12, 12)} Spotify</a>` : '',
    lastfmUrl  ? `<a class="explore-link" href="${attr(lastfmUrl)}"  target="_blank">Last.fm</a>` : '',
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
            ${links ? `<div class="explore-links">${links}</div>` : ''}
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

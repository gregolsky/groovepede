import { tokenValid } from './auth.js';
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
  if (!tokenValid()) {
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

export function renderApp(el, { activeFilter, loadingAdd, expandedCards, artistCache }) {
  if (!tokenValid()) {
    el.innerHTML = `
      <div class="login-screen">
        <div class="login-disc">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#333" stroke-width="1.2"/>
            <circle cx="12" cy="12" r="6"  stroke="#333" stroke-width="1"/>
            <circle cx="12" cy="12" r="2"  fill="#333"/>
          </svg>
        </div>
        <h2>Your album inbox</h2>
        <p>Connect your Spotify account to save albums<br>with covers, artists, genres and more.</p>
        <button class="auth-btn" data-action="login">
          ${spotifyIcon(16, 16)} Connect with Spotify
        </button>
      </div>`;
    return;
  }

  const albums     = loadAlbums();
  const tags       = allTags(albums);
  const visible    = activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));
  const addedToday = albums.filter(a => (a.addedAt || '').slice(0, 10) === todayStr()).length;

  let html = `
    <div class="stats">
      <div class="stat"><div class="stat-num">${albums.length}</div><div class="stat-label">queued</div></div>
      <div class="stat"><div class="stat-num green">${loadDone()}</div><div class="stat-label">listened</div></div>
      <div class="stat"><div class="stat-num">${addedToday}</div><div class="stat-label">added today</div></div>
    </div>
    <div class="add-bar">
      <input class="add-input" id="url-input" placeholder="Paste a Spotify album link…">
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
  html += visible.length ? renderCards(visible, albums, expandedCards, artistCache) : renderEmpty(activeFilter);
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

function renderCards(visible, albums, expandedCards, artistCache) {
  return visible.map(album => {
    const realIndex    = albums.indexOf(album);
    const isExpanded   = expandedCards.has(album.id);
    const cachedArtist = artistCache[album.artist];

    const tagHtml = [
      album.year ? `<span class="tag year">${album.year}</span>` : '',
      ...(album.tags || []).map(t => `<span class="tag genre" data-action="filter" data-tag="${attr(t)}">${t}</span>`),
    ].filter(Boolean).join('');

    return `
      <div class="card" id="card-${album.id}">
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
            <button class="btn btn-expand" data-action="expand"
              data-album-id="${attr(album.id)}" data-artist="${attr(album.artist)}" title="Artist info">
              ${isExpanded ? '▲ Less' : '▼ Artist'}
            </button>
            <button class="btn btn-done" data-action="done" data-index="${realIndex}">Done</button>
          </div>
        </div>
        ${isExpanded ? renderArtistPanel(album, cachedArtist) : ''}
      </div>`;
  }).join('');
}

function renderArtistPanel(album, cachedArtist) {
  if (!cachedArtist) {
    return `
      <div class="artist-panel open" id="panel-${album.id}">
        <div class="loading-bio">Loading artist info…</div>
      </div>`;
  }
  const { bio, similar } = cachedArtist;
  const hasContent = bio || similar.length;
  return `
    <div class="artist-panel open" id="panel-${album.id}">
      <div class="artist-panel-header">About ${album.artist}</div>
      ${bio ? `<div class="artist-bio">${bio}</div>` : ''}
      ${similar.length ? `
        <div class="similar-label">Similar artists</div>
        <div class="similar-list">
          ${similar.map(a => `<a class="similar-chip" href="${attr(a.url)}" target="_blank">${a.name}</a>`).join('')}
        </div>` : ''}
      ${!hasContent ? `<div class="loading-bio">No artist info available.</div>` : ''}
    </div>`;
}

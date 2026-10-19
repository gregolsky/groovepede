/**
 * What the explore card shows beyond the stored record — the artist's
 * Last.fm bio/similar/tags and photo, and the album's tracklist — fetched on
 * demand and kept for the session. No DOM: `onChange(albumId)` says new data
 * for that album arrived, and the caller decides whether to rerender.
 */
import { fetchLastfmArtist, fetchArtistImage, fetchAlbumTracks } from '../infra/api.js';
import { isApiError } from '../lib/api-error.js';
import { deezerAlbumId } from '../domain/albums.js';

const artistInfo = {}; // artist name → { bio, similar, tags, lastfmUrl, image }
const tracklists = {}; // album id    → tracks[] | ApiError (failed: retry-eligible)

/** The session caches, for the renderer: never-fetched entries are absent. */
export function albumDetails() {
  return { artistCache: artistInfo, trackCache: tracklists };
}

/**
 * Fetch whatever this album's explore card is still missing.
 *
 * Retry-eligible when never fetched OR the last attempt failed (an ApiError)
 * — a plain result (even an empty array, or a {bio,similar,tags} with
 * everything blank) means "done", success or genuine no-data, and is never
 * refetched. Without the failure branch, a single transient failure used to be
 * indistinguishable from "done" and could never be retried for the session.
 */
export async function loadAlbumDetails(album, onChange) {
  const { artist, id } = album;
  const deezerId    = deezerAlbumId(album);
  const needsLastfm = !artistInfo[artist];
  const needsTracks = deezerId && (tracklists[id] === undefined || isApiError(tracklists[id]));
  // No Deezer link → no tracklist to fetch; mark empty so the card shows no
  // tracklist instead of a perpetual "Loading tracks…".
  if (!deezerId && tracklists[id] === undefined) tracklists[id] = [];

  const fetches = [];
  // On failure, leave artistInfo[artist] unset rather than caching the
  // ApiError — needsLastfm above then retries on the next explore open.
  if (needsLastfm) fetches.push(fetchLastfmArtist(artist).then(d => {
    if (!isApiError(d)) artistInfo[artist] = { ...artistInfo[artist], ...d };
  }));
  if (needsTracks) fetches.push(fetchAlbumTracks(deezerId).then(t => { tracklists[id] = t; }));

  if (fetches.length) {
    await Promise.all(fetches);
    onChange(id);
  }

  if (!artistInfo[artist]?.image) {
    const image = await fetchArtistImage(album);
    if (typeof image === 'string') {
      artistInfo[artist] = { ...artistInfo[artist], image };
      onChange(id);
    }
  }
}

/** Explicit retry for a failed tracklist: back to "Loading tracks…", then refetch. */
export function retryTracklist(album, onChange) {
  const deezerId = deezerAlbumId(album);
  if (!deezerId) return;
  delete tracklists[album.id];
  onChange(album.id);
  fetchAlbumTracks(deezerId).then(t => {
    tracklists[album.id] = t;
    onChange(album.id);
  });
}

/**
 * Drop what's known about an album so the next load refetches it — after a
 * refresh, which may have picked up a Deezer cross-link that didn't exist
 * before (a stuck failed fetch, or a stale empty tracklist, used to be the
 * one thing "Refresh details" couldn't fix).
 */
export function forgetAlbumDetails(album) {
  delete artistInfo[album.artist];
  delete tracklists[album.id];
}

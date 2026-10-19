/**
 * Background genre enrichment: Last.fm (artist, album, then similar artists)
 * topped up with Deezer genres, merged into the stored album.
 */
import { fetchArtistTags, fetchLastfmAlbum, fetchTagsFromSimilarArtists, fetchDeezerArtistData } from '../infra/api.js';
import { loadAlbums, updateAlbum } from '../infra/storage.js';
import { isApiError } from '../lib/api-error.js';
import { cleanTags } from '../domain/tags.js';
import { primaryArtistOf, deezerAlbumId, needsTagEnrichment } from '../domain/albums.js';

/** Concatenate tag lists, keeping the first occurrence of each tag, in order. */
const mergeUnique = (...lists) => [...new Set(lists.flat())];

// Fetch Last.fm tags in the background and update the saved album.
// onUpdate() is called after storage is written so the caller can re-render.
export async function enrichWithLastfm(albumId, artistName, albumTitle, onUpdate) {
  if (!artistName) return; // extraction can succeed with a title but no artist
  const primaryArtist = primaryArtistOf(artistName);

  // Fetch artist + album tags in parallel; artist tags take priority
  const [artistTags, albumData] = await Promise.all([
    fetchArtistTags(primaryArtist),
    fetchLastfmAlbum(primaryArtist, albumTitle),
  ]);

  // Read-only snapshot: only used to decide which further lookups are worth
  // making. It is never written back — see the commit at the end.
  const snapshot = loadAlbums().find(x => x.id === albumId);
  if (!snapshot) return; // left the queue while Last.fm was answering

  // The album's existing (resolver-supplied) tags come first — they're already
  // curated per-album — then artist tags, then album tags. This is an
  // enrichment pass, not a replacement: Last.fm coverage is spotty, and
  // overwriting a resolver-supplied genre with a thinner Last.fm result would
  // be a regression, not enrichment. albumData is an ApiError, not {tags},
  // when album.getinfo itself failed — treated the same as "no album tags".
  let tags = mergeUnique(snapshot.tags || [], artistTags, isApiError(albumData) ? [] : albumData.tags);

  // Fall back to similar artists if we still have nothing at all
  if (!tags.length) tags = await fetchTagsFromSimilarArtists(primaryArtist);

  // Last.fm coverage thins out fast for obscure artists. Deezer's own (coarser)
  // genre labels fill that gap — but only when Last.fm came up thin, so a
  // well-tagged mainstream album isn't diluted with broad Deezer categories.
  const deezerId = deezerAlbumId(snapshot);
  if (tags.length < 3 && deezerId) {
    const deezerData = await fetchDeezerArtistData(primaryArtist, deezerId);
    if (deezerData?.genres?.length) {
      tags = mergeUnique(tags, cleanTags(deezerData.genres.map(name => ({ name })), primaryArtist));
    }
  }

  // Last.fm answered (album.getinfo ran), so this album has been checked even
  // if nothing turned up — stamped so boot doesn't re-ask on every launch.
  // When it failed outright there's no stamp, and the next boot retries.
  const checked = !isApiError(albumData);
  if (!tags.length && !checked) return;
  // Commit in one synchronous step against the record as it is NOW, not the
  // snapshot: the awaits above can take seconds under throttling, and the
  // queue may have changed meanwhile (updateAlbum is a no-op if it's gone).
  const saved = updateAlbum(albumId, a => {
    a.tags = mergeUnique(a.tags || [], tags).slice(0, 7);
    if (checked) a.tagsCheckedAt = new Date().toISOString();
  });
  if (saved && tags.length) onUpdate?.();
}

/** Enrich every queued album that still needs genre tags (see needsTagEnrichment). */
export function enrichUntagged(onUpdate) {
  for (const album of loadAlbums().filter(a => needsTagEnrichment(a))) {
    enrichWithLastfm(album.id, album.artist, album.title, onUpdate);
  }
}

// Six synthetic, fully-resolved albums (no `_pending`, no cover images — kept
// deliberately offline, no network dependency) spanning 9 distinct tags so
// the tag bar's "More" toggle (shown once tagsByFrequency().length > 7,
// see src/js/render.js) is actually exercised.
export const WIDE_TAG_ALBUMS = [
  { id: 'smoke::1', title: 'Song for Our Grandfathers', artist: 'Broken Social Scene', sourceUrl: 'https://open.spotify.com/album/smoke1', tags: ['indie rock', 'post-rock'], links: { spotify: { url: 'https://open.spotify.com/album/smoke1' } } },
  { id: 'smoke::2', title: 'Selected Ambient Works 85-92', artist: 'Aphex Twin', sourceUrl: 'https://open.spotify.com/album/smoke2', tags: ['ambient', 'electronic'], links: { spotify: { url: 'https://open.spotify.com/album/smoke2' } } },
  { id: 'smoke::3', title: 'Damn', artist: 'Kendrick Lamar', sourceUrl: 'https://open.spotify.com/album/smoke3', tags: ['hip hop', 'rap'], links: { spotify: { url: 'https://open.spotify.com/album/smoke3' } } },
  { id: 'smoke::4', title: 'In Rainbows', artist: 'Radiohead', sourceUrl: 'https://open.spotify.com/album/smoke4', tags: ['art rock', 'experimental'], links: { spotify: { url: 'https://open.spotify.com/album/smoke4' } } },
  { id: 'smoke::5', title: 'Blue Train', artist: 'John Coltrane', sourceUrl: 'https://open.spotify.com/album/smoke5', tags: ['jazz', 'hard bop'], links: { spotify: { url: 'https://open.spotify.com/album/smoke5' } } },
  { id: 'smoke::6', title: 'Rumours', artist: 'Fleetwood Mac', sourceUrl: 'https://open.spotify.com/album/smoke6', tags: ['classic rock'], links: { spotify: { url: 'https://open.spotify.com/album/smoke6' } } },
];

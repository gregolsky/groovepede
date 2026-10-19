// Tag canonicalization shared by every tag source (resolver genres, Last.fm,
// MusicBrainz) and by the stored-queue migration in storage.js, so one album
// can never carry "Rock" from Deezer next to "rock" from Last.fm.

// Near-duplicate spellings worth collapsing into one canonical form before
// dedup: Last.fm crowd-tag variants, plus the streaming services' own genre
// names (Deezer's "Rap/Hip Hop", Apple's "Hip-Hop/Rap"). Not a general
// genre-taxonomy normalizer — just the variants seen in practice.
const CANON_MAP = {
  'hip hop':     'hip-hop',
  'hiphop':      'hip-hop',
  'rap/hip hop': 'hip-hop',
  'hip-hop/rap': 'hip-hop',
  'rnb':         'r&b',
  'r & b':       'r&b',
  'lofi':        'lo-fi',
  'lo fi':       'lo-fi',
  'synthpop':    'synth-pop',
  'postpunk':    'post-punk',
  'post punk':   'post-punk',
  'postrock':    'post-rock',
  'drum n bass': 'drum and bass',
  'dnb':         'drum and bass',
  'd&b':         'drum and bass',
};

/** Lowercased, trimmed, and mapped to its canonical spelling. */
export function canonicalTag(s) {
  const t = s.toLowerCase().trim();
  return CANON_MAP[t] || t;
}

/** Canonicalize and dedupe a stored tag list, keeping first-seen order. */
export function normalizeTags(tags) {
  const out = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = canonicalTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// 4-digit years ("1990") and 2-digit decades ("90s") are both common Last.fm
// crowd tags and neither is a genre.
const YEAR_RE = /^\d{2,4}s?$/;

// Crowd-tag noise that isn't a genre: possession/format tags and bare
// opinion tags. Not exhaustive by design — extend as more noise turns up.
const JUNK_TAGS = new Set([
  'seen live', 'favorites', 'favourite', 'under 2000 listeners',
  'albums i own', 'vinyl', 'cd', 'digital', 'owned', 'wishlist',
  'awesome', 'amazing', 'love', 'favourite song',
]);

function normalizeForCompare(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Lowercase, canonicalize near-duplicate spellings, drop junk/year tags and
 * duplicates, and drop a tag that's just the artist's own name (Last.fm
 * frequently self-tags an artist). `artistName` is the artist these specific
 * raw tags came from — the primary artist for fetchArtistTags/
 * fetchLastfmAlbum, or each similar artist in fetchTagsFromSimilarArtists.
 */
export function cleanTags(rawTags, artistName) {
  const artistNorm = artistName ? normalizeForCompare(artistName) : null;
  const seen = new Set();
  const out = [];
  for (const raw of rawTags) {
    // Upstream data: a malformed entry is skipped, not allowed to throw — this
    // runs inside fire-and-forget enrichment, where a throw is only ever an
    // unhandled rejection.
    if (typeof raw?.name !== 'string') continue;
    const t = canonicalTag(raw.name);
    if (t.length <= 1 || t.length > 25) continue;
    if (YEAR_RE.test(t) || JUNK_TAGS.has(t)) continue;
    if (artistNorm && normalizeForCompare(t) === artistNorm) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

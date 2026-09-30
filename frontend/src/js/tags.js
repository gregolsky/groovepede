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

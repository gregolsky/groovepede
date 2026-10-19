import { describe, it, expect } from 'vitest';
import { shareLanding } from './share-launch.js';

const album = { id: 'spotify:a', title: 'T', artist: 'A' };
const stub  = { id: 'pending:x', _pending: true };

describe('shareLanding', () => {
  it('an album already saved from this exact link → exists, shown and highlighted', () => {
    expect(shareLanding({ existing: album })).toEqual({ phase: 'exists', highlightId: 'spotify:a', album });
  });

  it('a stub already saved from this link → pending, highlighted but with nothing to show yet', () => {
    expect(shareLanding({ existing: stub })).toEqual({ phase: 'pending', highlightId: 'pending:x', album: null });
  });

  it('the add outcome picks the phase otherwise', () => {
    expect(shareLanding({ outcome: { kind: 'added', album } })).toEqual({ phase: 'added', highlightId: 'spotify:a', album });
    expect(shareLanding({ outcome: { kind: 'exists', album } })).toEqual({ phase: 'exists', highlightId: 'spotify:a', album });
    expect(shareLanding({ outcome: { kind: 'pending', album: stub } })).toEqual({ phase: 'pending', highlightId: 'pending:x', album: null });
  });

  it('a failed add → error, nothing to highlight', () => {
    expect(shareLanding({ outcome: { kind: 'failed', error: 400 } })).toEqual({ phase: 'error', highlightId: null, album: null });
  });
});

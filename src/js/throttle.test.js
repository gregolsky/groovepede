import { describe, it, expect, beforeEach } from 'vitest';
import { createThrottle } from './throttle.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Fake synchronous-advancing clock and sleep. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => { t += ms; },
    advance: ms => { t += ms; },
    get t() { return t; },
  };
}

const ok  = { data: 'ok' };
const err429 = { _error: 429 };
const is429 = r => r?._error === 429;

// ── pacing ────────────────────────────────────────────────────────────────────

describe('createThrottle — pacing', () => {
  let clock;
  beforeEach(() => { clock = makeClock(); });

  it('first call fires immediately (no pacing wait)', async () => {
    const th = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    let called = 0;
    await th.run(() => { called++; return ok; });
    expect(called).toBe(1);
    // No sleep was needed: clock stayed at 0
    expect(clock.t).toBe(0);
  });

  it('second call is delayed by minIntervalMs', async () => {
    const th = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await th.run(() => ok);           // t=0; call ends at t=0; lastCallEnd=0
    await th.run(() => ok);           // should wait 1000ms
    expect(clock.t).toBe(1000);
  });

  it('does not delay if minIntervalMs has elapsed between calls', async () => {
    const th = createThrottle({ minIntervalMs: 500, now: clock.now, sleep: clock.sleep });
    await th.run(() => ok);
    clock.advance(600);               // more than minIntervalMs passed before next call
    await th.run(() => ok);
    expect(clock.t).toBe(600);       // no extra sleep
  });

  it('serialises concurrent run() calls', async () => {
    const order = [];
    const th = createThrottle({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    // Fire two calls "at once" — second must wait for first to finish + pacing
    const p1 = th.run(() => { order.push(1); return ok; });
    const p2 = th.run(() => { order.push(2); return ok; });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});

// ── cooldown ──────────────────────────────────────────────────────────────────

describe('createThrottle — cooldown', () => {
  let clock;
  beforeEach(() => { clock = makeClock(); });

  it('coolingDown() is false initially', () => {
    const th = createThrottle({ minIntervalMs: 0, cooldownMs: 60_000, now: clock.now, sleep: clock.sleep });
    expect(th.coolingDown()).toBe(false);
  });

  it('coolingDown() is true after a rate-limited result', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, isRateLimited: is429,
      now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);
    expect(th.coolingDown()).toBe(true);
  });

  it('coolingDown() is false after cooldown expires', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, isRateLimited: is429,
      now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);
    clock.advance(60_001);
    expect(th.coolingDown()).toBe(false);
  });

  it('run() waits out an active cooldown before firing', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 30_000, isRateLimited: is429,
      now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);       // triggers 30 s cooldown at t=0
    const t0 = clock.t;
    await th.run(() => ok);           // should wait 30 s
    expect(clock.t - t0).toBeGreaterThanOrEqual(30_000);
  });

  it('uses retryAfterOf value as cooldown when present', async () => {
    const th = createThrottle({
      minIntervalMs: 0,
      cooldownMs: 60_000,
      isRateLimited: is429,
      retryAfterOf: r => r?._retryAfter != null ? r._retryAfter * 1000 : null,
      now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => ({ _error: 429, _retryAfter: 5 })); // Retry-After: 5 s
    // Cooldown should be 5000 ms, not 60000 ms
    clock.advance(5001);
    expect(th.coolingDown()).toBe(false);
  });
});

// ── escalation ────────────────────────────────────────────────────────────────

describe('createThrottle — cooldown escalation', () => {
  let clock;
  beforeEach(() => { clock = makeClock(); });

  it('first 429 sets cooldown to cooldownMs', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 300_000,
      isRateLimited: is429, now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);
    clock.advance(59_999);
    expect(th.coolingDown()).toBe(true);
    clock.advance(2);
    expect(th.coolingDown()).toBe(false);
  });

  it('doubles cooldown on consecutive hits', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 300_000,
      isRateLimited: is429, now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);       // 1st hit: 60 s cooldown
    await th.run(() => err429);       // 2nd hit: should set 120 s cooldown (from now())
    // After second 429, cooldown window should be 120 s from the second call end
    clock.advance(119_999);
    expect(th.coolingDown()).toBe(true);
    clock.advance(2);
    expect(th.coolingDown()).toBe(false);
  });

  it('caps escalation at maxCooldownMs', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 120_000,
      isRateLimited: is429, now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);  // 60 s
    await th.run(() => err429);  // 120 s (doubled)
    await th.run(() => err429);  // 120 s (capped)
    clock.advance(119_999);
    expect(th.coolingDown()).toBe(true);
    clock.advance(2);
    expect(th.coolingDown()).toBe(false);
  });

  it('resets escalation after a clean result', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 300_000,
      isRateLimited: is429, now: clock.now, sleep: clock.sleep,
    });
    await th.run(() => err429);   // 1st hit: 60 s window
    await th.run(() => err429);   // 2nd hit: 120 s window
    await th.run(() => ok);       // clean result: reset window back to 60 s
    await th.run(() => err429);   // next hit: should be 60 s again, not 240 s
    clock.advance(59_999);
    expect(th.coolingDown()).toBe(true);
    clock.advance(2);
    expect(th.coolingDown()).toBe(false);
  });

  it('retryAfterOf does not escalate the window', async () => {
    const th = createThrottle({
      minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 300_000,
      isRateLimited: is429,
      retryAfterOf: r => r?._retryAfter != null ? r._retryAfter * 1000 : null,
      now: clock.now, sleep: clock.sleep,
    });
    // Two consecutive hits with Retry-After — window should NOT escalate
    await th.run(() => ({ _error: 429, _retryAfter: 5 }));
    await th.run(() => ({ _error: 429, _retryAfter: 5 }));
    // If we now get a hit without Retry-After, it should still use base 60 s (not doubled)
    await th.run(() => err429);
    clock.advance(59_999);
    expect(th.coolingDown()).toBe(true);
    clock.advance(2);
    expect(th.coolingDown()).toBe(false);
  });
});

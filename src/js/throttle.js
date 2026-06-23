/**
 * createThrottle — per-service pacing + 429 cooldown decorator.
 *
 * Returns { run(fn), coolingDown() }.
 *
 *  run(fn)       — Serialises calls, respects pacing (minIntervalMs) and any
 *                  active cooldown before invoking fn(). Returns fn's result.
 *  coolingDown() — Returns true while a 429-triggered cooldown is active.
 *                  Lets callers fail-fast to a fallback instead of queueing.
 *
 * @param {object}   opts
 * @param {number}   opts.minIntervalMs   Minimum ms between consecutive calls.
 * @param {number}  [opts.cooldownMs]     Initial 429 cooldown window (default 60 s).
 * @param {number}  [opts.maxCooldownMs]  Ceiling for escalated cooldown (default 5 min).
 * @param {Function} [opts.isRateLimited] (result) → bool — true triggers cooldown.
 * @param {Function} [opts.retryAfterOf]  (result) → ms|null — server Retry-After override;
 *                                         honoured when non-null; does not escalate window.
 * @param {Function} [opts.now]           Injectable clock (default Date.now).
 * @param {Function} [opts.sleep]         Injectable sleep (default setTimeout promise).
 */
export function createThrottle({
  minIntervalMs = 0,
  cooldownMs = 60_000,
  maxCooldownMs = 300_000,
  isRateLimited = () => false,
  retryAfterOf = () => null,
  now = () => Date.now(),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let chain = Promise.resolve();   // serialisation queue — ensures one in-flight call
  let lastCallEnd = null;          // timestamp (ms) when the last call returned; null = never called
  let cooldownUntil = 0;           // timestamp before which we must not call the service
  let cooldownWindow = cooldownMs; // current escalated window; resets on clean result
  let lastWasLimited = false;      // true when previous call was rate-limited (no Retry-After)

  async function _run(fn) {
    // Compute the earliest moment we can fire: max of pacing fence and cooldown fence.
    const earliest = Math.max(
      lastCallEnd !== null ? lastCallEnd + minIntervalMs : 0,
      cooldownUntil,
    );
    const wait = Math.max(0, earliest - now());
    if (wait > 0) await sleep(wait);

    const result = await fn();
    lastCallEnd = now();

    if (isRateLimited(result)) {
      const serverMs = retryAfterOf(result);
      if (serverMs != null) {
        // Server sent Retry-After: use it exactly, don't escalate our window.
        cooldownUntil = now() + serverMs;
      } else {
        // No server hint: escalate on consecutive hits, cap at maxCooldownMs.
        if (lastWasLimited) {
          cooldownWindow = Math.min(cooldownWindow * 2, maxCooldownMs);
        }
        cooldownUntil = now() + cooldownWindow;
        lastWasLimited = true;
      }
    } else {
      // Clean result: reset escalation state.
      cooldownWindow = cooldownMs;
      lastWasLimited = false;
    }

    return result;
  }

  function run(fn) {
    // Attach to the tail of the chain; keep chain alive even when fn rejects.
    const call = chain.then(() => _run(fn));
    chain = call.then(() => {}, () => {});
    return call;
  }

  function coolingDown() {
    return now() < cooldownUntil;
  }

  return { run, coolingDown };
}

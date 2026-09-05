/**
 * Shared pino logger — JSON lines to stdout, one instance for the whole
 * resolver process.
 *
 * `LOG_LEVEL` picks the floor (default 'info'); every line above it is
 * suppressed at zero cost (pino checks the level before formatting).
 * `GIT_SHA` (already set as a Docker build arg, see Dockerfile) rides on
 * every line so a log line can be pinned to the build that produced it —
 * same field /healthz already surfaces.
 *
 * Deliberately no pino transport: transports run in a worker thread, and
 * this process has no init (`node` is PID 1 in the container, see
 * Dockerfile) and no SIGTERM handler until server.mjs's shutdown hook —
 * a transport risks losing buffered lines on a fast container stop.
 * Plain stdout JSON is simplest and correct; `docker compose logs | jq`
 * (or any log shipper) can parse it from there.
 */

import { pino } from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { svc: 'resolver', commit: process.env.GIT_SHA || 'unknown' },
});

/** No-op logger with the same shape as `log` — the default for resolver-core
 * functions when no logger is supplied, so importing the module (as tests
 * do) never emits anything and never requires pino to be configured. */
export const NOOP_LOGGER = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

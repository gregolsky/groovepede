import { describe, it, expect, vi, afterEach } from 'vitest';

// beacon.js gates everything on GP_PRIVATE_KEY (read live from config.js) and
// signs every request via sign.js's signRequestToken. Both are mocked here so
// this test never touches real WebCrypto/base64 key material, and so the
// "disabled without a key" gate — which is only re-evaluated per module
// instance — can be flipped per test via vi.resetModules() + a fresh dynamic
// import, rather than one static vi.mock() shared by the whole file.
//
// Scope: reportFailure()/send() only — the function app.js's add-failure call
// sites actually use. initBeacon()'s window 'error'/'unhandledrejection'
// wiring predates this file and needs a DOM environment this project's unit
// suite doesn't run under; it's covered by manual/e2e verification instead.
const FAKE_TOKEN = 'fake-token-not-a-real-signature';
const RESOLVER_BASE = 'https://api.groovepede.test';

async function loadBeacon({ privateKey = 'test-private-key' } = {}) {
  vi.resetModules();
  vi.doMock('./config.js', () => ({ RESOLVER_BASE, GP_PRIVATE_KEY: privateKey }));
  vi.doMock('./sign.js', () => ({ signRequestToken: vi.fn(async () => FAKE_TOKEN) }));
  return import('./beacon.js');
}

/** Flush the microtask queue so send()'s fire-and-forget promise has settled. */
const flush = () => new Promise(r => setTimeout(r, 0));

describe('beacon: reportFailure/send', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is a no-op (no sendBeacon, no fetch) when no signing key is configured', async () => {
    const { reportFailure } = await loadBeacon({ privateKey: '' });
    const sendBeacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon, userAgent: 'test-ua' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    reportFailure('add-failed', { route: 'manual-parse', msg: 'boom' });
    await flush();

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prefers navigator.sendBeacon when available and it accepts the payload', async () => {
    const { reportFailure } = await loadBeacon();
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon, userAgent: 'test-ua' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    reportFailure('add-failed', { route: 'manual-resolve', msg: '400', service: 'spotify' });
    await flush();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe(`${RESOLVER_BASE}/v1/log?token=${FAKE_TOKEN}`);
    const body = JSON.parse(await blob.text());
    expect(body).toMatchObject({ kind: 'add-failed', route: 'manual-resolve', msg: '400', service: 'spotify' });
  });

  it('falls back to fetch(keepalive) with x-gp-token when sendBeacon is unavailable', async () => {
    const { reportFailure } = await loadBeacon();
    vi.stubGlobal('navigator', { userAgent: 'test-ua' }); // no sendBeacon
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });

    reportFailure('add-failed', { route: 'pending-resolve', msg: '404' });
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${RESOLVER_BASE}/v1/log`);
    expect(opts.method).toBe('POST');
    expect(opts.keepalive).toBe(true);
    expect(opts.headers['x-gp-token']).toBe(FAKE_TOKEN);
    expect(JSON.parse(opts.body)).toMatchObject({ kind: 'add-failed', route: 'pending-resolve', msg: '404' });
  });

  it('falls back to fetch when sendBeacon rejects the payload (returns false)', async () => {
    const { reportFailure } = await loadBeacon();
    const sendBeacon = vi.fn(() => false);
    vi.stubGlobal('navigator', { sendBeacon, userAgent: 'test-ua' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });

    reportFailure('add-failed', { route: 'share-parse', msg: 'x' });
    await flush();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes the same kind+msg within a session — only one network call', async () => {
    const { reportFailure } = await loadBeacon();
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon, userAgent: 'test-ua' });

    reportFailure('add-failed', { route: 'manual-parse', msg: 'same' });
    reportFailure('add-failed', { route: 'manual-parse', msg: 'same' });
    // Different route, same kind+msg — dedup key is kind|msg, route isn't part of it.
    reportFailure('add-failed', { route: 'share-parse', msg: 'same' });
    await flush();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('drops reports past MAX_REPORTS_PER_SESSION (10 distinct failures)', async () => {
    const { reportFailure } = await loadBeacon();
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon, userAgent: 'test-ua' });

    for (let i = 0; i < 11; i++) {
      reportFailure('add-failed', { route: 'manual-parse', msg: `distinct-${i}` });
    }
    await flush();

    expect(sendBeacon).toHaveBeenCalledTimes(10);
  });

  it('truncates an overlong msg/stack before sending', async () => {
    const { reportFailure } = await loadBeacon();
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon, userAgent: 'test-ua' });

    reportFailure('add-failed', { route: 'manual-resolve', msg: 'x'.repeat(1000), stack: 'y'.repeat(1000) });
    await flush();

    const body = JSON.parse(await sendBeacon.mock.calls[0][1].text());
    expect(body.msg.length).toBe(500);
    expect(body.stack.length).toBe(500);
  });

  it('never throws out of reportFailure even when the network call rejects', async () => {
    const { reportFailure } = await loadBeacon();
    vi.stubGlobal('navigator', { userAgent: 'test-ua' }); // no sendBeacon → fetch path
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    expect(() => reportFailure('add-failed', { route: 'manual-resolve', msg: 'x' })).not.toThrow();
    await flush(); // the rejection settles inside send()'s own try/catch, not as an unhandled rejection
  });
});

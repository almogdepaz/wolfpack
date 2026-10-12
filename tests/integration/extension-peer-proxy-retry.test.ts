import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createSelectedHostFixture, SELECTED_HOST_SESSION } from '../fixtures/selected-host-extensions.ts';

let fixture: Awaited<ReturnType<typeof createSelectedHostFixture>>;
beforeAll(async () => { fixture = await createSelectedHostFixture({ timeoutMs: 2500, maxActive: 2 }); });
afterAll(async () => { if (fixture) await fixture.close(); });
function route(suffix = 'catalog'): string { return `${fixture.base}/api/extensions/peer/${encodeURIComponent(fixture.peers[0]!.identity)}/${suffix}`; }
function headers(): Record<string, string> { return { Authorization: `Bearer ${fixture.localToken}`, 'X-Wolfpack-Extension-Peer-Authorization': `Bearer ${fixture.peers[0]!.token}` }; }

test('retries the complete acquisition after upstream429 with a new PUBLIC identity check before credentials', async () => {
  const peer = fixture.peers[0]!, start = peer.trace.length; let limited = false;
  peer.handleRequest = (_req, res, url) => {
    if (url.pathname !== '/api/extensions' || limited) return false;
    limited = true; res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' }); res.end('{"error":"limited"}'); return true;
  };
  try {
    const result = await fetch(route(), { headers: headers() }); expect(result.status).toBe(200);
    expect(peer.trace.slice(start).map(({ path, authorization }) => ({ path, authorization }))).toEqual([
      { path: '/api/machine', authorization: undefined }, { path: '/api/extensions', authorization: `Bearer ${peer.token}` },
      { path: '/api/machine', authorization: undefined }, { path: '/api/extensions', authorization: `Bearer ${peer.token}` },
      { path: '/api/machine', authorization: undefined },
    ]);
  } finally { peer.handleRequest = undefined; }
});

test('discards a partial data acquisition and rejects changed identity before retransmitting any credential', async () => {
  const peer = fixture.peers[0]!, start = peer.trace.length;
  peer.handleRequest = (_req, res, url) => {
    if (!url.pathname.startsWith('/api/extensions/documents/')) return false;
    peer.mode = 'wrong-identity'; res.writeHead(429, { 'Retry-After': '0' }); res.end(); return true;
  };
  try {
    const result = await fetch(route(`documents/notes/context?session=${SELECTED_HOST_SESSION}`), { headers: headers() });
    expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: { code: 'PEER_INCOMPATIBLE' } });
    expect(peer.trace.slice(start).map(value => value.path)).toEqual(['/api/machine', '/api/extensions', `/api/extensions/documents/notes/context?session=${SELECTED_HOST_SESSION}`, '/api/machine']);
    expect(peer.trace.at(-1)?.authorization).toBeUndefined();
  } finally { peer.handleRequest = undefined; peer.mode = 'normal'; }
});

test('retry revalidates online topology and pins the original canonical origin without credential transmission', async () => {
  const peer = fixture.peers[0]!;
  for (const change of ['offline', 'origin'] as const) {
    const start = peer.trace.length;
    peer.handleRequest = (_req, res) => {
      if (change === 'offline') { peer.online = false; fixture.updateTopology(); }
      else {
        const topology = JSON.parse(process.env.WOLFPACK_TAILSCALE_STATUS_JSON!) as { Peer: { a: { DNSName: string } } };
        topology.Peer.a.DNSName = 'changed.fixture.ts.net'; process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify(topology);
      }
      res.writeHead(429, { 'Retry-After': '0' }); res.end(); return true;
    };
    try {
      const result = await fetch(route(), { headers: headers() }); expect(result.status).toBe(change === 'offline' ? 503 : 409);
      expect(await result.json()).toMatchObject({ error: { code: change === 'offline' ? 'PEER_UNAVAILABLE' : 'PEER_INCOMPATIBLE' } });
      expect(peer.trace.length - start).toBe(1); expect(peer.trace.at(-1)?.authorization).toBeUndefined();
    } finally { peer.online = true; peer.handleRequest = undefined; fixture.updateTopology(); }
  }
});

test('caps repeated429 retries and refuses Retry-After beyond the original acquisition budget', async () => {
  const peer = fixture.peers[0]!;
  for (const retryAfter of ['0', '5', new Date(Date.now() + 6000).toUTCString()]) {
    const start = peer.trace.length;
    peer.handleRequest = (_req, res) => { res.writeHead(429, { 'Retry-After': retryAfter }); res.end(); return true; };
    try {
      const began = performance.now(), result = await fetch(route(), { headers: headers() });
      expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: { code: 'PEER_BUSY' } });
      expect(performance.now() - began).toBeLessThan(1000);
      expect(peer.trace.length - start).toBe(retryAfter === '0' ? 3 : 1);
      expect(peer.trace.slice(start).every(value => value.authorization === undefined)).toBe(true);
    } finally { peer.handleRequest = undefined; }
  }
});

test('malformed present Retry-After fails busy after one public request under a sufficient retry budget', async () => {
  const peer = fixture.peers[0]!;
  for (const hint of ['', 'not-a-date', '-1', '0.5', '1, 2', 'Wed, 31 Feb 2027 00:00:00 GMT']) {
    const start = peer.trace.length; let limited = false;
    peer.handleRequest = (_req, res) => {
      if (limited) return false;
      limited = true; res.writeHead(429, { 'Retry-After': hint }); res.end(); return true;
    };
    try {
      const result = await fetch(route(), { headers: headers() });
      expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: { code: 'PEER_BUSY' } });
      expect(peer.trace.length - start).toBe(1); expect(peer.trace.at(-1)?.authorization).toBeUndefined();
    } finally { peer.handleRequest = undefined; }
  }
});

test('absent Retry-After uses the one-second fallback and valid standard hints remain retryable', async () => {
  const peer = fixture.peers[0]!;
  for (const hint of [undefined, '0', new Date(Date.now() - 1000).toUTCString()]) {
    const start = peer.trace.length; let limited = false, firstContact = 0, retryContact = 0;
    peer.handleRequest = (_req, res) => {
      if (limited) { if (!retryContact) retryContact = performance.now(); return false; }
      limited = true; firstContact = performance.now();
      res.writeHead(429, hint === undefined ? {} : { 'Retry-After': hint }); res.end(); return true;
    };
    try {
      const result = await fetch(route(), { headers: headers() }); expect(result.status).toBe(200);
      expect(peer.trace.slice(start).map(value => value.path)).toEqual(['/api/machine', '/api/machine', '/api/extensions', '/api/machine']);
      expect(peer.trace.slice(start, start + 2).every(value => value.authorization === undefined)).toBe(true);
      if (hint === undefined) expect(retryContact - firstContact).toBeGreaterThanOrEqual(1000);
    } finally { peer.handleRequest = undefined; }
  }
});

test('client disconnect cancels scheduled backoff without a later retry or leaked active slot', async () => {
  const peer = fixture.peers[0]!, start = peer.trace.length, controller = new AbortController();
  let limited!: () => void; const contacted = new Promise<void>(resolve => { limited = resolve; });
  peer.handleRequest = (_req, res) => { res.writeHead(429, { 'Retry-After': '0' }); res.end(); limited(); return true; };
  try {
    const pending = fetch(route(), { headers: headers(), signal: controller.signal }).catch(() => null);
    await contacted; controller.abort(); await pending;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(peer.trace.length - start).toBe(1);
    peer.handleRequest = undefined; expect((await fetch(route(), { headers: headers() })).status).toBe(200);
  } finally { controller.abort(); peer.handleRequest = undefined; }
});

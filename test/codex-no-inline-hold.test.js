import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { holdsConnection } from '../src/provider.js';

// The proxy absorbs a short rate-limit 429 by holding the request on the
// connection, waiting out `retry-after` and trying again, so the client never
// sees it. That trade is only invisible to a client that waits longer than we
// do, and a Codex one does not: it gives the response head a fixed 60s, then
// retries the whole request about four times before failing.
//
// Observed live on 2026-09-15, once a translating sidecar's back leg began
// re-entering this proxy to draw a pooled ChatGPT subscription: eleven requests
// died at 250.5s (+/- 13ms — four of the client's own 60s attempts, not the
// network), and two agents sat in a silent retry loop for 14 and 29 minutes
// each. Nothing surfaced, because from the client's side a held connection and
// a hung one are the same thing.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const RETRY_AFTER_WELL_UNDER_THE_ABSORB_CAP = '5';

/** One request through the proxy against an upstream that always 429s. */
async function run({ provider, path }) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': RETRY_AFTER_WELL_UNDER_THE_ABSORB_CAP, 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([{
    name: 'a', type: 'oauth', provider, accessToken: 't', refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, upstream: `http://127.0.0.1:${upstreamPort}`,
  }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [] }),
    });
    await res.text();
    return {
      status: res.status,
      elapsed: Date.now() - started,
      retryAfter: res.headers.get('retry-after'),
      upstreamHits,
      paused: am.accounts[0].pausedUntil != null && am.accounts[0].pausedUntil > Date.now(),
    };
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a Codex 429 is answered now, not absorbed on the connection', async () => {
  const r = await run({ provider: 'codex', path: '/backend-api/codex/responses' });
  assert.equal(r.status, 429);
  assert.equal(r.upstreamHits, 1, 'the wait-and-retry must not run for a caller that will not wait');
  // The absorb would have slept 5s before the second attempt. Generous bound —
  // the assertion is "did not sleep", not a latency budget.
  assert.ok(r.elapsed < 2000, `answered in ${r.elapsed}ms; expected no inline wait`);
});

test('and it carries the retry-after, so the client can back off itself', async () => {
  const r = await run({ provider: 'codex', path: '/backend-api/codex/responses' });
  assert.equal(r.retryAfter, RETRY_AFTER_WELL_UNDER_THE_ABSORB_CAP);
});

test('the account is still paused — only the WAIT is withheld', async () => {
  // The half that protects the fleet is unchanged: concurrent requests keep off
  // this account. Dropping that alongside the wait would trade a stall for a
  // stampede.
  const r = await run({ provider: 'codex', path: '/backend-api/codex/responses' });
  assert.ok(r.paused, 'a rate-limited account must still be paused for other requests');
});

test('holdsConnection: only the provider whose client actually waits', () => {
  assert.equal(holdsConnection('anthropic'), true);
  assert.equal(holdsConnection('codex'), false);
  // An unknown or absent provider is Anthropic, exactly as providerOf treats it:
  // configs predate providers, and a request with no opinion is a Claude one.
  assert.equal(holdsConnection(undefined), true);
  assert.equal(holdsConnection(null), true);
  assert.equal(holdsConnection('nonsense'), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Two TeamClaude accounts on one antigravity proxy, each pinned to one Google
// account (accounts[].antigravityAccount). For a pinned request the proxy never
// switches Google account itself: it answers 429 (rate-limited or out of
// quota, with retry-after), 401 (needs a re-login), 403 (disabled) or 400
// (unknown email). TeamClaude does the failover between Google accounts.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ANSWERS = {
  429: { headers: { 'retry-after': '120' }, type: 'rate_limit_error' },
  401: { headers: {}, type: 'authentication_error' },
  403: { headers: {}, type: 'permission_error' },
  400: { headers: {}, type: 'invalid_request_error' },
  // A 429 with no retry-after and no rate-limit headers is about the request,
  // not the account (#288): the proxy's pinned 429 always has retry-after.
  '429-bare': { status: 429, headers: {}, type: 'rate_limit_error' },
};

/** Fleet of two pinned accounts plus a Codex login (which makes a loopback
 * account read as a Codex conduit). a@gmail.com answers `status`; b@gmail.com
 * serves. */
async function withPinnedPair(status, fn) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    const email = req.headers['x-antigravity-account'];
    hits.push(email);
    if (email === 'a@gmail.com') {
      const answer = ANSWERS[status];
      res.writeHead(answer.status ?? status, { 'content-type': 'application/json', ...answer.headers });
      res.end(JSON.stringify({ type: 'error', error: { type: answer.type, message: `pinned account ${status}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);
  const pinned = (email) => ({
    name: `gemini:${email}`, type: 'oauth', accessToken: 'proxy-key', expiresAt: null,
    upstream: `http://127.0.0.1:${upstreamPort}`, quotaProvider: 'antigravity', antigravityAccount: email,
  });
  let refreshes = 0;
  const am = new AccountManager([
    pinned('a@gmail.com'),
    pinned('b@gmail.com'),
    { name: 'gpt', type: 'oauth', provider: 'codex', accountId: 'acct-1', accessToken: 'c', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, {
    refreshFn: async () => { refreshes++; throw new Error('no refresh expected'); },
    routes: [{ name: 'gemini', match: ['gemini-*'], accounts: ['gemini:a@gmail.com', 'gemini:b@gmail.com'] }],
  });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const send = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: 'gemini-3-pro', messages: [] }),
    });
    await res.text();
    return res.status;
  };
  try {
    await fn({ send, hits, am, refreshes: () => refreshes });
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a 429 from a pinned Google account holds that account until retry-after and fails over to the other', async () => {
  await withPinnedPair(429, async ({ send, hits, am }) => {
    const before = Date.now();
    assert.equal(await send(), 200);
    assert.deepEqual(hits, ['a@gmail.com', 'b@gmail.com']);
    const a = am.accounts[0];
    assert.equal(a.status, 'throttled');
    assert.ok(a.rateLimitedUntil >= before + 119_000 && a.rateLimitedUntil <= Date.now() + 120_000, 'held for the retry-after');

    // The next request does not ask the held account again.
    assert.equal(await send(), 200);
    assert.deepEqual(hits.slice(2), ['b@gmail.com']);
  });
});

test('a 429 with no retry-after from a pinned Google account does not hold the account', async () => {
  await withPinnedPair('429-bare', async ({ send, hits, am }) => {
    const status = await send();
    const a = am.accounts[0];
    assert.notEqual(a.status, 'throttled', `not held (got ${status}, hits ${hits.join(',')})`);
    assert.ok(!(a.rateLimitedUntil > Date.now() + 5_000), 'no account-level hold');
  });
});

for (const status of [401, 403]) {
  test(`a ${status} from a pinned Google account holds it for a cooldown and fails over, with no OAuth refresh`, async () => {
    await withPinnedPair(status, async ({ send, hits, am, refreshes }) => {
      assert.equal(await send(), 200);
      assert.deepEqual(hits, ['a@gmail.com', 'b@gmail.com']);
      const a = am.accounts[0];
      assert.notEqual(a.status, 'error', 'a proxy-side problem does not ask for a TeamClaude login');
      assert.ok(a.credentialRejectedUntil > Date.now(), 'held out of rotation for a cooldown');
      assert.equal(refreshes(), 0);

      assert.equal(await send(), 200);
      assert.deepEqual(hits.slice(2), ['b@gmail.com'], 'the held account is not asked again');
    });
  });
}

test('a 400 from a pinned Google account is the client\'s answer, and the account stays in rotation', async () => {
  await withPinnedPair(400, async ({ send, hits, am, refreshes }) => {
    assert.equal(await send(), 400);
    assert.deepEqual(hits, ['a@gmail.com']);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].credentialRejectedUntil, null);
    assert.equal(refreshes(), 0);
  });
});

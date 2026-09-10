import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager, normalizeHeadersTimeoutMs } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// The response-headers deadline in upstream-fetch.js is one number for the whole
// fleet (env var or 120s). A slow backend behind one account — a Codex sidecar
// answering a non-streaming request takes minutes to first byte — needs more,
// without loosening the stale-socket guard for every Anthropic account.
// `accounts[].headersTimeoutMs` is that per-account override.

const ENV = 'TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS';

test('only a positive integer is accepted; everything else means "fleet default"', () => {
  assert.equal(normalizeHeadersTimeoutMs(600_000), 600_000);
  assert.equal(normalizeHeadersTimeoutMs(1), 1);
  for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, '600000', '', true, {}, []]) {
    assert.equal(normalizeHeadersTimeoutMs(bad), null, `expected ${String(bad)} to be rejected`);
  }
});

test('the account carries headersTimeoutMs through from config, normalized', () => {
  const am = new AccountManager([
    { name: 'codex', type: 'apikey', apiKey: 'k', headersTimeoutMs: 600_000 },
    { name: 'plain', type: 'apikey', apiKey: 'k' },
    { name: 'zero', type: 'apikey', apiKey: 'k', headersTimeoutMs: 0 },
    { name: 'text', type: 'apikey', apiKey: 'k', headersTimeoutMs: '600000' },
  ], 0.98);
  assert.equal(am.accounts[0].headersTimeoutMs, 600_000);
  assert.equal(am.accounts[1].headersTimeoutMs, null);
  assert.equal(am.accounts[2].headersTimeoutMs, null);
  assert.equal(am.accounts[3].headersTimeoutMs, null);
});

// Live reload must land a disk edit on the running account (server.js reads it
// per request) and mirror it onto the memConfig entry, so the next TUI save
// neither drops a fresh value nor resurrects a removed one.
test('reload applies, changes and removes headersTimeoutMs, and mirrors memConfig', async () => {
  const base = { name: 'codex', type: 'apikey', apiKey: 'k' };
  const mem = { accounts: [{ ...base }] };
  const am = new AccountManager(mem.accounts, 0.98);
  assert.equal(am.accounts[0].headersTimeoutMs, null);

  await syncAccountsFromDisk({ accounts: [{ ...base, headersTimeoutMs: 600_000 }] }, mem, am);
  assert.equal(am.accounts[0].headersTimeoutMs, 600_000);
  assert.equal(mem.accounts[0].headersTimeoutMs, 600_000);

  await syncAccountsFromDisk({ accounts: [{ ...base, headersTimeoutMs: 30_000 }] }, mem, am);
  assert.equal(am.accounts[0].headersTimeoutMs, 30_000);
  assert.equal(mem.accounts[0].headersTimeoutMs, 30_000);

  await syncAccountsFromDisk({ accounts: [{ ...base }] }, mem, am);
  assert.equal(am.accounts[0].headersTimeoutMs, null);
  assert.equal('headersTimeoutMs' in mem.accounts[0], false);
});

// --- end to end: the value reaches upstreamFetch in forwardRequest ---

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// An ambient HTTPS_PROXY would insert itself between proxy and stub upstream
// and answer with its own timing. Same seam as unreachable-upstream.test.js.
function withoutAmbientProxy() {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  return resetUpstreamProxy;
}

function withEnv(value) {
  const prev = process.env[ENV];
  if (value == null) delete process.env[ENV]; else process.env[ENV] = String(value);
  return () => { if (prev == null) delete process.env[ENV]; else process.env[ENV] = prev; };
}

// Drive one request; collect the outcome and the upstream errors the proxy logged.
// A headers timeout is transient → the proxy destroys the client socket, so the
// client sees a closed connection, and the log carries the deadline that fired.
async function oneRequest(proxyPort) {
  const lines = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a) => lines.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' '));
  console.log = () => {};
  const start = Date.now();
  let outcome;
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    outcome = `${res.status} ${await res.text()}`;
  } catch {
    outcome = 'connection closed';
  } finally {
    console.error = realErr;
    console.log = realLog;
  }
  return { outcome, elapsed: Date.now() - start, errors: lines.filter(l => l.includes('Upstream error')) };
}

// Stub upstream: hangs before headers, or answers after `delayMs`.
function stubUpstream({ delayMs = null } = {}) {
  return http.createServer((req, res) => {
    if (delayMs == null) return; // never respond: a half-dead socket
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, delayMs);
  });
}

async function withProxy({ account, upstreamOpts, env }, fn) {
  const upstream = stubUpstream(upstreamOpts);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k', ...account }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const restoreProxy = withoutAmbientProxy();
  const restoreEnv = withEnv(env);
  try {
    return await fn(proxyPort);
  } finally {
    restoreEnv();
    restoreProxy();
    proxy.close();
    upstream.closeAllConnections?.();
    upstream.close();
  }
}

test('an account override arms its own headers deadline', async () => {
  await withProxy({ account: { headersTimeoutMs: 200 }, env: null }, async (port) => {
    const got = await oneRequest(port);
    assert.equal(got.outcome, 'connection closed');
    assert.ok(got.elapsed < 5000, `expected fast-fail, took ${got.elapsed}ms`);
    assert.ok(got.errors.some(l => l.includes('timed out after 200ms')), got.errors.join(' | ') || '(no upstream error logged)');
  });
});

test('without an override the fleet default (env var) still applies', async () => {
  await withProxy({ account: {}, env: 150 }, async (port) => {
    const got = await oneRequest(port);
    assert.equal(got.outcome, 'connection closed');
    assert.ok(got.elapsed < 5000, `expected fast-fail, took ${got.elapsed}ms`);
    assert.ok(got.errors.some(l => l.includes('timed out after 150ms')), got.errors.join(' | ') || '(no upstream error logged)');
  });
});

test('an account override outlasts a shorter fleet default', async () => {
  await withProxy({ account: { headersTimeoutMs: 5000 }, env: 150, upstreamOpts: { delayMs: 400 } }, async (port) => {
    const got = await oneRequest(port);
    assert.equal(got.outcome, '200 {"ok":true}');
    assert.deepEqual(got.errors, []);
  });
});

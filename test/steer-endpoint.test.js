import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { renderStatus } from '../src/status-renderer.js';
import { steersText } from '../src/dashboard.js';
import { STEER_MAX_MS } from '../src/steer.js';

// POST /teamclaude/steer, through a real proxy in front of a stand-in
// upstream, so what is checked is the account each request reaches.

const H = 3600_000;
const listen = (/** @type {any} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const apikey = (/** @type {string} */ name, extra = {}) => ({ name, type: 'apikey', apiKey: `key-${name}`, ...extra });
const S1 = '3f2a1b9c-0000-4000-8000-000000000001';
const S2 = '9d0e4c11-0000-4000-8000-000000000002';

/** @param {() => Promise<void>} fn */
async function quietly(fn) {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try { await fn(); } finally { console.log = original.log; console.error = original.error; }
}

/** @param {any[]} accounts @param {Record<string, any>} [opts] */
async function proxyWith(accounts, { proxyConfig = {}, distributeSessions = true } = {}) {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(/** @type {string} */ (req.headers['x-api-key']));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98, { distributeSessions });
  /** @type {any[]} */
  const ended = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k', ...proxyConfig }, upstream: `http://127.0.0.1:${upstreamPort}` }, {
    onRequestEnd: (/** @type {number} */ _id, /** @type {any} */ info) => ended.push(info),
  });
  const port = await listen(proxy);
  return {
    am, port, seen, ended,
    close: () => { proxy.closeAllConnections?.(); proxy.close(); upstream.closeAllConnections?.(); upstream.close(); },
  };
}

/** @param {number} port @param {string|null} sessionId */
async function message(port, sessionId) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}) },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  return res.status;
}

/** @param {number} port @param {any} body */
async function steer(port, body, key = 'k') {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('a steer sends new conversations to its target and leaves a running one where it is', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b'), apikey('t')]);
  await quietly(async () => {
    try {
      assert.equal(await message(ctx.port, S1), 200);
      const running = ctx.seen.at(-1);
      assert.notEqual(running, 'key-t');

      const set = await steer(ctx.port, { account: 't', for: '6h' });
      assert.equal(set.status, 200);
      assert.equal(set.body.steer.target, 't');
      assert.equal(set.body.steer.provider, 'anthropic');
      assert.equal(set.body.steer.redeem, false);
      assert.ok(Math.abs(set.body.steer.until - (Date.now() + 6 * H)) < 60_000, 'the end it settled on is echoed');
      assert.equal(set.body.eligible, true);
      assert.equal(set.body.clamped, false);

      ctx.seen.length = 0;
      ctx.ended.length = 0;
      await message(ctx.port, S1);
      await message(ctx.port, S2);
      await message(ctx.port, S2);
      await message(ctx.port, null);
      assert.deepEqual(ctx.seen, [running, 'key-t', 'key-t', 'key-t']);
      // The activity view's [steer]: the placement and the untagged request,
      // not the pinned turns.
      assert.deepEqual(ctx.ended.map(e => e.steered), [false, true, false, true]);

      const cleared = await steer(ctx.port, { account: null });
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.body.cleared.map((/** @type {any} */ s) => s.target), ['t']);
      assert.deepEqual(ctx.am.steerList(), []);
      assert.deepEqual((await steer(ctx.port, { account: null })).body.cleared, []);
    } finally {
      ctx.close();
    }
  });
});

test('an account pin and a session pin both resolve before the steer', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b'), apikey('t')]);
  await quietly(async () => {
    try {
      await steer(ctx.port, { account: 't' });
      ctx.am.sessionPins.set(S1, 'b');
      await message(ctx.port, S1);
      const res = await fetch(`http://127.0.0.1:${ctx.port}/tc-acct/a/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': S2 },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [] }),
      });
      await res.text();
      await message(ctx.port, S2);
      assert.deepEqual(ctx.seen, ['key-b', 'key-a', 'key-t'], 'the session pin, the account pin, then the steer');
    } finally {
      ctx.close();
    }
  });
});

test('the endpoint validates its body, answers 404 for an unknown account, and clamps the end to seven days', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('t')]);
  await quietly(async () => {
    try {
      for (const body of [{}, { account: '  ' }, { account: 3 }, { account: 't', redeem: 'yes' }, { account: 't', for: 'soon' },
        { account: 't', for: '1h', until: new Date(Date.now() + H).toISOString() }, { account: 't', until: new Date(Date.now() - H).toISOString() },
        { account: 't', provider: 'openai' }, '{not json', '[]']) {
        assert.equal((await steer(ctx.port, body)).status, 400, JSON.stringify(body));
      }
      const unknown = await steer(ctx.port, { account: 'nobody' });
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.body.accounts, ['a', 't']);
      // A --redeem on an API key has nothing to redeem: refused, not set.
      const redeem = await steer(ctx.port, { account: 't', redeem: true });
      assert.equal(redeem.status, 400);
      assert.match(redeem.body.error, /holds no banked reset/);
      assert.deepEqual(ctx.am.steerList(), []);

      const long = await steer(ctx.port, { account: 't', for: 30 * 24 * 3600 });
      assert.equal(long.status, 200);
      assert.equal(long.body.clamped, true);
      assert.ok(long.body.steer.until <= Date.now() + STEER_MAX_MS);
      // A second steer for the same provider replaces the first.
      const again = await steer(ctx.port, { account: 'a' });
      assert.equal(again.body.replaced.target, 't');
      assert.deepEqual(ctx.am.steerList().map(s => s.target), ['a']);
    } finally {
      ctx.close();
    }
  });
});

test('a provider narrows the account, so one email\'s Claude and Codex logins are told apart', async () => {
  const ctx = await proxyWith([
    { name: 'me@example.com', type: 'oauth', accessToken: 't1', refreshToken: 'r', expiresAt: Date.now() + H, accountUuid: 'u1' },
    { name: 'me@example.com', type: 'oauth', provider: 'codex', accessToken: 't2', refreshToken: 'r', expiresAt: Date.now() + H, accountId: 'acct-1' },
  ]);
  await quietly(async () => {
    try {
      const set = await steer(ctx.port, { account: 'me@example.com', provider: 'codex' });
      assert.equal(set.status, 200);
      assert.equal(set.body.steer.provider, 'codex');
      assert.equal(set.body.steer.index, 1);
      const cleared = await steer(ctx.port, { account: null, provider: 'anthropic' });
      assert.deepEqual(cleared.body.cleared, [], 'clearing one provider leaves the other');
      assert.equal(ctx.am.steerList().length, 1);
    } finally {
      ctx.close();
    }
  });
});

test('a target that cannot take a placement right now is set, and the answer says why', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('t', { disabled: true })]);
  await quietly(async () => {
    try {
      const set = await steer(ctx.port, { account: 't' });
      assert.equal(set.status, 200);
      assert.equal(set.body.eligible, false);
      assert.equal(set.body.reason, 'disabled');
      await message(ctx.port, S1);
      assert.deepEqual(ctx.seen, ['key-a'], 'the placement falls through');
      assert.equal(ctx.am.steerList().length, 1, 'and the steer stays armed');
    } finally {
      ctx.close();
    }
  });
});

test('a client key is refused; the shared proxy key is not', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('t')], { proxyConfig: { clientKeys: [{ name: 'ci', key: 'ci-key' }] } });
  await quietly(async () => {
    try {
      const refused = await steer(ctx.port, { account: 't' }, 'ci-key');
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.body, { ok: false, error: 'a client key cannot steer the fleet' });
      assert.deepEqual(ctx.am.steerList(), []);
      assert.equal((await steer(ctx.port, { account: null }, 'ci-key')).status, 403, 'clearing is steering too');
      assert.equal((await steer(ctx.port, { account: 't' })).status, 200);
    } finally {
      ctx.close();
    }
  });
});

test('status carries the steers, and the status line and dashboard summary name them', async () => {
  const am = new AccountManager([apikey('a'), apikey('t')], 0.98);
  await quietly(async () => { am.setSteer(1, { until: Date.now() + 5 * H }); });
  const [row] = am.getStatus().steers;
  assert.deepEqual({ ...row, startedAt: 0, until: 0 }, { provider: 'anthropic', target: 't', index: 1, startedAt: 0, until: 0, redeem: false, redeeming: false });
  const text = renderStatus(am.getStatus(), { color: false });
  assert.match(text, /Steer\s+→ t · 5h left/);
  assert.doesNotMatch(renderStatus(new AccountManager([apikey('a')], 0.98).getStatus(), { color: false }), /Steer/);
  assert.equal(steersText(am.getStatus().steers, row.until - 5 * H), 'steer → t (5h left)');
  assert.equal(steersText([], Date.now()), '');
});

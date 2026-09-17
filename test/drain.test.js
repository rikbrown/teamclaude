import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, markDraining } from '../src/server.js';
import { drainServer, DRAIN_DEADLINE_MS, RESTART_EXIT_CODE } from '../src/restart.js';

// Restarting the proxy used to break every session going through it, for two
// reasons that look like one: shutdown() destroys in-flight streams on purpose,
// and a restart silently kills the idle keep-alive sockets clients still hold
// pooled. A drain has to answer both — wait for the streams, and tell the pools
// to let go — or "apply the new build" stays a thing you only do at night.

/** Enough of an http.Server for the drain: it records which closes it was asked
 *  for, which is the whole distinction being tested. */
function fakeServer() {
  return {
    closes: 0, idleCloses: 0, destroys: 0,
    close() { this.closes += 1; },
    closeIdleConnections() { this.idleCloses += 1; },
    closeAllConnections() { this.destroys += 1; },
  };
}

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

/** One request, resolved with the response headers. Not fetch: undici does not
 *  surface hop-by-hop headers, and a hop-by-hop header is the whole point. The
 *  agent has to be a keep-alive one, too — a client that asks for the socket to
 *  be closed is told it will be, whatever the server thinks about draining. */
function headers(port, path, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.headers));
    });
    req.once('error', reject);
  });
}

// ── waiting ──────────────────────────────────────────────────────────────────

test('a drain stops the listener and waits for what is running, without destroying it', async () => {
  const server = fakeServer();
  let open = 3;
  const result = await drainServer({
    server,
    inFlight: () => open,
    pollMs: 1,
    now: () => 0, // a clock that never moves: only the count can end this
    sleep: async () => { open -= 1; },
  });

  assert.equal(result.drained, true);
  assert.equal(result.inFlight, 0);
  assert.equal(server.closes, 1, 'the listener stops taking new connections');
  assert.equal(server.destroys, 0, 'closeAllConnections is exactly what cuts a live stream');
});

test('the sockets nobody used during the drain are closed at the end, not the start', async () => {
  const server = fakeServer();
  const seen = [];
  let open = 2;
  await drainServer({
    server,
    inFlight: () => open,
    pollMs: 1,
    now: () => 0,
    // Yanking an idle socket up front is the failure this feature exists to
    // avoid: a client about to reuse it writes into a corpse. It may only
    // happen once there is nothing left to wait for.
    sleep: async () => { seen.push(server.idleCloses); open -= 1; },
  });
  assert.deepEqual(seen, [0, 0]);
  assert.equal(server.idleCloses, 1);
});

test('a stuck request cannot hold a restart past the deadline', async () => {
  const server = fakeServer();
  let clock = 0;
  const result = await drainServer({
    server,
    inFlight: () => 1, // an upstream that stopped sending without closing
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(result.drained, false);
  assert.equal(result.inFlight, 1);
  assert.ok(result.waitedMs >= DRAIN_DEADLINE_MS, `waited ${result.waitedMs}ms`);
  assert.equal(server.idleCloses, 1, 'the process still has to be able to exit');
});

test('the restart code is distinct from a clean exit and from a crash', () => {
  assert.equal(RESTART_EXIT_CODE, 75);
  assert.notEqual(RESTART_EXIT_CODE, 0);
  assert.notEqual(RESTART_EXIT_CODE, 1);
});

test('a response already streaming is delivered in full after the drain begins', async () => {
  let release = () => {};
  const held = new Promise(resolve => { release = resolve; });
  let inFlight = 0;

  const server = http.createServer(async (req, res) => {
    inFlight += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    await held;
    res.end('data: last\n\n');
    inFlight -= 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {any} */ (server.address());

  const res = await fetch(`http://127.0.0.1:${port}/`);
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
  await reader.read(); // the first chunk is out: this response is mid-stream

  // drainServer closes the listener and takes its first reading synchronously,
  // before it can await anything — so by here the server is closed and the
  // stream below is being finished by a server that is no longer listening.
  const draining = drainServer({ server, inFlight: () => inFlight, pollMs: 5 });
  release();

  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail += Buffer.from(value).toString('utf8');
  }
  assert.match(tail, /last/, 'the stream was cut by the drain');
  assert.equal((await draining).drained, true);
});

// ── letting the pools go ─────────────────────────────────────────────────────

test('while draining, an answer tells the client to retire the socket it came on', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  let draining = false;
  const server = createProxyServer(am, { proxy: {} }, { isDraining: () => draining });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {any} */ (server.address());

  const agent = new http.Agent({ keepAlive: true });
  try {
    const before = await headers(port, '/teamclaude/dashboard', agent);
    assert.notEqual(before.connection, 'close', 'a server that is serving keeps its connections');

    draining = true;
    const after = await headers(port, '/teamclaude/dashboard', agent);
    assert.equal(after.connection, 'close');
  } finally {
    agent.destroy();
    server.close();
    server.closeAllConnections?.();
  }
});

test('the header is only ever set on HTTP/1, where it is legal', () => {
  const hooks = { isDraining: () => true };
  const set = [];
  const res = { setHeader: (k, v) => set.push([k, v]) };

  markDraining({ httpVersionMajor: 1 }, res, hooks);
  assert.deepEqual(set, [['Connection', 'close']]);

  // Node refuses a connection-specific header on an h2 response, so setting it
  // would turn every answer in a MITM tunnel into a 500 for as long as the
  // drain lasted. The tunnel goes away with its CONNECT socket regardless.
  markDraining({ httpVersionMajor: 2 }, res, hooks);
  assert.equal(set.length, 1);

  markDraining({ httpVersionMajor: 1 }, res, {});
  assert.equal(set.length, 1, 'a server that is not draining says nothing');
});

test('a response that has already answered cannot make the drain throw', () => {
  const res = { setHeader() { throw new Error('Cannot set headers after they are sent'); } };
  assert.doesNotThrow(() => markDraining({ httpVersionMajor: 1 }, res, { isDraining: () => true }));
});

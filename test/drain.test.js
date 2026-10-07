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

// ── what the drain counts ────────────────────────────────────────────────────
//
// The drain is only as good as its count. A request with no session id takes
// no session hold, and storm control hands the account's slot back when the
// response headers arrive. So once those headers were in, an answer to a client
// that sends no session id counted as nothing in flight for the rest of its
// body, and a drain could restart the proxy partway through it. An SDK script
// or a curl sends no session id, and neither does a sidecar back leg given none.

/** Answers the proxy sends back, each one past its headers and with its body
 *  still open when the drain takes its first reading. */
const ANSWERS = [
  {
    name: 'an Anthropic stream',
    path: '/v1/messages',
    account: () => ({ name: 'k', type: 'apikey', apiKey: 'k1' }),
    body: { model: 'claude-opus-5', messages: [], stream: true },
    type: 'text/event-stream',
    head: 'event: ping\ndata: {"type":"ping"}\n\n',
    tail: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  },
  {
    // Read whole before it is relayed, so the client sees nothing until the
    // end. The proxy still has it open.
    name: 'an Anthropic answer read whole',
    path: '/v1/messages',
    account: () => ({ name: 'k', type: 'apikey', apiKey: 'k1' }),
    body: { model: 'claude-opus-5', messages: [] },
    type: 'application/json',
    head: '{"type":"message",',
    tail: '"content":[]}',
  },
  {
    name: 'a Codex stream',
    path: '/backend-api/codex/responses',
    account: (/** @type {string} */ upstream) => ({
      name: 'c', type: 'oauth', provider: 'codex', accessToken: 't', refreshToken: 'r',
      expiresAt: Date.now() + 3600_000, upstream,
    }),
    body: { model: 'gpt-6-astra', input: [], stream: true },
    type: 'text/event-stream',
    head: 'data: {"type":"response.created"}\n\n',
    tail: 'data: {"type":"response.in_progress"}\n\n',
  },
];

/**
 * A proxy over one account, and an upstream that answers with `answer.head`,
 * then holds the rest of the body until `finish()` sends `answer.tail` or
 * `cut()` drops the connection partway through it.
 *
 * @param {typeof ANSWERS[number]} answer
 * @param {Record<string, any>} [config]
 */
async function openAnswer(answer, config = {}) {
  /** @type {(how: 'end'|'cut') => void} */
  let settle = () => {};
  /** @type {Promise<'end'|'cut'>} */
  const settled = new Promise(resolve => { settle = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', async () => {
      res.writeHead(200, { 'content-type': answer.type });
      res.write(answer.head);
      if (await settled === 'cut') res.socket?.destroy();
      else res.end(answer.tail);
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}`;

  const am = new AccountManager([answer.account(upstreamUrl)], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: upstreamUrl, ...config }, {});
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const { port } = /** @type {any} */ (proxy.address());

  return {
    am,
    proxy,
    /** @param {Record<string, string>} [headers] @param {AbortSignal} [signal] */
    ask: (headers = {}, signal = undefined) => fetch(`http://127.0.0.1:${port}${answer.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(answer.body),
      signal,
    }),
    finish: () => settle('end'),
    cut: () => settle('cut'),
    close() {
      settle('end');
      proxy.closeAllConnections();
      proxy.close();
      upstream.closeAllConnections();
      upstream.close();
    },
  };
}

/** Yield to I/O until `condition` holds. No deadline of its own: the runner's
 *  timeout is the bound (see test/README.md). */
async function until(/** @type {() => boolean} */ condition) {
  while (!condition()) await new Promise(resolve => setImmediate(resolve));
}

for (const answer of ANSWERS) {
  test(`${answer.name} with no session id holds the drain until its body has ended`, async () => {
    const f = await openAnswer(answer);
    try {
      const answered = f.ask().then(res => res.text());
      answered.catch(() => {}); // awaited below; a failed assertion must not leave it unhandled
      // The window this is about: the upstream's headers are in, so admit()'s
      // slot has been handed back, and the body is still open. Waited for as a
      // state, not a delay: the upstream holds the body until finish(), so the
      // state lasts until it is read.
      const account = f.am.accounts[0];
      await until(() => account.activityOpen === 1 && account.inFlight === 0);

      let waited = false;
      const result = await drainServer({
        server: f.proxy,
        inFlight: () => f.am.inFlightRequests(),
        now: () => 0, // a clock that never moves: only the count can end this
        // Reached only if the first reading found the answer open. It lets the
        // upstream finish, then yields while the proxy relays the rest.
        sleep: async () => {
          waited = true;
          f.finish();
          await new Promise(resolve => setImmediate(resolve));
        },
      });

      assert.equal(waited, true, 'the drain read nothing in flight while a body was still open');
      assert.equal(result.drained, true);
      assert.equal(await answered, answer.head + answer.tail, 'the client got the whole answer');
    } finally {
      f.close();
    }
  });
}

test('a request held before it is sent counts, when it carries a session', async () => {
  // Nothing can serve, so with holdSeconds set the proxy holds the connection
  // and waits for an account. Nothing has been dispatched, so no account is
  // busy: only the session's hold knows this request is running.
  const f = await openAnswer(ANSWERS[0], { holdSeconds: 120 });
  /** @type {() => void} */
  let selected = () => {};
  const holding = new Promise(resolve => { selected = () => resolve(undefined); });
  f.am.getActiveAccount = () => { selected(); return null; };
  const client = new AbortController();
  try {
    const answered = f.ask({ 'x-claude-code-session-id': 'drain-held-session' }, client.signal);
    answered.catch(() => {}); // aborted below, on purpose
    await holding;
    assert.equal(f.am.accounts[0].activityOpen, 0, 'nothing was dispatched');
    assert.equal(f.am.inFlightRequests(), 1);

    client.abort();
    await until(() => f.am.inFlightRequests() === 0);
  } finally {
    f.close();
  }
});

// A count that does not come back to zero is as bad as one that misses a
// request: every later drain would wait out the whole deadline. The two exits
// that end a stream early must both release it.

test('a client that leaves partway through a stream takes its count with it', async () => {
  const f = await openAnswer(ANSWERS[0]);
  const client = new AbortController();
  try {
    const res = await f.ask({}, client.signal);
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
    await reader.read(); // the first event is through: the response is mid-stream
    assert.equal(f.am.inFlightRequests(), 1);

    // The upstream never finishes. Only the proxy noticing the client left can
    // end this request.
    client.abort();
    await until(() => f.am.inFlightRequests() === 0);
  } finally {
    f.close();
  }
});

test('an upstream that dies partway through a stream takes its count with it', async () => {
  const f = await openAnswer(ANSWERS[0]);
  try {
    const res = await f.ask();
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
    await reader.read();
    assert.equal(f.am.inFlightRequests(), 1);

    f.cut();
    await until(() => f.am.inFlightRequests() === 0);
  } finally {
    f.close();
  }
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

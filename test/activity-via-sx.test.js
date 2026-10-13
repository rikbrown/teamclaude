import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { generateCertChain } from '../src/x509.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI } from '../src/tui.js';

// The activity view says when a request left through sx.org: a dim ` via sx`
// after the account, on the live row and on the finished line. It follows the
// real egress of the attempt, so an account with its own routing proxy never
// shows it, even with sx set to route everything.

const T = { timeout: 30000 };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
function closeHard(s) { s.closeAllConnections?.(); try { s.close(); } catch { /* closing */ } }

function makeTUI() {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', quota: {}, status: 'active' }],
    currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; },
    sessionStats() { return { active: 0, known: 0 }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
}

// One full frame, colour and cursor codes removed, at a fixed size.
function renderPlain(tui) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 160, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let frame = '';
  try {
    tui._paint = buf => { frame = buf; };
    tui.running = true;
    tui._render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    tui.running = false;
  }
  return frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const tuiHooks = tui => ({
  onRequestStart: (id, info) => tui.onRequestStart(id, info),
  onRequestModel: (id, info) => tui.onRequestModel(id, info),
  onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
  onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
});

// sx in 'always' mode. `connects` counts the CONNECTs its proxy saw, which is
// the proof of where an attempt really went.
function makeSx(proxyPort, caCertPem) {
  return {
    isProvisioned: () => true,
    getProxy: () => ({ host: '127.0.0.1', port: proxyPort, username: null, password: null }),
    tlsOptions: { ca: caCertPem },
    getMode: () => 'always',
    useByDefault: () => true,
    useOn429: () => true,
    useForConnect: () => true,
    noteRateLimited: () => {},
    isRecentlyRateLimited: () => false,
  };
}

// A blind HTTP CONNECT relay standing in for the sx.org proxy.
function startConnectProxy() {
  const connects = [];
  const srv = net.createServer((client) => {
    client.on('error', () => {});
    client.once('data', (buf) => {
      const m = buf.toString('latin1').match(/^CONNECT (\S+) HTTP\/1\.1/);
      if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      connects.push(m[1]);
      const [host, port] = m[1].split(':');
      const up = net.connect({ port: Number(port), host, autoSelectFamily: true }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client); client.pipe(up);
      });
      up.on('error', () => client.destroy());
    });
  });
  return { srv, connects };
}

// No-auth SOCKS5 relay standing in for an account's own routing proxy.
function startSocks5() {
  const connects = [];
  const srv = net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', (chunk) => {
      if (stage === 'relay') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 + (buf[1] || 0)) return;
        buf = buf.subarray(2 + buf[1]);
        stage = 'request';
        client.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'request') {
        if (buf.length < 10) return;
        const host = [...buf.subarray(4, 8)].join('.');
        const port = buf.readUInt16BE(8);
        buf = buf.subarray(10);
        connects.push(`${host}:${port}`);
        const up = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buf.length) up.write(buf);
          up.pipe(client); client.pipe(up);
        });
        up.on('error', () => client.destroy());
        stage = 'relay';
      }
    });
  });
  return { srv, connects };
}

// Draws the frame while upstream holds the request, which is when the live row
// is on screen.
function upstreamHandler(tui, frames) {
  return (req, res) => {
    req.resume();
    req.on('end', () => {
      frames.push(renderPlain(tui));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    });
  };
}

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1, messages: [] }),
    signal: AbortSignal.timeout(20000),
  });
  await res.text();
  return res.status;
}

test('a request that leaves through sx.org says so on the live row and the log line', T, async () => {
  const tui = makeTUI();
  const frames = [];
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = https.createServer({ key: leafKeyPem, cert: leafCertPem }, upstreamHandler(tui, frames));
  const upPort = await listen(upstream);
  const sxProxy = startConnectProxy();
  const sx = makeSx(await listen(sxProxy.srv), caCertPem);

  const am = new AccountManager([{ name: 'direct@example.com', type: 'apikey', apiKey: 'sk-ant-test' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `https://localhost:${upPort}` }, tuiHooks(tui), sx);
  const port = await listen(proxy);
  try {
    assert.equal(await post(port), 200);
  } finally {
    closeHard(proxy); closeHard(upstream); closeHard(sxProxy.srv);
  }

  assert.deepEqual(sxProxy.connects, [`localhost:${upPort}`], 'the attempt really went through sx');
  assert.equal(frames.length, 1, 'upstream never saw the request, so the live row was never drawn');
  assert.match(frames[0], /→ direct@example\.com via sx \(/);
  assert.match(plain(tui.log[0].msg), /→ direct@example\.com via sx \(200, /);
});

test('a routed account never shows via sx, even with sx routing everything', T, async () => {
  const tui = makeTUI();
  const frames = [];
  const upstream = http.createServer(upstreamHandler(tui, frames));
  const upPort = await listen(upstream);
  const socks = startSocks5();
  const socksPort = await listen(socks.srv);
  const sxProxy = startConnectProxy();
  const sx = makeSx(await listen(sxProxy.srv), null);

  const am = new AccountManager([
    { name: 'routed@example.com', type: 'apikey', apiKey: 'sk-ant-test', routing: `socks5://127.0.0.1:${socksPort}` },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upPort}` }, tuiHooks(tui), sx);
  const port = await listen(proxy);
  try {
    assert.equal(await post(port), 200);
  } finally {
    closeHard(proxy); closeHard(upstream); closeHard(socks.srv); closeHard(sxProxy.srv);
  }

  assert.deepEqual(socks.connects, [`127.0.0.1:${upPort}`], 'the attempt left through the account\'s own proxy');
  assert.deepEqual(sxProxy.connects, [], 'and not through sx');
  assert.equal(frames.length, 1);
  assert.match(frames[0], /→ routed@example\.com \(/);
  assert.doesNotMatch(frames[0], /via sx/);
  assert.match(plain(tui.log[0].msg), /→ routed@example\.com \(200, /);
  assert.doesNotMatch(tui.log[0].msg, /via sx/);
});

test('a later attempt that leaves another way clears via sx from the live row', () => {
  const tui = makeTUI();
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestRouted('r1', { account: 'a', viaSx: true });
  assert.match(renderPlain(tui), /→ a via sx \(/);
  // A failover hop to an account with its own proxy.
  tui.onRequestRouted('r1', { account: 'b', viaSx: false });
  const frame = renderPlain(tui);
  assert.match(frame, /→ b \(/);
  assert.doesNotMatch(frame, /via sx/);
});

test('a request closed without an account keeps the last attempt\'s egress', () => {
  // The outer catch closes the row with `account: null`, so the line names the
  // last routed account, and the sx tag must be that attempt's too.
  const tui = makeTUI();
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestRouted('r1', { account: 'a', viaSx: true });
  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: null, status: 502, model: null, pinned: true });
  assert.match(plain(tui.log[0].msg), /→ a via sx \[pin\] \(502, /);
});

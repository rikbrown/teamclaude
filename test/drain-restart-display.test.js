import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The drain, end to end, through the real server: `u`, a request that will not
// finish, and a dashboard that has to still be there reporting on the wait.
// Every assertion here is about ORDER — what is painted before what, and what
// is painted before the terminal is handed back — which is the one property no
// unit test of either half can hold on its own.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

// Leaving the alternate screen. The last thing the TUI writes, and the thing an
// exit that forgets it leaves an operator without.
const SCREEN_BACK = '\x1b[?1049l';

// index.js runs the TUI only on a real terminal (`useTUI`), and `node --test`
// hands a child pipes. This fakes exactly the three things that check looks at
// — both isTTY flags and stdin's raw mode — so the child takes the same path an
// operator's terminal does and paints its escape sequences onto a pipe this
// test can read. argv is set before the import because index.js dispatches at
// module scope.
const CHILD = `
process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.argv = [process.argv[0], ${JSON.stringify(cliPath)}, 'server'];
await import(${JSON.stringify(pathToFileURL(cliPath).href)});
`;

/** A port nothing is listening on: bind one, learn its number, give it back. */
function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(pred, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) assert.fail(typeof what === 'function' ? what() : what);
    await delay(25);
  }
}

/** An upstream that takes a request and answers only when told to. For as long
 *  as it holds one the proxy counts it in flight, which is what gives the drain
 *  something to wait for. */
async function hangingUpstream(t) {
  let seen = 0;
  const held = [];
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    seen += 1;
    held.push(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const res of held.splice(0)) { try { res.end('{}'); } catch { /* client gone */ } }
    server.closeAllConnections();
    server.close();
  });
  return {
    port: server.address().port,
    seen: () => seen,
    release: () => { for (const res of held.splice(0)) res.end('{"id":"msg","content":[]}'); },
  };
}

/** The real `teamclaude server`, on a throwaway config, told that something is
 *  waiting to relaunch it — which is what wires `u` to the drain at all. */
async function server(t, upstreamPort) {
  const port = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'tc-drain-display-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    // The upstream is loopback: an ambient HTTPS_PROXY would tunnel to it and
    // the request would never reach the server holding it open.
    upstreamProxy: false,
    switchThreshold: 0.98,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: {
      ...process.env,
      TEAMCLAUDE_CONFIG: configPath,
      // "Something is waiting to relaunch this process" — the marker the
      // supervisor sets on its child, and the gate on the `u` key.
      TEAMCLAUDE_SUPERVISED: '1',
      TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
      // A child inherits the shell, so the in-config opt-out above needs this
      // half too (see test/README.md).
      HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', https_proxy: '', http_proxy: '', all_proxy: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

  await waitFor(async () => {
    try { const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`); await res.arrayBuffer(); return res.ok; }
    catch { return false; }
  }, () => `the server never came up:\n${out}`);

  return {
    child,
    out: () => out,
    exited,
    /** Fire a request the upstream will hold, and let the response go wherever. */
    send() {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      });
      req.on('error', () => { /* two of these tests exit the server out from under it */ });
      req.on('response', res => res.resume());
      req.end('{"model":"claude-3-5-sonnet-20241022","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}');
      t.after(() => req.destroy());
      return req;
    },
    /** Stop when it stops; never hang the suite waiting for the 30s deadline. */
    async exitedWithin(ms) {
      return Promise.race([exited, delay(ms).then(() => ({ code: 'still running', signal: null }))]);
    },
  };
}

/** Get a server to the point where it is draining with a request still held. */
async function drainingServer(t) {
  const upstream = await hangingUpstream(t);
  const srv = await server(t, upstream.port);
  srv.send();
  await waitFor(() => upstream.seen() > 0, () => `the proxy never forwarded:\n${srv.out()}`);
  srv.child.stdin.write('u');
  await waitFor(() => srv.out().includes('Restarting'), () => `the drain never reached the display:\n${srv.out()}`);
  return { upstream, srv };
}

test('the dashboard stays up for the whole drain and comes down only for the exit', { timeout: 60_000 }, async t => {
  const { upstream, srv } = await drainingServer(t);

  // The complaint, in one assertion: the display used to be the first thing to
  // go, and everything below this point happened behind a blank console.
  assert.ok(!srv.out().includes(SCREEN_BACK), 'the display came down at the start of the drain');

  // And it is a live display, not one frozen frame: the counter has to move.
  await delay(1600);
  const elapsed = new Set([...srv.out().matchAll(/(\d+)s\/30s/g)].map(m => m[1]));
  assert.ok(elapsed.size >= 2, `the elapsed reading never changed: ${[...elapsed].join(',') || '(none)'}`);
  assert.match(srv.out(), /1 in flight/, 'and it names what the drain is actually waiting for');

  upstream.release();
  const { code } = await srv.exitedWithin(20_000);
  assert.equal(code, 75, 'exit 75 is the ask to be relaunched, and nothing else means it');

  const out = srv.out();
  assert.ok(out.includes(SCREEN_BACK), 'the terminal never got its screen back');
  assert.ok(out.lastIndexOf('Restarting') < out.indexOf(SCREEN_BACK),
    'a drain frame was painted after the screen was handed back');
  assert.match(out, /Drained in/, 'the drain reported its own ending into the pane it was still painting');
});

// shutdown() opens with "if we are already shutting down, stop waiting and go".
// A drain sets that flag on its way in, so this is the path a ctrl-c takes out
// of one — and with the display now alive through the drain it is also the path
// that has to put the terminal back. It exits without it, and the operator is
// left on the alternate screen with raw mode still on.
test('ctrl-c during a drain gets out at once, with the terminal restored', { timeout: 60_000 }, async t => {
  const { srv } = await drainingServer(t);

  srv.child.stdin.write('\x03');
  const { code } = await srv.exitedWithin(10_000);
  assert.equal(code, 0, 'ctrl-c is not a restart, and must not wait out the 30s deadline either');
  assert.ok(srv.out().includes(SCREEN_BACK), 'the terminal was left on the alternate screen');
});

// The same guard, reached the other way: in raw mode ctrl-c never becomes a
// signal, but a supervisor passing on a SIGTERM (or a plain `kill -INT`) lands
// on exactly the same line, with the TUI up and nothing after it.
test('a signal during a drain restores the terminal too', { timeout: 60_000 }, async t => {
  const { srv } = await drainingServer(t);

  srv.child.kill('SIGINT');
  const { code } = await srv.exitedWithin(10_000);
  assert.equal(code, 0);
  assert.ok(srv.out().includes(SCREEN_BACK), 'the terminal was left on the alternate screen');
});

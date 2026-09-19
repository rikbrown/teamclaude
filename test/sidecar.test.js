import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Sidecar, restartDelayMs, isBindConflict, monitorPort, monitorCounts } from '../src/sidecar.js';

// A fake child process: enough surface for the supervisor (pid, kill, 'exit'/
// 'error' events, a stderr emitter). Lets tests crash and kill children at will.
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.kills = [];
    this.stderr = new EventEmitter();
    // Which signal, counted, this child finally goes on — 1 for "the first one
    // is enough", 2 for the real sidecar, null for one that ignores them all.
    // Default null so every test written before stop() could wait is untouched.
    this.diesOnKill = null;
  }
  kill(sig) {
    this.kills.push(sig || 'SIGTERM');
    // Asynchronously, like a real child: a synchronous exit here would be
    // delivered before the caller could subscribe, which is exactly the bug
    // the ordering inside _stopChild is written to avoid.
    if (this.diesOnKill != null && this.kills.length >= this.diesOnKill) {
      setImmediate(() => this.emit('exit', null, sig || 'SIGTERM'));
    }
  }
}

// Records each spawn spec and hands out FakeChildren in order.
function fakeSpawner() {
  const calls = [];
  const children = [];
  let nextPid = 100;
  const fn = (spec) => {
    calls.push(spec);
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  };
  fn.calls = calls;
  fn.children = children;
  return fn;
}

function makeSidecar(entries, spawnFn, opts = {}) {
  return new Sidecar(entries, { spawnFn, baseRestartMs: 10, maxRestartMs: 40, log: () => {}, ...opts });
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── spawning ─────────────────────────────────────────────────────────────────

test('start() spawns each configured sidecar with its command, args and env', () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([
    { name: 'codex', command: ['claude-code-proxy', 'serve', '--no-monitor', '--port', '18765'], env: { XDG_STATE_HOME: '/tmp/state' } },
    { name: 'other', command: ['other-proxy'] },
  ], spawn);
  sc.start();

  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[0].name, 'codex');
  assert.equal(spawn.calls[0].command, 'claude-code-proxy');
  assert.deepEqual(spawn.calls[0].args, ['serve', '--no-monitor', '--port', '18765']);
  assert.equal(spawn.calls[0].env.XDG_STATE_HOME, '/tmp/state'); // entry env wins
  assert.ok(spawn.calls[0].env.PATH); // merged over process.env, not replacing it
  assert.equal(spawn.calls[1].command, 'other-proxy');
  sc.stop();
});

test('start() with no sidecars configured is a no-op', () => {
  const spawn = fakeSpawner();
  new Sidecar([], { spawnFn: spawn }).start();
  new Sidecar(undefined, { spawnFn: spawn }).start();
  assert.equal(spawn.calls.length, 0);
});

// ── crash → respawn ──────────────────────────────────────────────────────────

test('respawns a crashed sidecar after the backoff delay', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  spawn.children[0].emit('exit', 1, null);
  assert.equal(spawn.calls.length, 1); // not synchronously
  await wait(30);
  assert.equal(spawn.calls.length, 2);
  assert.equal(sc.getStatus()[0].restarts, 1);
  sc.stop();
});

test('a child that fails to launch (spawn error) is also retried', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['nonexistent-bin'] }], spawn);
  sc.start();

  spawn.children[0].emit('error', new Error('ENOENT'));
  await wait(30);
  assert.equal(spawn.calls.length, 2);
  sc.stop();
});

test('restartDelayMs doubles per consecutive crash and caps at maxRestartMs', () => {
  const opts = { baseRestartMs: 1000, maxRestartMs: 30_000 };
  assert.equal(restartDelayMs(0, opts), 1000);
  assert.equal(restartDelayMs(1, opts), 2000);
  assert.equal(restartDelayMs(2, opts), 4000);
  assert.equal(restartDelayMs(10, opts), 30_000);
});

// ── stop ─────────────────────────────────────────────────────────────────────

test('stop() kills running children and suppresses respawn', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  sc.stop();
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM']);
  spawn.children[0].emit('exit', null, 'SIGTERM');
  await wait(30);
  assert.equal(spawn.calls.length, 1); // no respawn after stop
});

test('stop() cancels a pending respawn timer', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  spawn.children[0].emit('exit', 1, null); // respawn now pending
  sc.stop();
  await wait(30);
  assert.equal(spawn.calls.length, 1);
});

// ── stop: the grace, and the escalation ──────────────────────────────────────

// The sidecar (claude-code-proxy v0.1.40+) reads the first SIGTERM as "begin a
// graceful shutdown" and only forces its exit on a second. One polite signal
// and an immediate process.exit() therefore left it running on its port.

test('stop() resolves when the child has actually gone, not when the signal is sent', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();
  spawn.children[0].diesOnKill = 1;

  const started = Date.now();
  await sc.stop({ graceMs: 5_000 });
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM']);
  assert.ok(Date.now() - started < 1_000, 'a child that goes at once must not serve out the grace');
});

test('stop() gives up when the grace expires rather than waiting for ever', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  await sc.stop({ graceMs: 20 });   // this child never exits
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM'], 'a patient caller escalates to nothing');
});

test('stop({force}) escalates to the forcing signal when the grace expires', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();
  spawn.children[0].diesOnKill = 2;   // the real sidecar's semantics

  await sc.stop({ graceMs: 20, force: true });
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM', 'SIGTERM']);
});

test('stop({force}) falls back to SIGKILL if even the forcing signal is ignored', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  await sc.stop({ graceMs: 20, force: true });
  // The backstop is not about today's sidecar — it is what keeps this working
  // when upstream changes the meaning of a signal again.
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
});

test('stop() with no grace signals synchronously and waits for nothing', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  const stopped = sc.stop();   // this child never exits
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM'], 'the signal goes out before any await');
  await stopped;               // and the promise still settles
});

test('stop() waits on every child, and settles when there is none to wait for', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([
    { name: 'codex', command: ['ccp'] },
    { name: 'other', command: ['other-proxy'] },
  ], spawn);
  sc.start();
  spawn.children[0].diesOnKill = 1;
  spawn.children[1].diesOnKill = 2;

  await sc.stop({ graceMs: 20, force: true });
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM']);
  assert.deepEqual(spawn.children[1].kills, ['SIGTERM', 'SIGTERM']);

  // Already down, so there is no child to signal and nothing to wait for. A
  // shutdown that hung here would hang on the one case it cannot fix.
  const down = makeSidecar([{ name: 'codex', command: ['ccp'] }], fakeSpawner());
  down.start();
  down.states[0].child.emit('exit', 1, null);
  await down.stop({ graceMs: 5_000, force: true });
});

// ── status ───────────────────────────────────────────────────────────────────

test('getStatus() reports name, running state, pid, restarts and last exit', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  let [s] = sc.getStatus();
  assert.equal(s.name, 'codex');
  assert.equal(s.running, true);
  assert.equal(s.pid, 100);
  assert.equal(s.restarts, 0);
  assert.equal(s.lastExit, null);

  spawn.children[0].emit('exit', 3, null);
  [s] = sc.getStatus();
  assert.equal(s.running, false);
  assert.equal(s.lastExit, 'code 3');
  sc.stop();
});

test('getStatus() keeps the last stderr lines for diagnosis', () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, { stderrTailLines: 2 });
  sc.start();

  spawn.children[0].stderr.emit('data', Buffer.from('line one\nline two\n'));
  spawn.children[0].stderr.emit('data', Buffer.from('line three\n'));
  const [s] = sc.getStatus();
  assert.deepEqual(s.stderrTail, ['line two', 'line three']); // capped at last 2
  sc.stop();
});

// ── a held port ──────────────────────────────────────────────────────────────

// A sidecar binds a fixed port, so a copy that outlives its server keeps that
// port and every later server fails to bind. Reported as a bare "code 1" and
// retried forever, that looked like a broken binary; it is the opposite.

test('a bind conflict on stderr is reported as blocked, not as a plain crash', () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();

  spawn.children[0].stderr.emit('data', Buffer.from(
    'Error: failed to bind proxy listener on 127.0.0.1:18765: Address already in use (os error 48)\n'));
  const [s] = sc.getStatus();
  assert.equal(s.blocked, true);
  assert.match(s.blockedReason, /Address already in use/);
  sc.stop();
});

test('an ordinary crash is not reported as blocked', () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();
  spawn.children[0].stderr.emit('data', Buffer.from('panicked at src/main.rs:12\n'));
  spawn.children[0].emit('exit', 1, null);
  const [s] = sc.getStatus();
  assert.equal(s.blocked, false);
  assert.equal(s.lastExit, 'code 1');
  sc.stop();
});

test('a retry clears the previous attempt s bind conflict', async () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn);
  sc.start();
  spawn.children[0].stderr.emit('data', Buffer.from('Address already in use (os error 48)\n'));
  spawn.children[0].emit('exit', 1, null);
  assert.equal(sc.getStatus()[0].blocked, true);
  await wait(30);
  assert.equal(sc.getStatus()[0].blocked, false, 'the new attempt starts clean');
  sc.stop();
});

// ── reaping our own orphan ───────────────────────────────────────────────────

/** A fake `ps`: pid -> {ppid, command}, absent means not running. */
function fakeProcs(table) {
  const fn = (pid) => table[pid] || null;
  return fn;
}
function recordKills() {
  const kills = [];
  const fn = (pid, signal) => kills.push([pid, signal]);
  fn.kills = kills;
  return fn;
}

test('an orphan this server recorded is reaped before the respawn', () => {
  const spawn = fakeSpawner();
  const killFn = recordKills();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp', '--port', '18765'] }], spawn, {
    savedPids: { codex: { pid: 4242, command: 'ccp' } },
    readProcess: fakeProcs({ 4242: { ppid: 1, command: '/usr/local/bin/ccp --port 18765' } }),
    killFn,
  });
  sc.start();
  assert.deepEqual(killFn.kills, [[4242, 'SIGTERM']]);
  sc.stop();
});

test('a recorded pid that still has a parent belongs to a live server and is left alone', () => {
  const spawn = fakeSpawner();
  const killFn = recordKills();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, {
    savedPids: { codex: { pid: 4242, command: 'ccp' } },
    readProcess: fakeProcs({ 4242: { ppid: 900, command: '/usr/local/bin/ccp' } }),
    killFn,
  });
  sc.start();
  assert.deepEqual(killFn.kills, [], 'another supervisor owns it');
  sc.stop();
});

test('a recycled pid running a different program is left alone', () => {
  const spawn = fakeSpawner();
  const killFn = recordKills();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, {
    savedPids: { codex: { pid: 4242, command: 'ccp' } },
    readProcess: fakeProcs({ 4242: { ppid: 1, command: '/usr/bin/some-unrelated-daemon' } }),
    killFn,
  });
  sc.start();
  assert.deepEqual(killFn.kills, [], 'the pid was recycled, it is not our sidecar');
  sc.stop();
});

test('nothing is signalled when there is no record, or the pid is gone', () => {
  const spawn = fakeSpawner();
  const killFn = recordKills();
  makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, { killFn, readProcess: fakeProcs({}) }).start();
  makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, {
    savedPids: { codex: { pid: 4242, command: 'ccp' } },
    readProcess: fakeProcs({}),   // not running
    killFn,
  }).start();
  assert.deepEqual(killFn.kills, []);
});

// ── recording pids ───────────────────────────────────────────────────────────

test('a live pid is published for the owner to persist', () => {
  const spawn = fakeSpawner();
  const seen = [];
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, { onPids: (p) => seen.push(p) });
  sc.start();
  assert.deepEqual(seen.at(-1), { codex: { pid: 100, command: 'ccp' } });
  sc.stop();
});

test('a down sidecar keeps its recorded pid, which is exactly when it is needed', () => {
  const spawn = fakeSpawner();
  const sc = makeSidecar([{ name: 'codex', command: ['ccp'] }], spawn, {
    savedPids: { codex: { pid: 4242, command: 'ccp' } },
    readProcess: fakeProcs({}),
  });
  sc.start();
  spawn.children[0].emit('exit', 1, null);
  // Blocked-and-down is the case where the older pid identifies the leftover;
  // dropping it here would discard the one fact that makes a reap possible.
  assert.deepEqual(sc.exportPids().codex, { pid: 100, command: 'ccp' });
  sc.stop();
});

test('isBindConflict matches the phrasings runtimes actually print', () => {
  assert.equal(isBindConflict('Address already in use (os error 48)'), true);
  assert.equal(isBindConflict('listen EADDRINUSE: address already in use 127.0.0.1:3456'), true);
  assert.equal(isBindConflict('panicked at src/main.rs'), false);
});

// ── the health readout ───────────────────────────────────────────────────────

// Active requests and recent errors, polled off the sidecar's own /monitor. The
// endpoint is upstream's, so every test below is really the same test: what
// this does when the answer is not the one it expected. The shapes come from a
// live claude-code-proxy 0.1.40 started with `--no-monitor`, which is how
// TeamClaude spawns it.

/** One reply, the way `fetch` hands it over. `length` overrides the declared
 *  size; null stands for a reply that declares none at all. */
function fakeReply(body, { ok = true, length } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const declared = length === undefined ? String(Buffer.byteLength(text)) : length;
  return {
    ok,
    headers: { get: (h) => (h === 'content-length' ? declared : null) },
    text: async () => text,
  };
}

/** A fetch that answers every call the same way, and counts them. */
function fakeFetcher(reply) {
  const urls = [];
  const fn = async (/** @type {string} */ url) => {
    urls.push(url);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  };
  fn.urls = urls;
  return fn;
}

// The live payload, trimmed to the fields this reads.
const monitorBody = (active = 0, failed = 0) => ({
  version: 1,
  snapshot: {
    started_at: { secs_since_epoch: 1789817857, nanos_since_epoch: 626722000 },
    uptime: { secs: 24, nanos: 835849292 },
    sessions: [],
    active: Array.from({ length: active }, (_, n) => ({ request_id: `r${n}`, status: 'upstream' })),
    recent: [
      ...Array.from({ length: failed }, (_, n) => ({ request_id: `f${n}`, status: 'failed', http_status: 400 })),
      { request_id: 'ok', status: 'completed', http_status: 200 },
    ],
  },
});

/** The supervisor's status once at least one poll has been answered. */
async function pollOnce(sc) {
  for (let i = 0; i < 100 && sc.getStatus()[0].activeRequests === null; i++) await wait(5);
  return sc.getStatus()[0];
}

test('monitorPort reads the port out of the command the operator configured', () => {
  assert.equal(monitorPort(['ccp', 'serve', '--no-monitor', '--port', '18765']), 18765);
  assert.equal(monitorPort(['ccp', 'serve', '--port=18999']), 18999);
  // Nothing to ask, so nothing is asked: better a line without numbers than
  // numbers from whatever else happens to be listening on a guessed port.
  assert.equal(monitorPort(['ccp', 'serve', '--no-monitor']), null);
  assert.equal(monitorPort(['ccp', '--port', 'nonsense']), null);
  assert.equal(monitorPort(['ccp', '--port', '70000']), null);
  assert.equal(monitorPort(undefined), null);
});

test('monitorCounts reads the live payload, and refuses one it does not recognise', () => {
  assert.deepEqual(monitorCounts(monitorBody(2, 3)), { activeRequests: 2, recentErrors: 3 });
  assert.deepEqual(monitorCounts(monitorBody(0, 0)), { activeRequests: 0, recentErrors: 0 });
  // Upstream renaming or dropping these is a rebase away, and this may not
  // become a dependency: unknown reads as "no numbers", never as zero.
  assert.equal(monitorCounts({ version: 2, snapshot: { requests: [] } }), null);
  assert.equal(monitorCounts({ version: 1 }), null);
  assert.equal(monitorCounts(null), null);
  // Half a shape still answers for the half it has.
  assert.deepEqual(monitorCounts({ snapshot: { active: [] } }), { activeRequests: 0, recentErrors: null });
});

test('the readout reaches getStatus, from the sidecar own port on loopback', async () => {
  const spawn = fakeSpawner();
  const fetchFn = fakeFetcher(fakeReply(monitorBody(2, 3)));
  const sc = makeSidecar([{ name: 'codex', command: ['ccp', 'serve', '--port', '18765'] }], spawn, {
    fetchFn, monitorPollMs: 5,
  });
  sc.start();

  const status = await pollOnce(sc);
  assert.equal(status.activeRequests, 2);
  assert.equal(status.recentErrors, 3);
  assert.equal(fetchFn.urls[0], 'http://127.0.0.1:18765/monitor');
  await sc.stop();
});

test('an endpoint that is missing, silent or changed leaves the process line alone', async () => {
  const spawn = fakeSpawner();
  for (const [why, reply] of [
    ['nothing listening yet', new Error('connect ECONNREFUSED 127.0.0.1:18765')],
    ['a 404, because upstream moved it', fakeReply('{}', { ok: false })],
    ['something that is not the sidecar on the port', fakeReply('<html>not json</html>')],
    ['a schema this no longer recognises', fakeReply({ version: 2, snapshot: { requests: [] } })],
    ['a body too big to buffer on a timer', fakeReply(monitorBody(1, 1), { length: '99999999' })],
    ['a body whose size is not declared', fakeReply(monitorBody(1, 1), { length: null })],
  ]) {
    const sc = makeSidecar([{ name: 'codex', command: ['ccp', '--port', '18765'] }], spawn, {
      fetchFn: fakeFetcher(reply), monitorPollMs: 5,
    });
    sc.start();
    await wait(30);
    const [status] = sc.getStatus();
    assert.equal(status.running, true, `the supervisor itself is unaffected by ${why}`);
    assert.ok(status.pid > 0);
    assert.equal(status.activeRequests, null, why);
    assert.equal(status.recentErrors, null, why);
    await sc.stop();
  }
});

test('a command with no --port is never polled at all', async () => {
  const spawn = fakeSpawner();
  const fetchFn = fakeFetcher(fakeReply(monitorBody(2, 3)));
  const sc = makeSidecar([{ name: 'codex', command: ['ccp', 'serve'] }], spawn, { fetchFn, monitorPollMs: 5 });
  sc.start();
  await wait(30);
  assert.deepEqual(fetchFn.urls, []);
  assert.equal(sc.getStatus()[0].activeRequests, null);
  await sc.stop();
});

test('polling stops when the child goes down, and its numbers go with it', async () => {
  const spawn = fakeSpawner();
  const fetchFn = fakeFetcher(fakeReply(monitorBody(2, 3)));
  const sc = makeSidecar([{ name: 'codex', command: ['ccp', '--port', '18765'] }], spawn, {
    fetchFn, monitorPollMs: 5, baseRestartMs: 10_000,   // no respawn during this test
  });
  sc.start();
  await pollOnce(sc);

  spawn.children[0].emit('exit', 1, null);
  // "2 active" printed beside "down (code 1)" describes a process that is gone.
  assert.equal(sc.getStatus()[0].activeRequests, null);
  const polled = fetchFn.urls.length;
  await wait(30);
  assert.equal(fetchFn.urls.length, polled, 'nothing is left asking a dead port');
  await sc.stop();
});

test('a poll still in flight when the child dies does not write its numbers back', async () => {
  const spawn = fakeSpawner();
  /** @type {null | (() => void)} */
  let answer = null;
  const fetchFn = () => new Promise(resolve => { answer = () => resolve(fakeReply(monitorBody(2, 3))); });
  const sc = makeSidecar([{ name: 'codex', command: ['ccp', '--port', '18765'] }], spawn, {
    fetchFn, monitorPollMs: 5, baseRestartMs: 10_000,   // no respawn during this test
  });
  sc.start();
  for (let i = 0; i < 100 && !answer; i++) await wait(5);   // a poll is out

  spawn.children[0].emit('exit', 1, null);
  answer();                 // ... and lands after the child is already gone
  await wait(20);
  assert.equal(sc.getStatus()[0].activeRequests, null, 'a dead process has no active requests');
  await sc.stop();
});

test('stop() ends the polling too', async () => {
  const spawn = fakeSpawner();
  const fetchFn = fakeFetcher(fakeReply(monitorBody(2, 3)));
  const sc = makeSidecar([{ name: 'codex', command: ['ccp', '--port', '18765'] }], spawn, {
    fetchFn, monitorPollMs: 5,
  });
  sc.start();
  await pollOnce(sc);

  spawn.children[0].diesOnKill = 1;
  await sc.stop({ graceMs: 100 });
  const polled = fetchFn.urls.length;
  await wait(30);
  assert.equal(fetchFn.urls.length, polled);
  assert.equal(sc.getStatus()[0].activeRequests, null);
});

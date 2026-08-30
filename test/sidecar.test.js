import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Sidecar, restartDelayMs } from '../src/sidecar.js';

// A fake child process: enough surface for the supervisor (pid, kill, 'exit'/
// 'error' events, a stderr emitter). Lets tests crash and kill children at will.
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.kills = [];
    this.stderr = new EventEmitter();
  }
  kill(sig) { this.kills.push(sig || 'SIGTERM'); }
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

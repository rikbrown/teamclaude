import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { superviseServer, RESTART_EXIT_CODE, RESTART_COUNT_ENV, SUPERVISED_ENV } from '../src/restart.js';

// A foreground TUI cannot re-exec itself — the parent exits, the shell prints a
// prompt, and the child fights it for the terminal — so the drain ends in an
// exit code and something outside the process acts on it. This is that
// something, and everything it must not do is as load-bearing as what it does:
// relaunch on 75, pass anything else straight through, and refuse to keep
// relaunching a build that asks to restart the moment it is up.

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.kills = [];
  }
  kill(sig) { this.kills.push(sig || 'SIGTERM'); }
}

/** Records each spawn and hands out FakeChildren in order. */
function fakeSpawner() {
  const calls = [];
  const children = [];
  let nextPid = 500;
  const fn = (file, argv, opts) => {
    calls.push({ file, argv, opts });
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  };
  fn.calls = calls;
  fn.children = children;
  return fn;
}

function supervise(spawnFn, opts = {}) {
  return superviseServer({
    argv: ['/pkg/src/index.js', 'server', '--supervise'],
    spawnFn, execPath: '/usr/bin/node', env: { PATH: '/bin' },
    log: () => {}, onSignal: () => {},
    ...opts,
  });
}

test('it runs the server with the supervise flag removed, on the real terminal', async () => {
  const spawn = fakeSpawner();
  const done = supervise(spawn);
  spawn.children[0].emit('exit', 0, null);
  assert.equal(await done, 0);

  const [call] = spawn.calls;
  assert.equal(call.file, '/usr/bin/node');
  assert.deepEqual(call.argv, ['/pkg/src/index.js', 'server'], 'a child that supervises too would fork forever');
  assert.equal(call.opts.stdio, 'inherit', 'the TUI needs the actual tty, raw mode and all');
  assert.equal(call.opts.env[SUPERVISED_ENV], '1');
  assert.equal(call.opts.env[RESTART_COUNT_ENV], '0');
  assert.equal(call.opts.env.PATH, '/bin', 'the rest of the environment is passed through');
});

test('exit 75 is a request to be relaunched, and the relaunch is counted', async () => {
  const spawn = fakeSpawner();
  const done = supervise(spawn);
  spawn.children[0].emit('exit', RESTART_EXIT_CODE, null);
  spawn.children[1].emit('exit', RESTART_EXIT_CODE, null);
  spawn.children[2].emit('exit', 0, null);

  assert.equal(await done, 0);
  assert.equal(spawn.calls.length, 3);
  assert.deepEqual(spawn.calls.map(c => c.opts.env[RESTART_COUNT_ENV]), ['0', '1', '2'],
    'the child says which relaunch it is, so it can announce itself');
});

test('any other exit is the server\'s answer and ends the supervisor with it', async () => {
  for (const code of [0, 1, 3]) {
    const spawn = fakeSpawner();
    const done = supervise(spawn);
    spawn.children[0].emit('exit', code, null);
    assert.equal(await done, code);
    assert.equal(spawn.calls.length, 1, `exit ${code} must not relaunch`);
  }
});

test('a server that was killed is not second-guessed', async () => {
  const spawn = fakeSpawner();
  const done = supervise(spawn);
  spawn.children[0].emit('exit', null, 'SIGTERM');
  assert.equal(await done, 143, '128+15, the shell\'s own convention');
  assert.equal(spawn.calls.length, 1);
});

test('a build that asks to restart the moment it is up is stopped, not obeyed', async () => {
  const spawn = fakeSpawner();
  const said = [];
  const done = supervise(spawn, { log: line => said.push(line), now: () => 1000, limit: 5, windowMs: 60_000 });

  // Six requests inside one window: five relaunches, then the guard.
  for (let i = 0; i < 6; i++) spawn.children[i].emit('exit', RESTART_EXIT_CODE, null);

  assert.equal(await done, 1);
  assert.equal(spawn.calls.length, 6, 'the sixth ask is refused, so there is no seventh child');
  assert.match(said.join('\n'), /looping, not updating/);
});

test('restarts spread out over time are not a loop', async () => {
  const spawn = fakeSpawner();
  let clock = 0;
  const done = supervise(spawn, { now: () => clock, limit: 2, windowMs: 1000 });
  for (let i = 0; i < 6; i++) {
    clock += 5000; // each one well outside the window of the last
    spawn.children[i].emit('exit', RESTART_EXIT_CODE, null);
  }
  spawn.children[6].emit('exit', 0, null);
  assert.equal(await done, 0);
});

test('SIGTERM is passed on; SIGINT is not, because the terminal already sent it', async () => {
  const spawn = fakeSpawner();
  const handlers = {};
  const done = supervise(spawn, { onSignal: (event, fn) => { handlers[event] = fn; } });

  handlers.SIGINT();
  assert.deepEqual(spawn.children[0].kills, [],
    'ctrl-c reaches the whole foreground group; a second one tells the server to stop waiting and skip its teardown');

  handlers.SIGTERM();
  assert.deepEqual(spawn.children[0].kills, ['SIGTERM'],
    'SIGTERM is aimed at this pid alone, so the child would otherwise keep the terminal');

  // And a 75 that arrives after the operator asked to stop is not a relaunch.
  spawn.children[0].emit('exit', RESTART_EXIT_CODE, null);
  assert.equal(await done, RESTART_EXIT_CODE);
  assert.equal(spawn.calls.length, 1);
});

test('a server that cannot be started is reported once, not retried forever', async () => {
  const said = [];
  const spawn = () => { throw new Error('ENOENT'); };
  assert.equal(await supervise(/** @type {any} */ (spawn), { log: line => said.push(line) }), 1);
  assert.match(said.join('\n'), /Could not start the server/);
});

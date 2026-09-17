import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVersionSource, gitHeadSource, npmVersionSource, UpdateWatcher,
  FLEET_IDLE_MS, RESTART_DEADLINE_MS,
} from '../src/update-watch.js';

// Two install shapes, two signals. The operator's own copy is a git checkout —
// npm refuses to touch one by design — so a trigger that only watched the
// registry would be dead code on the machine this exists for.

/** A git that answers with each of `answers` in turn, repeating the last. */
function fakeGit(answers) {
  let i = 0;
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const out = answers[Math.min(i++, answers.length - 1)];
    if (out instanceof Error) throw out;
    return { stdout: `${out}\n` };
  };
  exec.calls = calls;
  return exec;
}

const SHA_A = '1779db6f1c0ea3e9f0f2d3b4a5c6d7e8f9a0b1c2';
const SHA_B = 'e2b170a9876543210fedcba9876543210fedcba9';

// ── git checkouts ────────────────────────────────────────────

test('a checkout reports nothing until HEAD moves off the sha it started on', async () => {
  const exec = fakeGit([SHA_A, SHA_A, SHA_B, SHA_B]);
  const source = gitHeadSource({ root: '/pkg', exec });

  assert.equal(await source.read(), null, 'the first reading is what is already running');
  assert.equal(await source.read(), null);
  assert.equal(await source.read(), SHA_B, 'a pull in the deploy clone is the deploy');
  assert.equal(await source.read(), SHA_B, 'and stays pending until something acts on it');
});

test('the checkout is read at the package root, never the process cwd', async () => {
  const exec = fakeGit([SHA_A]);
  await gitHeadSource({ root: '/pkg', exec }).read();
  assert.deepEqual(exec.calls[0].args, ['rev-parse', 'HEAD']);
  assert.equal(exec.calls[0].opts.cwd, '/pkg', 'the server runs from the operator\'s project, which is another repository');
  assert.ok(exec.calls[0].opts.timeout > 0, 'a checkout on a stalled mount must cost a skipped check, not a stuck timer');
});

test('a git that cannot answer costs a check, never a restart', async () => {
  const source = gitHeadSource({ root: '/pkg', exec: fakeGit([new Error('no git binary')]) });
  assert.equal(await source.read(), null);
});

test('git reporting a problem on stdout is not a new build', async () => {
  // Treated as a sha this would restart the proxy on every poll for as long as
  // the problem lasted.
  const source = gitHeadSource({ root: '/pkg', exec: fakeGit(['fatal: not a git repository']) });
  assert.equal(await source.read(), null);
  assert.equal(await source.read(), null);
});

test('a first read that failed does not become the baseline', async () => {
  const source = gitHeadSource({ root: '/pkg', exec: fakeGit([new Error('busy'), SHA_A, SHA_A]) });
  assert.equal(await source.read(), null);
  assert.equal(await source.read(), null, 'the first sha that arrives is what is running');
  assert.equal(await source.read(), null);
});

// ── global npm installs ──────────────────────────────────────

async function withPackage(version, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-watch-'));
  const write = (/** @type {string} */ v) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: v }));
  write(version);
  try { return await fn(dir, write); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('an install reports the newer version npm wrote underneath the running process', async () => {
  await withPackage('1.1.20-rik.11', async (root, write) => {
    const source = npmVersionSource({ root, running: '1.1.20-rik.11' });
    assert.equal(await source.read(), null, 'the version on disk is the one running');
    write('1.1.20-rik.12');
    assert.equal(await source.read(), '1.1.20-rik.12');
  });
});

test('a reinstall or a downgrade is not something to relaunch into', async () => {
  await withPackage('1.1.20-rik.11', async (root, write) => {
    const source = npmVersionSource({ root, running: '1.1.20-rik.11' });
    assert.equal(await source.read(), null);
    write('1.1.20-rik.10');
    assert.equal(await source.read(), null);
  });
});

test('a version that is not a release is never restarted into', async () => {
  await withPackage('1.1.20-rik.11', async (root, write) => {
    const source = npmVersionSource({ root, running: '1.1.20-rik.11' });
    write('99.0.0 || npm:evil');
    assert.equal(await source.read(), null);
  });
});

// ── picking one ──────────────────────────────────────────────

test('the install kind picks the signal, and an npx copy gets none', async () => {
  const exec = fakeGit([SHA_A]);
  assert.equal((await createVersionSource({ root: '/pkg', kind: async () => 'git', exec }))?.kind, 'git');
  assert.equal((await createVersionSource({ root: '/pkg', kind: async () => 'global', running: '1.0.0' }))?.kind, 'global');
  // Nothing rewrites a local dependency or an npx copy, so a restart would come
  // back on the very same build.
  assert.equal(await createVersionSource({ root: '/pkg', kind: async () => 'local' }), null);
  assert.equal(await createVersionSource({ root: '/pkg', kind: async () => 'unknown' }), null);
});

// ── deciding when ────────────────────────────────────────────

function fixture({ read, idle }) {
  const fired = [];
  const said = [];
  let clock = 0;
  const watcher = new UpdateWatcher({
    source: { kind: 'git', describes: 'the checkout HEAD', read },
    isIdle: idle,
    onRestart: info => fired.push(info),
    now: () => clock,
    log: line => said.push(line),
  });
  return { watcher, fired, said, tick: (/** @type {number} */ ms) => { clock += ms; } };
}

test('with nothing waiting, nothing happens', async () => {
  const { watcher, fired, said, tick } = fixture({ read: async () => null, idle: () => true });
  await watcher.check();
  tick(RESTART_DEADLINE_MS * 2);
  await watcher.check();
  assert.deepEqual(fired, []);
  assert.deepEqual(said, []);
});

test('a waiting build is applied once the fleet has been quiet long enough', async () => {
  let build = null;
  let idle = false;
  const { watcher, fired, said, tick } = fixture({ read: async () => build, idle: () => idle });

  await watcher.check();
  build = SHA_B;
  await watcher.check();
  assert.deepEqual(fired, [], 'a fleet mid-conversation loses its connections for nothing');
  assert.equal(said.length, 1, 'said once, when it starts waiting');

  tick(FLEET_IDLE_MS * 3);
  await watcher.check();
  assert.deepEqual(fired, []);

  idle = true;
  await watcher.check();
  assert.deepEqual(fired, [], 'one quiet reading is not a quiet fleet');

  tick(FLEET_IDLE_MS);
  await watcher.check();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].build, SHA_B);
  assert.equal(fired[0].forced, false);

  // The restart it asked for ends the process; a second ask would be noise.
  tick(FLEET_IDLE_MS);
  await watcher.check();
  assert.equal(fired.length, 1);
});

test('a fleet that goes busy again has to earn its quiet period afresh', async () => {
  let idle = true;
  const { watcher, fired, tick } = fixture({ read: async () => SHA_B, idle: () => idle });
  await watcher.check();
  idle = false;
  tick(FLEET_IDLE_MS);
  await watcher.check();
  idle = true;
  tick(FLEET_IDLE_MS);
  await watcher.check();
  assert.deepEqual(fired, [], 'the quiet only counts from where it started again');
});

test('a fleet that never goes quiet is restarted anyway', async () => {
  const { watcher, fired, tick } = fixture({ read: async () => SHA_B, idle: () => false });
  await watcher.check();
  tick(RESTART_DEADLINE_MS - 1);
  await watcher.check();
  assert.deepEqual(fired, [], 'not yet — the drain is what protects them, but only at the end');

  tick(1);
  await watcher.check();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].forced, true, 'the log line has to be able to say which of the two this was');
  assert.equal(fired[0].waitedMs, RESTART_DEADLINE_MS);
});

test('a watcher with no source starts and stops without doing anything', async () => {
  const fired = [];
  const watcher = new UpdateWatcher({ source: null, isIdle: () => true, onRestart: () => fired.push(1) });
  watcher.start();
  assert.equal(watcher.timer, null);
  assert.equal(await watcher.check(), null);
  watcher.stop();
  assert.deepEqual(fired, []);
});

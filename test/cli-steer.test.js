import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { closedPort } from '../test-helpers/spawn-server.js';

// `teamclaude steer` drives the real control endpoint, so these run the CLI
// against a real proxy server rather than a stubbed one (as cli-switch does).

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const H = 3600_000;

const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com (Acme)', type: 'apikey', apiKey: 'k2' },
  { name: 'off@example.com', type: 'apikey', apiKey: 'k3', disabled: true },
];

const listen = (/** @type {any} */ server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** @param {number} port */
async function writeConfig(port) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-steer-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: ACCTS,
  }));
  return path;
}

/** @param {string} configPath @param {string[]} cliArgs */
function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 10_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** @param {(am: AccountManager, configPath: string) => Promise<void>} fn */
async function withProxy(fn) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  const configPath = await writeConfig(port);
  const log = console.log;
  console.log = () => {}; // the server's own lines, not the CLI's
  try {
    await fn(am, configPath);
  } finally {
    console.log = log;
    proxy.closeAllConnections?.();
    proxy.close();
  }
}

test('steer NAME --for sets the steer, says when it ends, and leaves the cursor alone', async () => {
  await withProxy(async (am, configPath) => {
    const res = /** @type {any} */ (await runCli(configPath, ['steer', 'bob@example.com (Acme)', '--for', '6h']));
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Steering new conversations to "bob@example\.com \(Acme\)" for 6h \(until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)/);
    assert.match(res.stdout, /Running conversations stay where they are/);
    const [steer] = am.steerList();
    assert.equal(steer.target, 'bob@example.com (Acme)');
    assert.equal(steer.until - steer.startedAt, 6 * H, 'six hours from when it was set, to the millisecond');
    assert.match(res.stdout, new RegExp(`\\(until ${new Date(steer.until).toISOString().replace(/\.\d{3}Z$/, 'Z')}\\)`));
    assert.equal(am.currentIndex, 0);
  });
});

test('bare steer lists the steers in force, and --clear ends them', async () => {
  await withProxy(async (am, configPath) => {
    const none = /** @type {any} */ (await runCli(configPath, ['steer']));
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, /No steer is set/);

    // The time left is the CLI's own clock against this end, so it is the
    // format that is checked; the end itself is exact.
    const until = Date.now() + 5 * H;
    am.setSteer(1, { until });
    const iso = new Date(until).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const listed = /** @type {any} */ (await runCli(configPath, ['steer']));
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`Anthropic: new conversations go to "bob@example\\.com \\(Acme\\)" — \\d+h(\\d+m)? left \\(until ${iso}\\)`));

    const cleared = /** @type {any} */ (await runCli(configPath, ['steer', '--clear']));
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.match(cleared.stdout, /Steer to "bob@example\.com \(Acme\)" cleared/);
    assert.deepEqual(am.steerList(), []);
    const again = /** @type {any} */ (await runCli(configPath, ['steer', '--clear']));
    assert.match(again.stdout, /No steer was set/);
  });
});

test('steer warns about what keeps it from taking effect, and refuses what it cannot do', async () => {
  await withProxy(async (am, configPath) => {
    const off = /** @type {any} */ (await runCli(configPath, ['steer', 'off@example.com']));
    assert.equal(off.code, 0, 'the steer is still set, so this is not a failure');
    assert.match(off.stderr, /"off@example\.com" is disabled, so new conversations go elsewhere until that changes; the steer stays set/);

    const redeem = /** @type {any} */ (await runCli(configPath, ['steer', 'alice@example.com', '--redeem']));
    assert.equal(redeem.code, 1);
    assert.match(redeem.stderr, /holds no banked reset to redeem/);

    const unknown = /** @type {any} */ (await runCli(configPath, ['steer', 'nobody@example.com']));
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no such account "nobody@example\.com"/);
    assert.match(unknown.stderr, /alice@example\.com/);

    const bad = /** @type {any} */ (await runCli(configPath, ['steer', 'alice@example.com', '--for', 'a while']));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /"for" must be/);

    const usage = /** @type {any} */ (await runCli(configPath, ['steer', '--clear', '--redeem']));
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage: teamclaude steer/);
    assert.deepEqual(am.steerList().map(s => s.target), ['off@example.com'], 'only the first command set anything');
  });
});

// A server predating the endpoint forwards the request upstream, and that
// error is an object: it must not print as [object Object].
test('an old server without the endpoint is reported as one', async () => {
  const oldServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'nope' } }));
  });
  const port = await listen(oldServer);
  try {
    const res = /** @type {any} */ (await runCli(await writeConfig(port), ['steer', 'alice@example.com']));
    assert.equal(res.code, 1);
    assert.doesNotMatch(res.stderr, /\[object Object\]/);
    assert.match(res.stderr, /older server/);
  } finally {
    oldServer.close();
  }
});

test('a down server exits 1 with the same hint as switch', async () => {
  const configPath = await writeConfig(await closedPort());
  for (const cliArgs of [['steer'], ['steer', 'alice@example.com']]) {
    const res = /** @type {any} */ (await runCli(configPath, cliArgs));
    assert.equal(res.code, 1, cliArgs.join(' '));
    assert.match(res.stderr, /Is the server running\?/);
  }
});

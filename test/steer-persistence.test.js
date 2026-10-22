import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnServer, waitForStatus, closedPort } from '../test-helpers/spawn-server.js';

// A steer is an operator's decision that runs for days, so it is kept in the
// state file beside the quota rather than in memory alone. This drives the
// real server as a subprocess through two restarts: one that brings the steer
// back, and one whose saved steer ended while the server was down.

test('a steer survives a restart through the state file, and one that ended while the server was down is dropped', async () => {
  const deadPort = await closedPort();
  const config = () => ({
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${deadPort}`,
    upstreamProxy: false,
    accounts: [
      { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
      { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
    ],
  });
  const first = await spawnServer({ config });
  const statePath = join(first.dir, 'config.state.json');
  /** @type {any} */
  let set;
  try {
    const res = await fetch(`http://127.0.0.1:${first.port}/teamclaude/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ account: 'b@example.com', for: '6h' }),
    });
    assert.equal(res.status, 200);
    set = (await res.json()).steer;
  } finally {
    await first.stop();
  }

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.steers.length, 1);
  assert.equal(state.steers[0].account.name, 'b@example.com');
  assert.equal(state.steers[0].until, set.until);
  assert.equal(JSON.stringify(state.steers).includes('k2'), false, 'no credential in the state file');

  const second = await spawnServer({ config, dir: first.dir });
  try {
    const status = await waitForStatus(second.port, s => s?.server?.pid === second.pid);
    assert.deepEqual(status.steers.map((/** @type {any} */ s) => [s.target, s.until, s.redeem]), [['b@example.com', set.until, false]]);
    assert.match(second.output(), /Restored the steer to "b@example\.com"/);
  } finally {
    await second.stop();
  }

  // The same steer, saved as though its end had passed while nothing ran.
  state.steers[0].until = Date.now() - 1000;
  await writeFile(statePath, JSON.stringify(state));
  const third = await spawnServer({ config, dir: first.dir });
  try {
    const status = await waitForStatus(third.port, s => s?.server?.pid === third.pid);
    assert.deepEqual(status.steers, []);
    assert.match(third.output(), /Steer to "b@example\.com" not restored — it ended while the server was down/);
  } finally {
    await third.stop();
  }
});

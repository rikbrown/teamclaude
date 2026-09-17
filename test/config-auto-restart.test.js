import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../src/config.js';

// Restarting the proxy costs every client its connection, however gracefully it
// is done, so deciding to do it unattended is the operator's call and nobody
// else's. The key has to exist in the defaults for a hand-edited config to have
// something to set — the same reason activityLog is there.
test('the default config exposes autoRestart, and leaves it off', () => {
  const config = createDefaultConfig();
  assert.ok('autoRestart' in config, 'without the key there is nothing for a config to set');
  assert.equal(config.autoRestart, false, 'restarting a running proxy by itself stays opt-in');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../src/config.js';

// Once the TUI is up it replaces console.log (tui.js), so rotation notices,
// upstream errors and 429 failover live in a 200-entry ring buffer and die with
// the process — which is why a proxy fault that has already happened cannot be
// investigated. `--activity-log` could not fix that on its own: a flag lasts one
// launch, and the restart is the case that matters. The key has to be in the
// defaults for a hand-edited config to carry it.
test('the default config exposes activityLog, and leaves it off', () => {
  const config = createDefaultConfig();
  assert.ok('activityLog' in config, 'without the key there is nothing for a config to set');
  assert.equal(config.activityLog, null, 'writing request activity to disk stays opt-in');
});

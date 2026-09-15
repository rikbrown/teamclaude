import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { isLocalUpstream } from '../src/provider.js';

// An account served by a local process (a translating proxy in front of another
// vendor, say) is infrastructure, not a seat the fleet rotates between, so it is
// not drawn as a row at all — it gets a readout line beneath the table instead.
//
// It holds no subscription, it is the only candidate its route has so it never
// rotates, and once its own back leg draws on pooled accounts it has no quota to
// show either. A row of dashes and borrowed numbers, in a table whose whole
// purpose is which account is being spent, is noise. Sorting it last was the
// first half of this thought; this is the rest.
//
// Rendered rather than unit-tested, in the shape tui-name-column.test.js uses —
// what is DRAWN is the property, and only render() decides it.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const LOCAL = { upstream: 'http://127.0.0.1:18765' };

function makeTUI(entries) {
  const am = new AccountManager(entries, 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};
  return { tui, am };
}

/** The manager indices render() actually asked _renderAcct to draw, in order. */
function drawOrder(tui) {
  const drawn = [];
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...args) => { drawn.push(args[0]); return real(...args); };
    tui._paint = () => {};
    tui.running = true;
    delete tui.render; // use the real one for this call
    TUI.prototype.render.call(tui, true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

test('a loopback upstream marks a locally-served account', () => {
  for (const upstream of ['http://127.0.0.1:18765', 'http://localhost:1234', 'http://[::1]:9', 'http://127.5.5.5']) {
    assert.equal(isLocalUpstream({ upstream }), true, upstream);
  }
});

test('a remote third-party backend is not local', () => {
  // The DeepSeek/GLM fallback case: a real upstream, just not Anthropic's.
  assert.equal(isLocalUpstream({ upstream: 'https://api.deepseek.com' }), false);
  assert.equal(isLocalUpstream({ upstream: 'https://open.bigmodel.cn/api/paas/v4' }), false);
  assert.equal(isLocalUpstream({}), false);
  assert.equal(isLocalUpstream(null), false);
  assert.equal(isLocalUpstream({ upstream: 'not a url' }), false);
});

test('a local-upstream account is not drawn as a row', () => {
  const { tui } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL), oauth('claude-b')]);
  assert.deepEqual(drawOrder(tui), [0, 2]);
});

test('it gets a readout line instead, naming where it sends', () => {
  const { tui } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL)]);
  const [line] = tui._conduitLines();
  assert.match(line, /codex/);
  assert.match(line, /127\.0\.0\.1:18765/);
});

test('the readout folds in the supervised process state', () => {
  const { tui } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL)]);
  tui.getSidecars = () => [{ name: 'codex', running: true, pid: 4242, restarts: 0, lastExit: null }];
  assert.match(tui._conduitLines()[0], /pid 4242/);

  // A crash loop is the thing an operator needs from this line, and it used to
  // be visible only in `status --json`.
  tui.getSidecars = () => [{ name: 'codex', running: false, pid: null, restarts: 3, lastExit: 'code 1' }];
  const down = tui._conduitLines()[0];
  assert.match(down, /down \(code 1\)/);
  assert.match(down, /3 restarts/);
});

test('a fleet with no local upstream draws no readout lines', () => {
  const { tui } = makeTUI([oauth('a'), oauth('b')]);
  assert.deepEqual(tui._conduitLines(), []);
});

test('a fleet with no local upstream keeps its list order untouched', () => {
  const { tui } = makeTUI([oauth('a'), oauth('b'), oauth('c')]);
  assert.deepEqual(drawOrder(tui), [0, 1, 2]);
});

test('selection walks the rows as drawn but stores a manager index', () => {
  const { tui, am } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL), oauth('claude-b')]);
  tui.mode = 'select';
  tui.selAction = 'switch';
  tui.selIdx = 0;

  // Down from the first row lands on the second ROW (claude-b, manager index 2):
  // the local account is not a row, so there is nothing to land on between them.
  tui._key('down');
  assert.equal(tui.selIdx, 2);
  assert.equal(am.accounts[tui.selIdx].name, 'claude-b');

  tui._key('down'); // already at the bottom — the conduit is not selectable
  assert.equal(tui.selIdx, 2);

  tui._key('up');
  assert.equal(am.accounts[tui.selIdx].name, 'claude-a');
  tui._key('up'); // already at the top
  assert.equal(tui.selIdx, 0);
});

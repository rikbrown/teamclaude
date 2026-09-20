import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { TUI } from '../src/tui.js';

// The [f] fleet view: one aggregate block per provider pool in place of the
// account rows. Two things are pinned here — that the block says what the
// aggregate says, and that it never runs past the terminal edge, which is the
// failure the account rows were bitten by twice (#228, #234) and which fitLine
// hides by cutting the tail off.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const HOUR = 3600_000;

function oauth(name, over = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, ...over };
}

/** A fleet of mixed tiers and both providers, plus one seat this build cannot
 *  weigh and one disabled seat, so every membership rule is exercised at once. */
function fleetAccounts() {
  return [
    oauth('max20@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('max5@example.com', { rateLimitTier: 'default_claude_max_5x' }),
    oauth('pro@example.com', { rateLimitTier: 'default_claude_ai' }),
    oauth('future@example.com', { rateLimitTier: 'default_heron' }),
    oauth('off@example.com', { rateLimitTier: 'default_claude_max_20x', disabled: true }),
    oauth('gpt@example.com', { provider: 'codex', accountId: 'acct-1' }),
    oauth('gpt2@example.com', { provider: 'codex', accountId: 'acct-2' }),
  ];
}

function withQuota(am) {
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.1 * (i + 1);
    a.quota.unified5hReset = Date.now() + 2 * HOUR;
    a.quota.unified7d = 0.6;
    a.quota.unified7dReset = Date.now() + 3 * 24 * HOUR;
  });
  // Only the Anthropic seats meter a Fable weekly bucket.
  for (const a of am.accounts.slice(0, 3)) {
    a.quota.unified7dFable = 0.9;
    a.quota.unified7dFableReset = Date.now() + 20 * 60_000;
  }
  return am;
}

function tuiFor(am, over = {}) {
  return new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    ...over,
  });
}

/**
 * Render at `width` with the fleet view on, returning the lines _fleetLines
 * actually produced (ANSI stripped) alongside the account rows drawn, if any.
 * Captured at the source rather than off the painted frame: fitLine pads and
 * truncates every line to exactly W, so an overflow is invisible afterwards.
 */
function renderFleet(tui, width) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const fleet = [];
  const accountRows = [];
  const realFleet = tui._fleetLines.bind(tui);
  const realRow = tui._renderAcct.bind(tui);
  tui._fleetLines = (...args) => { const out = realFleet(...args); fleet.push(...out.map(strip)); return out; };
  tui._renderAcct = (...args) => { const out = realRow(...args); accountRows.push(strip(out)); return out; };
  tui._paint = () => {};
  tui.running = true;
  try { tui.render({ force: true }); } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return { fleet, accountRows };
}

// The widths worth pinning: the narrowest the dashboard draws at all, the
// single-bar row cutoff, a half screen, and wide.
const WIDTHS = [40, 46, 60, 70, 80, 100, 120, 200];

test('[f] swaps the account rows for the fleet block and back', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  assert.equal(renderFleet(tui, 100).fleet.length, 0, 'rows by default');

  tui._key('f');
  const on = renderFleet(tui, 100);
  assert.equal(on.accountRows.length, 0, 'the rows give way to the block');
  assert.ok(on.fleet.some(l => l.includes('Fleet — Anthropic')));

  tui._key('f');
  assert.ok(renderFleet(tui, 100).accountRows.length > 0, 'and back again');
});

test('[f] works in attach mode, where every other view key is off', () => {
  // The toggle sits above the attach-mode cutoff in _keyNormal on purpose: the
  // block is composed from the account list the dashboard already holds, so
  // nothing about it is the local process's to own.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)), { remote: true });
  tui._key('f');
  assert.equal(tui.fleetView, true);
  assert.ok(renderFleet(tui, 100).fleet.some(l => l.includes('Fleet — Anthropic')));
});

test('the footer offers the key on both dashboards', () => {
  const am = new AccountManager(fleetAccounts(), 0.98);
  assert.match(strip(tuiFor(am)._footerHints()), /fleet/);
  assert.match(strip(tuiFor(am, { remote: true })._footerHints()), /fleet/);
});

test('the two pools get a block each and never share a bar', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui.fleetView = true;
  const { fleet } = renderFleet(tui, 120);

  const anthropic = fleet.indexOf(fleet.find(l => l.includes('Fleet — Anthropic')));
  const codex = fleet.indexOf(fleet.find(l => l.includes('Fleet — Codex')));
  assert.ok(anthropic >= 0 && codex > anthropic, 'Anthropic first, Codex after');

  // Anthropic's three counted seats are 90% through their Fable bucket; Codex
  // has no such bucket at all and must not have acquired one.
  const anthropicLines = fleet.slice(anthropic, codex);
  const codexLines = fleet.slice(codex);
  assert.ok(anthropicLines.some(l => l.trimStart().startsWith('F7')));
  assert.ok(!codexLines.some(l => l.trimStart().startsWith('F7')));
  assert.deepEqual(codexLines.slice(1).map(l => l.trim().split(' ')[0]), ['Ses', 'Wk']);
});

test('the tally names the seats left out, and stays quiet when none are', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui.fleetView = true;
  const { fleet } = renderFleet(tui, 120);

  // Five Anthropic accounts: one disabled (out of the fleet entirely) and one on
  // a tier this build cannot price (out of the figures, still in the tally).
  assert.ok(fleet.some(l => l.includes('Fleet — Anthropic') && l.includes('4 seats · 3 counted')), fleet[0]);
  // Both Codex seats count, so "2 of 2" is left unsaid.
  const codex = fleet.find(l => l.includes('Fleet — Codex'));
  assert.ok(codex.includes('2 seats') && !codex.includes('counted'), codex);
});

test('the bar reports the weighted pool, not any one seat', () => {
  const am = new AccountManager([
    oauth('max20@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('pro@example.com', { rateLimitTier: 'default_claude_ai' }),
  ], 1);
  am.accounts[0].quota.unified7d = 0.5;
  am.accounts[0].quota.unified7dReset = Date.now() + 3 * 24 * HOUR;
  am.accounts[1].quota.unified7d = 0;
  am.accounts[1].quota.unified7dReset = Date.now() + 3 * 24 * HOUR;

  const tui = tuiFor(am);
  tui.fleetView = true;
  const weekly = renderFleet(tui, 120).fleet.find(l => l.trimStart().startsWith('Wk'));
  // 20 × 0.5 of 21 spendable — nowhere near the 25% a plain mean would report.
  assert.match(weekly, /48%/);
});

test('a pool with no seat it can weigh says so instead of drawing empty bars', () => {
  const am = new AccountManager([
    oauth('future@example.com', { rateLimitTier: 'default_heron' }),
    { name: 'key', type: 'apikey', apiKey: 'sk-test' },
  ], 0.98);
  am.accounts[0].quota.unified5h = 0.4;
  const tui = tuiFor(am);
  tui.fleetView = true;
  const { fleet } = renderFleet(tui, 100);

  assert.ok(fleet.some(l => l.includes('2 seats · 0 counted')), fleet.join('\n'));
  assert.ok(fleet.some(l => l.includes('no seat here has a tier')), fleet.join('\n'));
  assert.ok(!fleet.some(l => l.trimStart().startsWith('Ses')), 'no bar is drawn for nothing');
});

test('a pool with no quota observed yet draws no bars either', () => {
  const am = new AccountManager([oauth('pro@example.com', { rateLimitTier: 'default_claude_ai' })], 0.98);
  const tui = tuiFor(am);
  tui.fleetView = true;
  const { fleet } = renderFleet(tui, 100);
  assert.ok(fleet.some(l => l.includes('no quota observed yet')), fleet.join('\n'));
});

test('no fleet line overflows the terminal, at any width the dashboard draws', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui.fleetView = true;
  for (const w of WIDTHS) {
    const { fleet } = renderFleet(tui, w);
    assert.ok(fleet.length > 0, `W=${w}: nothing drawn`);
    const widest = Math.max(...fleet.map(l => l.length));
    assert.ok(widest <= w, `W=${w}: widest fleet line is ${widest} columns`);
  }
});

test('a burn tag is budgeted for rather than pushed past the edge', () => {
  // The tag is the one part of the line whose width is not fixed, and it is what
  // #228 lost when a row was composed past W. Seed a steady burn so every bucket
  // carries one, then check the same invariant at every width.
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98));
  const now = Date.now();
  for (let i = 0; i <= 20; i++) {
    for (const a of am.accounts) {
      a.quota.unified5h = 0.30 + 0.01 * i;
      a.quota.unified7d = 0.40 + 0.005 * i;
    }
    am._recordFleetSamples(now - (20 - i) * 60_000);
  }
  const tui = tuiFor(am);
  tui.fleetView = true;

  const tagged = renderFleet(tui, 120).fleet.filter(l => /TTL|unspent/.test(l));
  assert.ok(tagged.length > 0, 'the seeded burn should produce a tag');
  // The line already names the bucket, so the tag does not repeat it.
  assert.ok(!tagged.some(l => /(Ses|Wk|S7|F7) TTL/.test(l)), tagged.join('\n'));

  for (const w of WIDTHS) {
    const { fleet } = renderFleet(tui, w);
    const widest = Math.max(...fleet.map(l => l.length));
    assert.ok(widest <= w, `W=${w}: widest fleet line is ${widest} columns`);
  }
});

test('the sidecar readout is drawn under the fleet block as well as under the rows', () => {
  const am = withQuota(new AccountManager([
    ...fleetAccounts(),
    oauth('kimi', { upstream: 'http://127.0.0.1:8317' }),
  ], 0.98));
  const tui = tuiFor(am);
  const hasConduit = () => {
    const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    try { return tui._conduitLines().length; } finally { if (cols) Object.defineProperty(process.stdout, 'columns', cols); }
  };
  assert.equal(hasConduit(), 1);
  tui.fleetView = true;
  const { fleet } = renderFleet(tui, 100);
  assert.ok(fleet.length > 0);
  assert.equal(hasConduit(), 1, 'a local backend is infrastructure, shown either way');
});

// ── Attach mode ─────────────────────────────────────────────────────────────

/** The account shape /teamclaude/status publishes, including the resolved tier
 *  the attached dashboard needs in order to weigh anything at all. */
function remoteAccount(name, tier, over = {}) {
  return {
    name, type: 'oauth', provider: 'anthropic', orgName: null, priority: 0,
    disabled: false, maxUsage: null, status: 'active', sessions: 0,
    tier: { rateLimitTier: null, seatTier: null, weight: tier },
    quota: { unified7d: 0.5, unified7dReset: Date.now() + 3 * 24 * HOUR },
    usage: { totalRequests: 0 }, rateLimitedUntil: null, pausedUntil: null,
    ...over,
  };
}

test('an attached dashboard weighs seats from the tier on the wire', () => {
  const am = new RemoteAccountManager();
  am.applyStatus({
    currentAccount: 'big', switchThreshold: 1,
    accounts: [
      remoteAccount('big', 20),
      remoteAccount('small', 1, { quota: { unified7d: 0, unified7dReset: Date.now() + 3 * 24 * HOUR } }),
    ],
  });
  const tui = tuiFor(am, { remote: true });
  tui.fleetView = true;
  const weekly = renderFleet(tui, 120).fleet.find(l => l.trimStart().startsWith('Wk'));
  // Same 20-of-21 arithmetic the local dashboard does: the two must not disagree.
  assert.match(weekly, /48%/);
});

test('an attached dashboard samples the fleet series once per poll', () => {
  const am = new RemoteAccountManager();
  const status = used => ({
    switchThreshold: 1,
    accounts: [remoteAccount('one', 1, { quota: { unified7d: used, unified7dReset: Date.now() + 3 * 24 * HOUR } })],
  });
  for (let i = 0; i <= 10; i++) am.applyStatus(status(0.10 + 0.01 * i));
  assert.ok(am.projection.samples.has('fleet:anthropic:unified7d'));
});

test('an attached dashboard keeps the server\'s projection switch', () => {
  const am = new RemoteAccountManager();
  am.applyStatus({ projection: { enabled: false }, accounts: [remoteAccount('one', 1)] });
  // With it off on the server the rows carry no tags, so a fleet tag would be
  // the one burn figure on the screen this dashboard had invented for itself.
  assert.equal(am.projection.enabled, false);
  am.applyStatus({ projection: { enabled: true }, accounts: [remoteAccount('one', 1)] });
  assert.equal(am.projection.enabled, true);
});

test('a selection brings the rows back for as long as it is open', () => {
  // The account table is the selection UI, so [s] from the fleet view has to
  // show something to move a cursor through.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui._key('f');
  tui._key('s');
  assert.equal(tui.mode, 'select');
  const during = renderFleet(tui, 100);
  assert.ok(during.accountRows.length > 0, 'the rows are drawn under the selection');
  assert.equal(during.fleet.length, 0);

  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.ok(renderFleet(tui, 100).fleet.length > 0, 'and the block comes back after it');
});

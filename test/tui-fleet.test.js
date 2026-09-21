import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { TUI } from '../src/tui.js';

// The [f] fleet view: one aggregate block per provider pool, beside the account
// rows ('split', the default), in place of them ('full'), or nowhere ('off').
// Three things are pinned here — that the block says what the aggregate says,
// that the split never costs the rows the width they were composed for, and
// that neither side ever runs past the terminal edge, which is the failure the
// account rows were bitten by twice (#228, #234) and which fitLine hides by
// cutting the tail off.

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
 * Render at `width`, returning the lines each half produced (ANSI stripped)
 * alongside the frame that was actually painted.
 *
 * The halves are captured at the source, because fitLine pads and truncates
 * every line to exactly W and an overflow is invisible afterwards. The frame is
 * captured too, because it is the only place the two halves are seen merged —
 * and a merge that overran would show up there as a panel line whose tail has
 * been eaten.
 */
function renderFleet(tui, width) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const fleet = [];
  const accountRows = [];
  let frame = [];
  const realFleet = tui._fleetLines.bind(tui);
  const realRow = tui._renderAcct.bind(tui);
  tui._fleetLines = (...args) => { const out = realFleet(...args); fleet.push(...out.map(strip)); return out; };
  tui._renderAcct = (...args) => { const out = realRow(...args); accountRows.push(strip(out)); return out; };
  tui._paint = buf => { frame = strip(buf).replace(/\x1b\[[?0-9]*[A-Za-z]/g, '').split('\r\n'); };
  tui.running = true;
  try { tui.render({ force: true }); } finally {
    tui._fleetLines = realFleet;
    tui._renderAcct = realRow;
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return { fleet, accountRows, frame };
}

/** The account-pane geometry the dashboard would use at `width`. */
const layout = (tui, width) => tui._splitLayout(width, tui.am.getRoutes());

// The widths worth pinning: the narrowest the dashboard draws at all, the
// single-bar row cutoff, a half screen, and wide.
const WIDTHS = [40, 46, 60, 70, 80, 100, 120, 200];

test('a fleet line carries a TTL estimate once the pool has a burn rate', () => {
  // The panel reported nothing on a healthy fleet: `project` warns rather than
  // estimates, so a 5h bucket inside its window and a weekly one under the
  // waste floor both printed blank. The fleet lines estimate instead.
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98));
  const now = Date.now();
  for (let m = 120; m >= 0; m -= 5) {
    for (const a of am.accounts) {
      if (a.quota.unified5h != null) a.quota.unified5h = Math.max(0, a.quota.unified5h - 0.0002 * m);
      if (a.quota.unified7d != null) a.quota.unified7d = Math.max(0, 0.6 - 0.0004 * m);
    }
    am._recordFleetSamples(now - m * 60_000);
  }
  for (const a of am.accounts) if (a.quota.unified7d != null) a.quota.unified7d = 0.6;

  const { fleet } = renderFleet(tuiFor(am), 200);
  const ttl = fleet.filter(l => /TTL /.test(l));
  assert.ok(ttl.length > 0, `expected a TTL on some fleet line, got:\n${fleet.join('\n')}`);
  assert.ok(ttl.some(l => /\bWk\b/.test(l)), 'the shared weekly line should carry one');
});

test('[f] cycles split → full → off → split', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  assert.equal(tui.fleetMode, 'split', 'the split is the default');
  tui._key('f');
  assert.equal(tui.fleetMode, 'full');
  tui._key('f');
  assert.equal(tui.fleetMode, 'off');
  tui._key('f');
  assert.equal(tui.fleetMode, 'split');
});

test('each state draws what it says it draws', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));

  const split = renderFleet(tui, 140);
  assert.ok(split.accountRows.length > 0, 'split keeps the rows');
  assert.ok(split.fleet.some(l => l.includes('Fleet — Anthropic')), 'split draws the panel');

  tui.fleetMode = 'full';
  const full = renderFleet(tui, 140);
  assert.equal(full.accountRows.length, 0, 'full gives the rows up to the block');
  assert.ok(full.fleet.some(l => l.includes('Fleet — Anthropic')));

  tui.fleetMode = 'off';
  const off = renderFleet(tui, 140);
  assert.ok(off.accountRows.length > 0);
  assert.equal(off.fleet.length, 0, 'off draws no block at all');
});

test('a terminal too narrow for a panel falls back to the rows, never to the block alone', () => {
  // Defaulting a narrow terminal to the aggregates would open the dashboard on
  // a screen with no accounts in it, which is a poor first impression of an
  // account dashboard.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  const { panelW } = layout(tui, 80);
  assert.equal(panelW, 0, '80 columns is under the split threshold');
  const narrow = renderFleet(tui, 80);
  assert.equal(narrow.fleet.length, 0);
  assert.ok(narrow.accountRows.length > 0);
});

test('the rows genuinely narrow when the panel appears', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  const W = 160;
  const { panelW, leftW } = layout(tui, W);
  assert.ok(panelW > 0, 'the fixture splits at 160 columns');
  assert.ok(leftW < W, 'the rows gave up the panel and the gutter');

  const split = renderFleet(tui, W);
  const widestRow = Math.max(...split.accountRows.map(l => l.length));
  assert.ok(widestRow <= leftW, `a row ran to ${widestRow} of ${leftW} columns`);

  // And the same rows, composed for the whole line, are wider: the budget
  // followed the column rather than the terminal.
  tui.fleetMode = 'off';
  const whole = renderFleet(tui, W);
  assert.ok(Math.max(...whole.accountRows.map(l => l.length)) > widestRow,
    'the rows were laid out against the same width either way');
});

test('the split never costs the rows a bar they would otherwise draw', () => {
  // The panel appears only once the rows can still afford every bar at BAR_MIN,
  // so a table that crosses the threshold keeps its shape. A row squeezed to a
  // single bar to make room for an aggregate has lost what it is read for.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  for (const w of [100, 110, 120, 140, 200]) {
    const { panelW } = layout(tui, w);
    if (!panelW) continue;
    const { accountRows } = renderFleet(tui, w);
    assert.ok(accountRows.every(r => r.includes(' Wk ')), `W=${w}: the weekly bar went`);
    assert.ok(accountRows.some(r => r.includes('F7')), `W=${w}: the family bar went`);
  }
});

test('no composed line runs past the terminal in the split view', () => {
  // The merge is where a width mistake hides: fitLine pads and truncates the
  // painted line, so an overrun shows up as a panel line whose tail was eaten
  // rather than as a line that is too long. Both halves are checked against
  // their own column, and then the frame is checked for the panel's own text.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  const threshold = [...Array(200).keys()].find(w => layout(tui, w).panelW > 0);
  assert.ok(threshold > 0, 'the fixture splits somewhere');

  for (const w of [...WIDTHS, threshold - 1, threshold, threshold + 1, threshold + 7]) {
    const { panelW, leftW } = layout(tui, w);
    const { fleet, accountRows, frame } = renderFleet(tui, w);
    assert.ok(frame.every(l => l.length === w), `W=${w}: the frame is not square`);
    if (!panelW) {
      assert.equal(fleet.length, 0, `W=${w}: a panel below the threshold`);
      continue;
    }
    assert.ok(leftW + 2 + panelW === w, `W=${w}: the two columns and the gutter are not the line`);
    for (const l of accountRows) assert.ok(l.length <= leftW, `W=${w}: row of ${l.length} in ${leftW} columns`);
    for (const l of fleet) assert.ok(l.length <= panelW, `W=${w}: panel line of ${l.length} in ${panelW} columns`);
    // The panel's text survives the merge whole — the check the width
    // arithmetic above cannot make, because a line composed past W is cut
    // silently and looks exactly like a line that fitted.
    for (const l of fleet) {
      if (!l.trim()) continue;
      assert.ok(frame.some(f => f.trimEnd().endsWith(l.trimEnd())), `W=${w}: panel line lost its tail: ${l}`);
    }
  }
});

test('the left column cannot bleed its colour under the panel', () => {
  // A row ends inside a coloured bar. truncate closes it with a RESET on the
  // way into the merge, so the panel beside it is drawn in its own colours.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 160, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  let buf = '';
  tui._paint = b => { buf = b; };
  tui.running = true;
  try { tui.render({ force: true }); } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  const { leftW } = layout(tui, 160);
  const line = buf.split('\r\n').find(l => strip(l).includes('Fleet — Anthropic'));
  assert.ok(line, 'the panel was drawn');
  // Everything up to the gutter, and the last escape in it: a bar left open
  // would leave a background colour as the last thing said before the panel.
  let width = 0;
  let cut = 0;
  for (let i = 0; i < line.length; i++) {
    const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (m) { i += m[0].length - 1; continue; }
    if (width === leftW) { cut = i; break; }
    width++;
  }
  const escapes = strip(line.slice(0, cut)).length === 0 ? [] : line.slice(0, cut).match(/\x1b\[[0-9;]*m/g) || [];
  assert.equal(escapes[escapes.length - 1], '\x1b[0m', 'the left column handed the panel an open colour');
});

test('the sidecar readout stays under the rows, on the left', () => {
  const am = withQuota(new AccountManager([
    ...fleetAccounts(),
    oauth('kimi', { upstream: 'http://127.0.0.1:8317' }),
  ], 0.98));
  const tui = tuiFor(am);
  const { frame } = renderFleet(tui, 160);
  const { leftW } = layout(tui, 160);
  const conduit = frame.find(l => l.includes('kimi') && l.includes('8317'));
  assert.ok(conduit, 'the local backend has its readout');
  // It starts in the left column, and the panel line it shares the row with
  // starts after the gutter — infrastructure under the seats, not under the
  // pool aggregates it is deliberately absent from.
  assert.ok(conduit.indexOf('kimi') < leftW, 'the readout drifted into the panel');
});

test('[f] works in attach mode, where every other view key is off', () => {
  // The cycle sits above the attach-mode cutoff in _keyNormal on purpose: the
  // block is composed from the account list the dashboard already holds, so
  // nothing about it is the local process's to own.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)), { remote: true });
  tui._key('f');
  assert.equal(tui.fleetMode, 'full');
  assert.ok(renderFleet(tui, 100).fleet.some(l => l.includes('Fleet — Anthropic')));
});

test('the footer offers the key on both dashboards', () => {
  const am = new AccountManager(fleetAccounts(), 0.98);
  for (const tui of [tuiFor(am), tuiFor(am, { remote: true })]) {
    assert.match(strip(tui._footerHints()), /fleet/);
    // And says nothing about which of the three states it is in: those columns
    // are the build label's at 80 columns, and the screen already shows it.
    tui.fleetMode = 'off';
    assert.doesNotMatch(strip(tui._footerHints()), /fleet (split|full|off)/);
  }
});

test('the two pools get a block each and never share a bar', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 120);

  const anthropic = fleet.indexOf(fleet.find(l => l.includes('Fleet — Anthropic')));
  const codex = fleet.indexOf(fleet.find(l => l.includes('Fleet — Codex')));
  assert.ok(anthropic >= 0 && codex > anthropic, 'Anthropic first, Codex after');

  // Anthropic's three counted seats are 90% through their Fable bucket; Codex
  // has no such bucket at all and must not have acquired one.
  const anthropicLines = fleet.slice(anthropic, codex);
  const codexLines = fleet.slice(codex, fleet.indexOf(''));
  assert.ok(anthropicLines.some(l => l.trimStart().startsWith('F7')));
  assert.ok(!codexLines.some(l => l.trimStart().startsWith('F7')));
  assert.deepEqual(codexLines.slice(1).map(l => l.trim().split(' ')[0]), ['Ses', 'Wk']);
});

test('the tally names the seats left out, and stays quiet when none are', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 120);

  // Five Anthropic accounts: one disabled (out of the fleet entirely) and one on
  // a tier this build cannot price (out of the figures, still in the tally).
  assert.ok(fleet.some(l => l.includes('Fleet — Anthropic') && l.includes('4 seats · 3 counted')), fleet[0]);
  // Both Codex seats count, so "2 of 2" is left unsaid.
  const codex = fleet.find(l => l.includes('Fleet — Codex'));
  assert.ok(codex.includes('2 seats') && !codex.includes('counted'), codex);
});

test('a seat no route reaches is out of the figures and still in the tally', () => {
  // The dashboard's half of the rule quota-summary.test.js pins. Both routes
  // name their accounts, and one of them covers the Fable models — otherwise
  // getRoutes() adds an auto route for that family, which lists nobody and so
  // resolves to every Anthropic seat (see the test below).
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98, {
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['max20@example.com'] },
      { name: 'bulk', match: ['claude-haiku-*'], accounts: ['max5@example.com'] },
    ],
  }));
  const tui = tuiFor(am);
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 120);
  // pro@ and future@ are in no route; future@ was never counted anyway.
  assert.ok(fleet.some(l => l.includes('Fleet — Anthropic') && l.includes('4 seats · 2 counted')),
    fleet.join('\n'));
  // The Codex pool is named by no route at all, so routing says nothing about
  // it and both its seats still count.
  assert.ok(fleet.some(l => l.includes('Fleet — Codex') && l.includes('2 seats') && !l.includes('counted')),
    fleet.join('\n'));
});

test('an auto-created family route reaches every seat, and the tally says so', () => {
  // A fleet that meters a Fable weekly bucket with no configured route for it
  // gets an ephemeral one that lists no accounts — which resolves to the whole
  // Anthropic pool, because that is exactly what happens to the traffic. So the
  // routing rule takes nothing out here, even though a named route reaches two
  // seats: the third is reachable, just not by that route.
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98, {
    routes: [{ name: 'bulk', match: ['claude-haiku-*'], accounts: ['max20@example.com'] }],
  }));
  assert.ok(am.getRoutes().some(r => r.autocreated), 'the fixture produces an auto route');
  const tui = tuiFor(am);
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 120);
  assert.ok(fleet.some(l => l.includes('Fleet — Anthropic') && l.includes('4 seats · 3 counted')),
    fleet.join('\n'));
});

test('the route readout names the bucket that stops each route first', () => {
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98, {
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['max20@example.com'] },
      { name: 'bulk', match: ['claude-haiku-*'], accounts: ['max20@example.com'] },
    ],
  }));
  const tui = tuiFor(am);
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 120);

  assert.ok(fleet.some(l => l.includes('Routes')), fleet.join('\n'));
  // The Fable route's own weekly bucket is 90% spent against a 98% ceiling; the
  // shared weekly is 60%. F7 is what will stop it.
  const fable = fleet.find(l => l.trimStart().startsWith('fable'));
  assert.match(fable, /F7\s+9\d%/, fable);
  // The general route has no family bucket, so the shared weekly binds.
  const bulk = fleet.find(l => l.trimStart().startsWith('bulk'));
  assert.match(bulk, /Wk\s+6\d%/, bulk);
});

test('a route with nothing countable says so, and still fits the panel', () => {
  // The prose lines are the ones with no bar to be budgeted against, so they
  // are also the ones that run off the end of a narrow panel if nobody fits
  // them. This route's only member is on a tier this build cannot weigh.
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98, {
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['max20@example.com'] },
      { name: 'unweighable-route', match: ['claude-haiku-*'], accounts: ['future@example.com'] },
    ],
  }));
  const tui = tuiFor(am);
  tui.fleetMode = 'full';
  assert.ok(renderFleet(tui, 120).fleet.some(l => l.includes('no counted seat')));

  tui.fleetMode = 'split';
  for (const w of [...WIDTHS, 97, 110, 150]) {
    const { panelW } = layout(tui, w);
    const { fleet } = renderFleet(tui, w);
    if (!panelW) continue;
    const widest = Math.max(...fleet.map(l => l.length));
    assert.ok(widest <= panelW, `W=${w}: panel line of ${widest} in ${panelW} columns`);
  }
});

test('the route readout is drawn in the panel too', () => {
  const am = withQuota(new AccountManager(fleetAccounts(), 0.98, {
    routes: [{ name: 'bulk', match: ['claude-haiku-*'], accounts: ['max20@example.com'] }],
  }));
  const tui = tuiFor(am);
  const { fleet } = renderFleet(tui, 160);
  assert.ok(fleet.some(l => l.includes('Routes')), fleet.join('\n'));
  assert.ok(fleet.some(l => l.trimStart().startsWith('bulk')), fleet.join('\n'));
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
  tui.fleetMode = 'full';
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
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 100);

  assert.ok(fleet.some(l => l.includes('2 seats · 0 counted')), fleet.join('\n'));
  assert.ok(fleet.some(l => l.includes('no seat here counts')), fleet.join('\n'));
  assert.ok(!fleet.some(l => l.trimStart().startsWith('Ses')), 'no bar is drawn for nothing');
});

test('a pool with no quota observed yet draws no bars either', () => {
  const am = new AccountManager([oauth('pro@example.com', { rateLimitTier: 'default_claude_ai' })], 0.98);
  const tui = tuiFor(am);
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 100);
  assert.ok(fleet.some(l => l.includes('no quota observed yet')), fleet.join('\n'));
});

test('no fleet line overflows its column, at any width the dashboard draws', () => {
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  for (const mode of ['full', 'split']) {
    tui.fleetMode = mode;
    for (const w of WIDTHS) {
      const room = mode === 'full' ? w : layout(tui, w).panelW;
      const { fleet } = renderFleet(tui, w);
      if (!room) { assert.equal(fleet.length, 0); continue; }
      assert.ok(fleet.length > 0, `${mode} W=${w}: nothing drawn`);
      const widest = Math.max(...fleet.map(l => l.length));
      assert.ok(widest <= room, `${mode} W=${w}: widest fleet line is ${widest} of ${room} columns`);
    }
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
  tui.fleetMode = 'full';

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
  tui.fleetMode = 'full';
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
  tui.fleetMode = 'full';
  const weekly = renderFleet(tui, 120).fleet.find(l => l.trimStart().startsWith('Wk'));
  // Same 20-of-21 arithmetic the local dashboard does: the two must not disagree.
  assert.match(weekly, /48%/);
});

test('an attached dashboard leaves out the seats the server routes nothing to', () => {
  // The routing table comes off the payload with its membership already
  // resolved, so the attached dashboard draws the same pool the server does.
  const am = new RemoteAccountManager();
  am.applyStatus({
    switchThreshold: 1,
    accounts: [remoteAccount('big', 20), remoteAccount('idle', 20)],
    routes: [{ name: 'bulk', match: ['claude-haiku-*'], accounts: [{ name: 'big', provider: 'anthropic', eligible: true }] }],
  });
  const tui = tuiFor(am, { remote: true });
  tui.fleetMode = 'full';
  const { fleet } = renderFleet(tui, 120);
  assert.ok(fleet.some(l => l.includes('2 seats · 1 counted')), fleet.join('\n'));
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
  // The account table is the selection UI, so [s] from the full-width block has
  // to show something to move a cursor through. It falls back to the split
  // rather than to the rows alone — the panel is beside the cursor, not in its
  // way — and to the rows alone when the terminal cannot carry a panel.
  const tui = tuiFor(withQuota(new AccountManager(fleetAccounts(), 0.98)));
  tui.fleetMode = 'full';
  tui._key('s');
  assert.equal(tui.mode, 'select');

  const wide = renderFleet(tui, 160);
  assert.ok(wide.accountRows.length > 0, 'the rows are drawn under the selection');
  assert.ok(wide.fleet.length > 0, 'and the panel stays beside them');

  const narrow = renderFleet(tui, 80);
  assert.ok(narrow.accountRows.length > 0);
  assert.equal(narrow.fleet.length, 0, 'no room for a panel, so the rows have it all');

  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.equal(renderFleet(tui, 160).accountRows.length, 0, 'and the full block comes back after it');
});

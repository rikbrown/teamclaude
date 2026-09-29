import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth, fitHeadLabel } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// The bottom-right corner of the footer is where the build is named — and,
// since the header stopped carrying a copy of it, the only place. The marker
// that says an update is waiting for that build is down here with it.
//
// It is the harder of the two places to put one. The line is composed per mode,
// the hints it carries are the only thing on screen saying what the keyboard
// does, and the paint loop both pads short lines and truncates long ones. So
// every case below is one of three assertions: the line is exactly the terminal
// width, the label is against the right edge, and the hints came through
// untouched.

function fakeAm(sessions = 0) {
  return {
    accounts: [], currentIndex: -1, switchThreshold: 0.98,
    getRoutes: () => [],
    sessionStats: () => ({ active: sessions, known: sessions }),
    refreshExpiredQuotas: () => {},
    thresholdFor: () => 0.98,
  };
}

function makeTUI({ am = fakeAm(), ...opts } = {}) {
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: null,
    ...opts,
  });
}

const stripSgr = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const cursorCodes = /\x1b\[H|\x1b\[\?25[hl]/g;

/** One full frame at a given width, ANSI stripped, as an array of lines. */
function frame(tui, W) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: W, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let painted = '';
  try {
    tui._paint = buf => { painted = buf; };
    tui.running = true;
    tui.render({ force: true });
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return stripSgr(painted).replace(cursorCodes, '').split('\r\n');
}

/** The footer as the paint loop writes it — through fitLine, which is the half
 *  that pads and truncates and so the half a naive append would lose to. */
const painted = (tui, W) => frame(tui, W).at(-1);

/** The footer as the mode composes it, before the frame is assembled. */
const composed = (tui, W) => stripSgr(tui._renderFooter(W));

/** What the footer put in its right-hand corner: the one or two tokens on a
 *  line that ends one column short of the edge — the build label, and the
 *  update marker after it when there is one. '' when it drew nothing there: a
 *  line padded out by fitLine ends in a run of spaces and matches nothing.
 *
 *  At most one single space inside the capture, on purpose. Key hints are two
 *  or more spaces apart, and so is the padding run that holds this corner, so
 *  a looser pattern would reach back and swallow the tail of the hints. */
const cornerOf = line => /\s{2,}(\S+(?: \S+)?) $/.exec(line)?.[1] ?? '';

/** Just the build from that corner, with any update marker taken off. */
const labelOf = line => cornerOf(line).replace(/ ▲$/, '');

const LABEL = '1.1.20-rik.12+acc19b3';   // a checkout: version + build sha
const BARE = '1.1.20-rik.12';            // the same label with its sha spent
const GAP = 2;                           // FOOT_GAP in tui.js

const WIDTHS = [40, 44, 50, 60, 66, 72, 80, 100, 120, 200];

// Every screen the footer is composed for, including the ones that only differ
// by a flag. A mode reached by setting fields rather than by pressing the keys
// that lead to it: the footer reads that state, it does not maintain it.
const SCREENS = [
  ['normal', () => {}],
  ['normal, with an update to take', t => { t.onRestart = () => {}; }],
  ['normal, attached', t => { t.remote = true; }],
  ['settings', t => { t.mode = 'settings'; }],
  ['routes', t => { t.mode = 'routes'; }],
  ['pick', t => { t.mode = 'pick'; t.pick = { multi: false }; }],
  ['pick, multi', t => { t.mode = 'pick'; t.pick = { multi: true }; }],
  ['blocklist', t => { t.mode = 'blocklist'; }],
  ['select, switch', t => { t.mode = 'select'; t.selAction = 'switch'; }],
  ['select, switch onto a route', t => {
    t.mode = 'select'; t.selAction = 'switch'; t.selRoute = { name: 'alpha', color: 'cyan' };
  }],
  ['select, switch attached', t => { t.mode = 'select'; t.selAction = 'switch'; t.remote = true; }],
  ['select, toggle', t => { t.mode = 'select'; t.selAction = 'toggle'; }],
  ['select, remove', t => { t.mode = 'select'; t.selAction = 'remove'; }],
  ['select, reorder', t => { t.mode = 'select'; t.selAction = 'reorder'; }],
  ['add', t => { t.mode = 'add'; }],
  ['input', t => {
    t.mode = 'input'; t.inputPrompt = 'Switch threshold (%)'; t.inputBuf = '95'; t.inputSecret = false;
  }],
  ['a mode with nothing to say', t => { t.mode = 'no-such-mode'; }],
];

/** The same screen twice: once on a build that names itself, once on one that
 *  does not. Every assertion here is about the difference between the two. */
const pair = (apply, W, { versionLabel = LABEL } = {}) => {
  const withLabel = makeTUI({ versionLabel });
  const without = makeTUI({});
  apply(withLabel); apply(without);
  return [composed(withLabel, W), composed(without, W)];
};

// ── the line still adds up ───────────────────────────────────

test('a footer that names the build is exactly the terminal width', () => {
  for (const [name, apply] of SCREENS) {
    for (const W of WIDTHS) {
      const [line] = pair(apply, W);
      if (!labelOf(line)) continue;   // too narrow to name it — its own test below
      assert.equal(displayWidth(line), W,
        `${name} at W=${W}: composed ${displayWidth(line)} columns, so fitLine will pad or cut it`);
    }
  }
});

test('and the footer the paint loop writes is exactly the width too', () => {
  for (const mode of ['normal', 'settings', 'input']) {
    for (const W of WIDTHS) {
      const tui = makeTUI({ versionLabel: LABEL, onRestart: () => {} });
      tui.mode = mode;
      if (mode === 'input') { tui.inputPrompt = 'Threshold (%)'; tui.inputBuf = '95'; }
      const line = painted(tui, W);
      assert.equal(displayWidth(line), W, `mode ${mode} at W=${W}: footer width ${displayWidth(line)}`);
    }
  }
});

test('the build is flush against the right edge, one column of margin', () => {
  for (const W of [80, 100, 120, 200]) {
    const line = painted(makeTUI({ versionLabel: LABEL, onRestart: () => {} }), W);
    assert.ok(labelOf(line), `W=${W}: nothing in the corner at all`);
    // One trailing column and no more: the margin the rule above this line and
    // the header's port block both leave. Two would mean fitLine had padded a
    // short line and pushed the label out of the corner it was put in.
    assert.ok(line.endsWith(' ') && !line.endsWith('  '),
      `W=${W}: the corner reads ${JSON.stringify(line.slice(-28))}`);
  }
  const wide = painted(makeTUI({ versionLabel: LABEL, onRestart: () => {} }), 120);
  assert.ok(wide.endsWith(`${LABEL} `), `the whole label, sha and all: ${JSON.stringify(wide.slice(-28))}`);
});

// ── the hints win ────────────────────────────────────────────
//
// The label is a note in the corner. The hints are the only thing on this line
// that says what the keyboard does, and a key the operator cannot read costs
// them the screen — so nothing about naming the build may touch them.

test('the key hints are never cut to make room for the build', () => {
  for (const [name, apply] of SCREENS) {
    for (const W of WIDTHS) {
      const [line, hints] = pair(apply, W);
      assert.ok(line.startsWith(hints),
        `${name} at W=${W}: hints came back as ${JSON.stringify(line.slice(0, hints.length))}`);
    }
  }
});

test('a terminal too narrow for the hints alone is left exactly as it was', () => {
  // The normal-mode hints run past 40 columns on their own; fitLine has cut
  // their tail since long before there was a version to put there.
  const [line, hints] = pair(t => { t.onRestart = () => {}; }, 40);
  assert.ok(displayWidth(hints) > 40, 'the case is only interesting while the hints overflow');
  assert.equal(line, hints);
});

test('a build that will not fit is dropped whole, never half-drawn', () => {
  for (const [name, apply] of SCREENS) {
    for (const W of WIDTHS) {
      const [line, hints] = pair(apply, W);
      if (labelOf(line)) continue;
      assert.equal(line, hints, `${name} at W=${W}: something was left behind`);
    }
  }
});

// ── the ladder down ──────────────────────────────────────────
//
// Widths are measured off the hints rather than written down, so editing a key
// hint moves these cases instead of breaking them.

test('the label spends its sha, then its head, then goes', () => {
  const hints = displayWidth(composed(makeTUI({}), 200));
  const room = n => labelOf(composed(makeTUI({ versionLabel: LABEL }), hints + GAP + 1 + n));

  assert.equal(room(21), LABEL, 'whole, when the line has room for it');
  assert.equal(room(20), BARE, 'a sha says which commit, never which build');
  assert.equal(room(13), BARE);
  assert.equal(room(12), '…1.20-rik.12', 'cut from the left: the tail is what tells builds apart');
  assert.equal(room(4), '….12');
  assert.equal(room(3), '', 'under that there is nothing legible left to draw');
});

test('the same ladder, run by narrowing a real terminal', () => {
  const at = W => labelOf(painted(makeTUI({ versionLabel: LABEL, onRestart: () => {} }), W));
  const seen = [120, 100, 84, 80, 76, 72, 66, 60, 44].map(at);

  assert.equal(seen[0], LABEL);
  assert.equal(seen.at(-1), '', 'and at the bottom the corner is simply empty');
  // Monotonic: the label never grows back as the terminal shrinks, and once it
  // is gone it stays gone.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(displayWidth(seen[i]) <= displayWidth(seen[i - 1]),
      `label grew from ${JSON.stringify(seen[i - 1])} to ${JSON.stringify(seen[i])}`);
    if (!seen[i - 1]) assert.equal(seen[i], '', 'a dropped label came back at a narrower width');
  }
});

// The ladder on its own, without the footer's arithmetic in the way.

test('fitHeadLabel spends build metadata before it cuts the version', () => {
  assert.equal(fitHeadLabel(LABEL, 21), LABEL);
  assert.equal(fitHeadLabel(LABEL, 20), BARE);
  assert.equal(fitHeadLabel(LABEL, 13), BARE);
  assert.equal(fitHeadLabel(LABEL, 9), '…0-rik.12');
  assert.equal(fitHeadLabel(LABEL, 3), '');
});

test('fitHeadLabel leaves a label with no build metadata exactly as it was', () => {
  assert.equal(fitHeadLabel('v1.2.3', 100), 'v1.2.3');
  assert.equal(fitHeadLabel(BARE, 13), BARE);
  assert.equal(fitHeadLabel(BARE, 9), '…0-rik.12');
  assert.equal(fitHeadLabel(BARE, 3), '');
});

// ── the update marker ────────────────────────────────────────
//
// The corner is the only place the display says an update is waiting. The
// header carried that marker for as long as it carried the build and lost both
// at once, so there is no second ▲ anywhere for this one to be read against.

test('an update waiting puts a marker after the build, and nothing does otherwise', () => {
  const on = painted(makeTUI({ versionLabel: LABEL, updateAvailable: true, onRestart: () => {} }), 120);
  assert.equal(cornerOf(on), `${LABEL} ▲`);
  assert.equal(labelOf(on), LABEL, 'the build is still the label; the marker is a note after it');

  const off = painted(makeTUI({ versionLabel: LABEL, updateAvailable: false, onRestart: () => {} }), 120);
  assert.equal(cornerOf(off), LABEL);
  assert.doesNotMatch(off, /▲/, 'and nowhere else on the line either');
});

test('the marker is budgeted before the label is cut, not after it', () => {
  // Measured off the hints rather than written down, like the ladder above:
  // what is under test is the room the label was given, not any one hint.
  const hints = displayWidth(composed(makeTUI({}), 200));
  const corner = (room, updateAvailable) => {
    const W = hints + GAP + 1 + room;
    const line = composed(makeTUI({ versionLabel: LABEL, updateAvailable }), W);
    assert.equal(displayWidth(line), W, `room=${room} upd=${updateAvailable}: ${displayWidth(line)} columns`);
    return cornerOf(line);
  };
  assert.equal(corner(21, false), LABEL, 'room for the whole label and no more');
  assert.equal(corner(21, true), `${BARE} ▲`, 'the marker is paid for out of the label, not out of the line');
  assert.equal(corner(23, true), `${LABEL} ▲`, 'two columns more and both are drawn whole');
});

test('a corner too narrow to carry both draws neither', () => {
  const hints = displayWidth(composed(makeTUI({}), 200));
  // Five columns: enough for a cut label on its own, not for one and a marker.
  const W = hints + GAP + 1 + 5;
  assert.equal(labelOf(composed(makeTUI({ versionLabel: LABEL }), W)), '…k.12');

  const line = composed(makeTUI({ versionLabel: LABEL, updateAvailable: true }), W);
  assert.equal(cornerOf(line), '', 'the label went and the marker went with it');
  assert.doesNotMatch(line, /▲/);
  assert.equal(line, composed(makeTUI({}), W), 'leaving the footer drawn before there was a build to name');
});

test('no build to name draws no marker, whatever this process knows', () => {
  // A marker alone in the corner names nothing it could be an update TO, and at
  // that end of the line it reads as one more key hint.
  const line = painted(makeTUI({ versionLabel: '', updateAvailable: true }), 100);
  assert.doesNotMatch(line, /▲/);
  assert.equal(line, painted(makeTUI({}), 100));
});

test('a footer carrying the marker is exactly the terminal width on every screen', () => {
  for (const [name, apply] of SCREENS) {
    for (const W of WIDTHS) {
      const tui = makeTUI({ versionLabel: LABEL, updateAvailable: true });
      apply(tui);
      const line = composed(tui, W);
      if (!cornerOf(line)) continue;   // too narrow to name it — its own test above
      assert.equal(displayWidth(line), W,
        `${name} at W=${W}: composed ${displayWidth(line)} columns, so fitLine will pad or cut it`);
    }
  }
});

test('and the footer the paint loop writes carries it at exactly the width too', () => {
  for (const mode of ['normal', 'settings', 'input']) {
    for (const W of WIDTHS) {
      const tui = makeTUI({ versionLabel: LABEL, updateAvailable: true, onRestart: () => {} });
      tui.mode = mode;
      if (mode === 'input') { tui.inputPrompt = 'Threshold (%)'; tui.inputBuf = '95'; }
      const line = painted(tui, W);
      assert.equal(displayWidth(line), W, `mode ${mode} at W=${W}: footer width ${displayWidth(line)}`);
    }
  }
});

// ── the drain keeps the corner ───────────────────────────────
//
// The drain footer names no build. The line lives for at most the deadline, the
// build cannot change under it, and when the restart is an update the label
// would name the build being replaced — so the columns stay with the escape
// hatch, which is what the line is read for.

test('a drain footer names no build, however much room it has', () => {
  for (const W of [80, 120, 200]) {
    const tui = makeTUI({ versionLabel: LABEL, onRestart: () => {} });
    tui.restartDrainStarted({ deadlineMs: 30_000, inFlight: () => 1 });
    const line = painted(tui, W);
    assert.equal(labelOf(line), '', `W=${W}: ${JSON.stringify(line.slice(-28))}`);
    assert.doesNotMatch(line, /1\.1\.20/, 'not anywhere else on the line either');
    assert.match(line, /ctrl-c/, 'the columns went to the escape hatch');
    assert.equal(displayWidth(line), W);
  }
});

test('and it draws no update marker either, for the same reason', () => {
  for (const W of [80, 200]) {
    const tui = makeTUI({ versionLabel: LABEL, updateAvailable: true, onRestart: () => {} });
    tui.restartDrainStarted({ deadlineMs: 30_000, inFlight: () => 1 });
    const line = painted(tui, W);
    assert.doesNotMatch(line, /▲/, `W=${W}: ${JSON.stringify(line.slice(-28))}`);
    assert.equal(displayWidth(line), W);
  }
});

// ── a build that names nothing ───────────────────────────────

test('a TUI given no label renders the footer it rendered before there was one', () => {
  for (const [name, apply] of SCREENS) {
    const blank = makeTUI({ versionLabel: '' });
    const bare = makeTUI({});
    apply(blank); apply(bare);
    assert.equal(composed(blank, 100), composed(bare, 100), name);
    assert.equal(displayWidth(composed(blank, 100)) <= 100, true, name);
  }
});

// ── attach mode ──────────────────────────────────────────────

function remoteTUI(server, opts = {}) {
  const am = new RemoteAccountManager();
  am.applyStatus({
    currentAccount: 'a@example.com', switchThreshold: 0.98, routes: [],
    sessions: { active: 0, known: 0, perAccount: {} },
    accounts: [{ name: 'a@example.com', type: 'oauth', status: 'active', usage: {}, quota: {} }],
    ...(server ? { server } : {}),
  });
  return makeTUI({ am, remote: true, applySwitch: async () => {}, ...opts });
}

test('the attached dashboard names the server build in the corner, not its own', () => {
  const line = painted(remoteTUI({ version: '1.0.0', versionLabel: 'v9.9.9' }, { versionLabel: 'ignored-local' }), 100);
  assert.equal(labelOf(line), 'v9.9.9');
  assert.doesNotMatch(line, /ignored-local/);
});

test('a dashboard that has not polled yet names no build at all', () => {
  // RemoteAccountManager starts the label empty on purpose: an empty corner is
  // better than one naming this machine's checkout as if it were the server's.
  const am = new RemoteAccountManager();
  const line = painted(makeTUI({ am, remote: true, versionLabel: 'local-checkout' }), 100);
  assert.equal(labelOf(line), '');
  assert.doesNotMatch(line, /local-checkout/);
});

test('a version label off the wire cannot put an escape sequence in the footer', () => {
  const tui = remoteTUI({ versionLabel: 'v1\x1b[2J\x1b]52;c;aGk=\x07evil' });
  const line = painted(tui, 100);
  assert.doesNotMatch(line, /[\x1b\x07\x9b]/);
  assert.equal(displayWidth(line), 100);
});

test('the marker in attach mode reports the server, not this process', () => {
  const on = painted(remoteTUI(
    { version: '1.0.0', versionLabel: 'v9.9.9', updateAvailable: true },
    { updateAvailable: false },
  ), 100);
  assert.equal(cornerOf(on), 'v9.9.9 ▲');

  const off = painted(remoteTUI(
    { version: '1.0.0', versionLabel: 'v9.9.9' },
    { versionLabel: 'ignored-local', updateAvailable: true },
  ), 100);
  assert.equal(cornerOf(off), 'v9.9.9', 'an update to the local checkout says nothing about the server');
});

test('a dashboard that has not polled yet draws no marker, having nothing to hang it on', () => {
  const am = new RemoteAccountManager();
  const line = painted(makeTUI({ am, remote: true, versionLabel: 'local-checkout', updateAvailable: true }), 100);
  assert.equal(cornerOf(line), '');
  assert.doesNotMatch(line, /▲/);
});

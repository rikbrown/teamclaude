import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth } from '../src/tui.js';

// Pressing `u` used to take the whole dashboard away for as long as the drain
// ran — up to thirty seconds of plain console lines — and only then exit to be
// relaunched. The display now outlives the drain and reports it: how long the
// wait has run against the bound it cannot exceed, and what is still holding
// it. Which means the TUI also has to say what it will and will not do while
// one is running, because the listener is already closed.

function fakeAm({ sessions = 0, draining = 0 } = {}) {
  return {
    accounts: [], currentIndex: -1, switchThreshold: 0.98,
    getRoutes: () => [],
    sessionStats: () => ({ active: sessions, known: sessions, draining }),
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

/** Put a drain on a TUI as the server would, then age it so the elapsed reading
 *  under test is a fixed one rather than whatever this machine took to get here. */
function draining(tui, { agedMs = 0, inFlight = 0, deadlineMs = 30_000 } = {}) {
  tui.restartDrainStarted({ deadlineMs, inFlight: () => inFlight });
  tui._restartDrain.startedAt -= agedMs;
  return tui;
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

const footerOf = (tui, W) => frame(tui, W).at(-1);

// ── what the drain says ──────────────────────────────────────

test('the footer names the drain, how long it has run, and what is holding it', () => {
  const tui = draining(makeTUI(), { agedMs: 12_000, inFlight: 2 });
  const footer = stripSgr(tui._renderFooter(100));

  assert.match(footer, /Restarting/);
  assert.match(footer, /12s\/30s/, 'elapsed against the deadline, not a countdown');
  assert.match(footer, /2 in flight/);
  assert.match(footer, /ctrl-c/, 'the one key that still does anything');
});

// The drain ends when the last request does, which is usually well before the
// deadline — so the reading has to follow the clock, not a fixed schedule.
test('the elapsed reading tracks the real wait', () => {
  const tui = makeTUI();
  draining(tui, { inFlight: 1 });
  assert.match(stripSgr(tui._renderFooter(100)), /0s\/30s/);
  tui._restartDrain.startedAt -= 7_000;
  assert.match(stripSgr(tui._renderFooter(100)), /7s\/30s/);
});

test('a drain outranks whatever screen the operator was on', () => {
  for (const mode of ['normal', 'settings', 'routes', 'select', 'input']) {
    const tui = draining(makeTUI(), { inFlight: 1 });
    tui.mode = mode;
    assert.match(stripSgr(tui._renderFooter(100)), /Restarting/, `mode ${mode}`);
  }
});

// ── and at the widths it has to say it at ────────────────────

const WIDTHS = [40, 44, 50, 60, 80, 100, 120, 200];

test('the drain footer is exactly the terminal width at every size', () => {
  for (const W of WIDTHS) {
    for (const inFlight of [0, 2, 1234]) {
      const tui = draining(makeTUI({ am: fakeAm({ sessions: 3 }) }), { agedMs: 29_000, inFlight });
      const lines = frame(tui, W);
      const footer = lines.at(-1);
      const where = `W=${W} inFlight=${inFlight}`;
      assert.equal(displayWidth(footer), W, `${where}: footer width ${displayWidth(footer)}`);
      // The header is composed from the same frame and is the piece that was
      // just taught to degrade rather than vanish; a drain must not undo that.
      assert.equal(displayWidth(lines[0]), W, `${where}: header width ${displayWidth(lines[0])}`);
      assert.match(footer, /Restarting/, where);
      assert.match(footer, new RegExp(`${inFlight} in flight`), `${where}: the count is not optional`);
    }
  }
});

test('a footer short of room drops the hint, never the numbers', () => {
  const narrow = footerOf(draining(makeTUI(), { agedMs: 3_000, inFlight: 2 }), 40);
  assert.match(narrow, /3s\/30s/);
  assert.match(narrow, /2 in flight/);
  assert.doesNotMatch(narrow, /ctrl-c/, 'at 40 columns something has to go, and it is the hint');

  const wide = footerOf(draining(makeTUI(), { agedMs: 3_000, inFlight: 2 }), 100);
  assert.match(wide, /ctrl-c/, 'and it comes back the moment there is room');
});

// ── the two drains are different things ──────────────────────
//
// `drain N` in the header is SESSION draining: sessions being moved off an
// account during a rotation. It has nothing to do with the process going away,
// and reading one as the other would be a real bug rather than a cosmetic one.

test('session draining and restart draining do not stand in for each other', () => {
  const rotating = makeTUI({ am: fakeAm({ sessions: 4, draining: 2 }), onRestart: () => {} });
  const lines = frame(rotating, 100);
  assert.match(lines[0], /drain 2/, 'sessions are still draining off an account');
  assert.match(lines.at(-1), /switch/, 'and the keys are still on offer, because nothing is restarting');

  const restarting = draining(makeTUI({ am: fakeAm({ sessions: 4 }), onRestart: () => {} }), { inFlight: 1 });
  const restartingLines = frame(restarting, 100);
  assert.doesNotMatch(restartingLines[0], /drain/, 'no session is being moved anywhere');
  assert.match(restartingLines.at(-1), /Restarting/);
});

// ── keys while it runs ───────────────────────────────────────

test('every key but ctrl-c is refused while a drain runs', () => {
  const tui = draining(makeTUI({ am: fakeAm(), onRestart: () => {} }), { inFlight: 1 });
  tui.render = () => {};
  let quits = 0;
  tui.onQuit = () => { quits += 1; };
  tui.stop = () => {};

  for (const k of ['s', 'd', 'p', 'g', 'R', 'q', 'enter', 'up']) {
    tui._key(k);
    assert.equal(tui.mode, 'normal', `${k} moved the display off the drain`);
  }
  assert.equal(quits, 0, 'q is not an escape: an unattended drain can start mid-prompt');
});

test('ctrl-c during a drain still restores the terminal before it quits', () => {
  const tui = draining(makeTUI({ onRestart: () => {} }), { inFlight: 1 });
  tui.render = () => {};
  const order = [];
  tui.stop = () => order.push('stop');
  tui.onQuit = () => order.push('quit');

  tui._key('ctrl-c');
  assert.deepEqual(order, ['stop', 'quit'],
    'the screen and raw mode go back first — the quit path after it may exit at once');
});

test('a second u does not ask for a second restart', () => {
  let asked = 0;
  const tui = makeTUI({ onRestart: () => { asked += 1; } });
  tui.render = () => {};

  tui._key('u');
  assert.equal(asked, 1);

  // What the server does next, and the only thing that tells this TUI it did.
  draining(tui, { inFlight: 1 });
  tui._key('u');
  tui._doRestart();
  assert.equal(asked, 1, 'the server guards on its own flag — claiming otherwise here would be a lie');
});

test('a TUI with nothing to relaunch it never offers the key at all', () => {
  const tui = makeTUI({ onRestart: null });
  tui.render = () => {};
  assert.doesNotThrow(() => tui._key('u'));
  assert.equal(tui._restartDrain, null);
});

// ── the cadence behind it ────────────────────────────────────

test('a drain ticks at the animating cadence, so the counter moves', () => {
  const tui = makeTUI();
  const idle = tui._tickDelay();
  assert.ok(idle >= 5000, `idle tick is ${idle}ms`);

  draining(tui, { inFlight: 1 });
  const drainTick = tui._tickDelay();
  assert.ok(drainTick <= 1000, `a drain ticking every ${drainTick}ms cannot show seconds passing`);
});

test('starting a drain re-arms the tick rather than waiting out the idle one', () => {
  const tui = makeTUI();
  tui.running = true;
  tui.render = () => {};
  let rearmed = 0;
  tui._scheduleTick = () => { rearmed += 1; };

  tui.restartDrainStarted({ deadlineMs: 30_000, inFlight: () => 1 });
  assert.equal(rearmed, 1);
});

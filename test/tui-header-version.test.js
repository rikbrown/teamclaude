import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// The header names no build. It did once, centred between the title and the
// port block, and holding it there was most of what this file used to test; the
// build is named once now, in the corner of the footer (tui-footer-version).
//
// What survives is the invariant all that arithmetic existed to protect, and
// which a simpler header can break just as quietly: the line is exactly the
// terminal width. Short, and the paint loop pads it; long, and fitLine takes
// the tail — which is the port block and the liveness marker on the end of it.
//
// The rest of the file is here to keep the label from coming back.

function fakeAm({ sessions = 0, connected } = {}) {
  return {
    accounts: [],
    currentIndex: -1, switchThreshold: 0.98,
    connected,
    getRoutes() { return []; },
    sessionStats() { return { active: sessions, known: sessions }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
}

function makeTUI({ am = fakeAm(), ...opts } = {}) {
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: null,
    ...opts,
  });
}

/** One full frame at a given width, ANSI left in place. */
function renderRaw(tui, W) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: W, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let frame = '';
  try {
    tui._paint = buf => { frame = buf; };
    tui.running = true;
    // An object, not `true`: the signature is `render({ force = false } = {})`,
    // so a boolean destructures to nothing and forces no paint whatsoever.
    tui.render({ force: true });
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return frame;
}

const stripSgr = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const cursorCodes = /\x1b\[H|\x1b\[\?25[hl]/g;
const header = (tui, W) => stripSgr(renderRaw(tui, W)).replace(cursorCodes, '').split('\r\n')[0];
const count = (s, ch) => [...s].filter(c => c === ch).length;

const WIDTHS = [40, 44, 50, 60, 80, 100, 120, 200];

// Labels spanning the ladder this line used to run: one that fit anywhere, one
// that had to be cut, and a checkout label carrying build metadata to spend.
// None of them may reach the header now.
const LABELS = ['', 'v1.2.3', '1.1.20-pr378', '1.1.20-rik.12+acc19b3'];

test('the header is exactly the terminal width at every size', () => {
  for (const W of WIDTHS) {
    for (const sessions of [0, 3]) {
      for (const updateAvailable of [false, true]) {
        for (const versionLabel of LABELS) {
          const line = header(makeTUI({ am: fakeAm({ sessions }), versionLabel, updateAvailable }), W);
          const where = `W=${W} sess=${sessions} upd=${updateAvailable} label=${versionLabel || '(none)'}`;
          assert.equal(displayWidth(line), W, `${where}: width ${displayWidth(line)}`);
          assert.ok(line.endsWith('Port 1 ▲ '), `${where}: right block clipped — ${JSON.stringify(line.slice(-12))}`);
        }
      }
    }
  }
});

test('and it names no build at any of them', () => {
  for (const W of WIDTHS) {
    for (const sessions of [0, 3]) {
      for (const versionLabel of LABELS.filter(Boolean)) {
        const line = header(makeTUI({ am: fakeAm({ sessions }), versionLabel, updateAvailable: true }), W);
        const where = `W=${W} sess=${sessions} label=${versionLabel}`;
        assert.doesNotMatch(line, /1\.1\.20|1\.2\.3|acc19b3/, `${where}: ${JSON.stringify(line)}`);
        assert.doesNotMatch(line, /…/, `${where}: a label cut down is still a label`);
      }
    }
  }
});

test('the label changes nothing at all about the line it used to sit on', () => {
  for (const W of WIDTHS) {
    for (const sessions of [0, 3]) {
      const bare = header(makeTUI({ am: fakeAm({ sessions }) }), W);
      for (const versionLabel of LABELS) {
        for (const updateAvailable of [false, true]) {
          const line = header(makeTUI({ am: fakeAm({ sessions }), versionLabel, updateAvailable }), W);
          assert.equal(line, bare,
            `W=${W} sess=${sessions} upd=${updateAvailable} label=${versionLabel || '(none)'}`);
        }
      }
    }
  }
});

// This line carried two green ▲ for a while: the liveness marker beside the
// port, and the update marker beside the label. One of them is gone, and the
// one left means what it always meant.
test('the only triangle left on the line is the liveness marker', () => {
  for (const updateAvailable of [false, true]) {
    const line = header(makeTUI({ versionLabel: '1.1.20-rik.12+acc19b3', updateAvailable }), 100);
    assert.equal(count(line, '▲'), 1, `upd=${updateAvailable}: ${JSON.stringify(line)}`);
  }
  // And it still turns over when contact is lost, which is the whole of its job.
  const lost = header(makeTUI({ am: fakeAm({ connected: false }), updateAvailable: true }), 100);
  assert.equal(count(lost, '▲'), 0);
  assert.equal(count(lost, '▼'), 1);
});

test('a header the two blocks alone overrun is cut, not thrown', () => {
  // ' '.repeat(-1) throws, so the one padding run left on this line is floored
  // rather than trusted. At 40 columns a distributing session segment leaves
  // the title and the port block wider than the line between them: fitLine
  // takes the tail, as it does for any over-long line, and the header is still
  // exactly the width. The right block is what pays, which is why this case
  // makes no claim about the end of the line.
  const am = fakeAm({ sessions: 3 });
  am.distributeSessions = true;
  am.distributionMode = 'adaptive';
  const line = header(makeTUI({ am, versionLabel: '1.1.20-rik.12+acc19b3' }), 40);
  assert.equal(displayWidth(line), 40);
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

test('an attached dashboard names no build up here either, local or server', () => {
  const line = header(remoteTUI(
    { version: '1.0.0', versionLabel: 'v9.9.9', updateAvailable: true },
    { versionLabel: 'ignored-local', updateAvailable: false },
  ), 100);
  assert.equal(displayWidth(line), 100);
  assert.doesNotMatch(line, /9\.9\.9|1\.0\.0|ignored-local/);
  assert.equal(count(line, '▲'), 1);
});

test('a hostile label off the wire leaves the header exactly as it was', () => {
  // The corner sanitizes what it draws, and tui-footer-version holds it to
  // that. The header's defence is simpler: it draws none of it.
  const line = header(remoteTUI({ versionLabel: 'v1\x1b[2J\x1b]52;c;aGk=\x07evil' }), 100);
  assert.equal(line, header(remoteTUI(null), 100));
  assert.doesNotMatch(line, /evil/);
});

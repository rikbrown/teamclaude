import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// The ⚙ line: the sidecar's supervised state, plus what the sidecar says about
// itself. The second half is polled off ITS endpoint, not ours, so the line has
// to read correctly with those numbers missing — which is every version of the
// sidecar before this, every moment its port is not answering yet, and any
// rebase that moves the endpoint. "Missing" must render as the line rendered
// before any of this existed, never as a zero.

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A TUI over one local backend and whatever the supervisor reports about it. */
function conduitLine(sidecar) {
  const am = {
    accounts: [{ name: 'codex', index: 0, type: 'oauth', upstream: 'http://127.0.0.1:18765' }],
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    getSidecars: () => (sidecar ? [sidecar] : []),
  });
  tui.render = () => {};
  const [line] = tui._conduitLines();
  return stripAnsi(line);
}

const up = (extra = {}) => ({
  name: 'codex', running: true, pid: 98018, restarts: 0, lastExit: null,
  blocked: false, blockedReason: null, stderrTail: [], ...extra,
});

test('the readout appears beside the pid when the sidecar has something to report', () => {
  const line = conduitLine(up({ activeRequests: 2, recentErrors: 3 }));
  assert.match(line, /up pid 98018 2 active 3 errors$/);
});

test('an idle sidecar adds nothing: a line of zeroes is how a readout becomes noise', () => {
  assert.match(conduitLine(up({ activeRequests: 0, recentErrors: 0 })), /up pid 98018$/);
});

test('a sidecar that did not answer renders exactly the line it rendered before', () => {
  const asBefore = conduitLine(up());   // no readout fields at all
  assert.match(asBefore, /up pid 98018$/);
  assert.equal(conduitLine(up({ activeRequests: null, recentErrors: null })), asBefore);
});

test('errors show while the numbers are the only sign of trouble', () => {
  // Nothing in flight and the process is up — the count is the only thing on
  // the line saying the sidecar is failing the requests it does get.
  assert.match(conduitLine(up({ activeRequests: 0, recentErrors: 7 })), /up pid 98018 7 errors$/);
});

test('a down sidecar keeps saying what a down sidecar says', () => {
  const line = conduitLine(up({ running: false, pid: null, lastExit: 'code 1', restarts: 3 }));
  assert.match(line, /down \(code 1\) 3 restarts$/);
});

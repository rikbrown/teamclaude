import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteControl, createAttachSession } from '../src/tui-remote.js';

// The TUI's `t`: the account picker `s` and `l` use, choosing where NEW
// conversations go. Driven key by key against a real AccountManager, so what
// is checked is the steer the manager ends up holding.

const H = 3600_000;
const DAY = 24 * H;
const stripAnsi = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const oauth = (/** @type {string} */ name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + DAY, accountUuid: `u-${name}`, orgUuid: `o-${name}`, ...extra });

function makeTUI() {
  const am = new AccountManager([oauth('alpha'), oauth('bravo'), oauth('charlie')], 0.98);
  for (const a of am.accounts) Object.assign(a.quota, { unified5h: 0.1, unified5hReset: Date.now() + H, unified7d: 0.3, unified7dReset: Date.now() + 3 * DAY });
  // Only charlie holds a banked reset: the RC badge, and so the `r` option.
  am.accounts[2].quota.resetCredits = { available: 1, applicable: null, seenAt: Date.now() };
  const tui = new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: [], routes: [] },
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  tui.render = () => {}; // the state machine, not the terminal
  return { tui, am };
}

/** The frame the TUI would paint, as plain text. @param {any} tui */
function frame(tui) {
  let out = '';
  tui._paint = (/** @type {string} */ buf) => { out = buf; };
  tui._render(true);
  return stripAnsi(out);
}

/** Run `fn` with the manager's log lines kept off the test output. @param {() => void} fn */
function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { fn(); } finally { console.log = log; }
}

test('t opens the account picker on the current account, and ↑↓ walk it', () => {
  const { tui, am } = makeTUI();
  am.setCurrentAccount(1);
  tui._key('t');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'steer');
  assert.equal(tui.selIdx, 1);
  tui._key('down');
  assert.equal(tui.selIdx, 2);
  tui._key('k');
  tui._key('up');
  assert.equal(tui.selIdx, 0);
  assert.match(stripAnsi(tui._renderFooter()), /for: until wall .*Enter steer .*Esc cancel/);
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.deepEqual(am.steerList(), [], 'Esc sets nothing');
});

test('←→ choose how long, and Enter sets the steer for that long', () => {
  const { tui, am } = makeTUI();
  tui._key('t');
  tui._key('down'); // bravo
  tui._key('right');
  assert.match(stripAnsi(tui._renderFooter()), /for: 1h/);
  tui._key('right');
  assert.match(stripAnsi(tui._renderFooter()), /for: 6h/);
  tui._key('right');
  tui._key('right');
  assert.match(stripAnsi(tui._renderFooter()), /for: until wall/, 'it wraps');
  tui._key('left');
  assert.match(stripAnsi(tui._renderFooter()), /for: 24h/);
  quietly(() => tui._key('enter'));
  assert.equal(tui.mode, 'normal');
  const [steer] = am.steerList();
  assert.equal(steer.target, 'bravo');
  assert.ok(Math.abs(steer.until - (Date.now() + 24 * H)) < 60_000);
  assert.equal(steer.redeem, false);
  assert.equal(am.currentIndex, 0, 'the current account did not move');
});

test('r is offered, and toggles, only on a row that holds a reset', () => {
  const { tui, am } = makeTUI();
  tui._key('t');
  tui._key('r');
  assert.equal(tui.steerRedeem, false, 'alpha holds no reset');
  assert.doesNotMatch(stripAnsi(tui._renderFooter()), /redeem/);
  tui._key('down');
  tui._key('down'); // charlie, RC1
  assert.match(stripAnsi(tui._renderFooter()), /r redeem at wall: off/);
  tui._key('r');
  assert.match(stripAnsi(tui._renderFooter()), /r redeem at wall: on/);
  quietly(() => tui._key('enter'));
  const [steer] = am.steerList();
  assert.equal(steer.target, 'charlie');
  assert.equal(steer.redeem, true);
});

test('t starts on the steered account, and Enter there clears the steer', () => {
  const { tui, am } = makeTUI();
  quietly(() => am.setSteer(2));
  tui._key('t');
  assert.equal(tui.selIdx, 2);
  assert.match(stripAnsi(tui._renderFooter()), /Enter clear steer/);
  quietly(() => tui._key('enter'));
  assert.deepEqual(am.steerList(), []);
});

test('the footer offers steer after switch, and the header and the row show the steer', () => {
  const { tui, am } = makeTUI();
  assert.match(stripAnsi(tui._renderFooter()), /switch {2}steer {2}disable/);
  assert.doesNotMatch(frame(tui), /steer →|»/);
  quietly(() => am.setSteer(1, { until: Date.now() + 5 * H }));
  const shown = frame(tui);
  assert.match(shown, /steer → bravo \(5h\)/);
  const rows = shown.split(/\r?\n/).filter(l => /alpha|bravo|charlie/.test(l));
  assert.equal(rows.filter(l => l.includes('»')).length, 1);
  assert.match(rows.find(l => l.includes('»')) ?? '', /» bravo|»bravo/);
});

// ── attach mode ─────────────────────────────────────────────────────────────

async function fakeServer(/** @type {any} */ t, /** @type {Record<string, any>} */ steerReply) {
  /** @type {any[]} */
  const seen = [];
  const status = {
    currentAccount: 'alpha', switchThreshold: 0.98,
    sessions: { active: 0, known: 0, distribute: true, perAccount: {} }, routes: [],
    accounts: [
      { name: 'alpha', type: 'oauth', provider: 'anthropic', priority: 0, status: 'active', quota: {}, usage: {} },
      { name: 'bravo', type: 'oauth', provider: 'anthropic', priority: 0, status: 'active', quota: { resetCredits: { available: 1, seenAt: Date.now() } }, usage: {} },
    ],
    steers: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/teamclaude/steer' ? steerReply : status));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = /** @type {any} */ (server.address()).port;
  const session = createAttachSession({ control: new RemoteControl({ port }), config: { proxy: { port } }, onQuit: () => {} });
  session.tui.render = () => {};
  session.am.applyStatus(status);
  return { session, seen, status };
}

async function untilLogged(/** @type {any} */ tui) {
  while (!tui.log.length) await new Promise(r => setImmediate(r));
}

test('in attach mode, t asks the server to steer, with the provider and the chosen length', async (t) => {
  const { session, seen } = await fakeServer(t, { ok: true, steer: { provider: 'anthropic', target: 'bravo', index: 1, until: Date.now() + 6 * H, redeem: true }, eligible: true });
  const { tui } = session;
  tui._key('t');
  tui._key('down');
  tui._key('right');
  tui._key('right'); // 6h
  tui._key('r');
  tui._key('enter');
  await untilLogged(tui);
  const posted = seen.filter(r => r.url === '/teamclaude/steer');
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(posted[0].body), { account: 'bravo', provider: 'anthropic', for: 6 * 3600, redeem: true });
  assert.match(tui.log[0].msg, /Steering new conversations to "bravo" for 6h, redeeming its reset at the wall/);
});

test('in attach mode, Enter on the steered account asks the server to clear it', async (t) => {
  const { session, seen, status } = await fakeServer(t, { ok: true, cleared: [{ provider: 'anthropic', target: 'bravo' }] });
  session.am.applyStatus({ ...status, steers: [{ provider: 'anthropic', target: 'bravo', index: 1, startedAt: Date.now(), until: Date.now() + H, redeem: false, redeeming: false }] });
  const { tui } = session;
  assert.match(frame(tui), /steer → bravo/);
  tui._key('t');
  assert.equal(tui.selIdx, 1, 'the cursor starts on the steered account');
  tui._key('enter');
  await untilLogged(tui);
  const posted = seen.filter(r => r.url === '/teamclaude/steer');
  assert.deepEqual(JSON.parse(posted[0].body), { account: null, provider: 'anthropic' });
  assert.match(tui.log[0].msg, /Steer to "bravo" cleared/);
});

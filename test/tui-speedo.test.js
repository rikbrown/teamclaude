import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { TUI, displayWidth } from '../src/tui.js';
import { speedoWidth, SPEEDO_MAX_H } from '../src/speedo.js';

// The TUI half of the throughput meter (config `throughputMeter`): a rate on
// each finished request's line, an estimate on each one still streaming, and a
// fleet speedo — a dial beside the top block where there is room for one, a
// number in the header where there is not, never both, and neither in attach
// mode. Off, which is the default, the dashboard is exactly what it was.

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const H = 3600_000;
// The Braille block, which the dial is drawn in. The activity spinner is
// Braille too, so only the lines above the activity pane are searched.
const BRAILLE = /[⠁-⣿]/;

const claude = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + H });
const codex = (name) => ({ name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, accessToken: `c-${name}`, refreshToken: 'r', expiresAt: Date.now() + H });

/** Ten Anthropic seats drawing F7 bars and two Codex seats with no session
 *  window: the operator's own fleet, whose top block on a 660-column terminal
 *  leaves hundreds of columns blank. */
function riksFleet(count = 10) {
  const names = Array.from({ length: count }, (_, i) => `seat${i}@example.com`);
  const am = new AccountManager([...names.map(claude), codex('codex:a@example.com'), codex('codex:b@example.com')], 0.98, {});
  am.accounts.forEach((a, i) => {
    if (a.provider === 'codex') { Object.assign(a.quota, { unified5h: null, sessionWindowStated: false, unified7d: 0.7, unified7dReset: Date.now() + 4 * 24 * H }); return; }
    Object.assign(a.quota, { unified5h: 0.1 + i / 30, unified5hReset: Date.now() + 3 * H, unified7d: 0.3 + i / 20, unified7dReset: Date.now() + (i + 1) * 24 * H, unified7dFable: 0.4 + i / 25, unified7dFableReset: Date.now() + 2 * 24 * H });
  });
  return am;
}

function tuiFor(am, config = {}, over = {}) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 3456 }, accounts: [], routes: [], ...config }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    ...over,
  });
  tui._retick = () => {};
  for (let i = 0; i < 30; i++) tui.log.push({ t: '13:54:27', msg: `POST /v1/messages (claude-opus-5-5) → seat${i % 10}@example.com (200, ${i}.3s)` });
  return tui;
}

/** About a thousand tok/s of traffic: one stream in flight, one finished. */
function traffic(tui) {
  const now = Date.now();
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: 'abc123' });
  tui.active.get(1).started = now - 12_000;
  for (let t = 10; t >= 0; t--) tui.onRequestProgress(1, { chars: 400, at: now - t * 1000 });
  tui.throughput.complete({ outputTokens: 8_000, chars: 0, firstAt: now - 9_000, lastAt: now - 500, startedAt: now - 11_000, endedAt: now - 500 });
}

/**
 * Render at `width`×`height`: the painted frame's lines (ANSI stripped), the
 * raw buffer, and every account row and panel line as composed, before the
 * merge and fitLine could cut them.
 */
function render(tui, width, height = 40) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsD = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: height, configurable: true });
  const rows = [];
  const panel = [];
  const realRow = tui._renderAcct.bind(tui);
  const realFleet = tui._fleetLines.bind(tui);
  tui._renderAcct = (...a) => { const out = realRow(...a); rows.push(strip(out)); return out; };
  tui._fleetLines = (...a) => { const out = realFleet(...a); panel.push(...out.map(strip)); return out; };
  let buf = '';
  tui._paint = (b) => { buf = b; };
  tui.running = true;
  try { tui.render({ force: true }); } finally {
    delete tui._renderAcct;
    delete tui._fleetLines;
    if (cols) Object.defineProperty(process.stdout, 'columns', cols); else delete process.stdout.columns;
    if (rowsD) Object.defineProperty(process.stdout, 'rows', rowsD); else delete process.stdout.rows;
  }
  const frame = strip(buf).replace(/\x1b\[[?0-9]*[A-Za-z]/g, '').split('\r\n');
  return { frame, buf, rows, panel };
}

/** The frame's lines above the activity pane, header and rule excluded. */
const topBlock = (frame) => frame.slice(2, frame.findIndex(l => /^ (Activity|Messages)/.test(l)));
/** Where the dial starts in the top block: its leftmost Braille cell, or -1. */
const dialColumn = (frame) => {
  const at = topBlock(frame).map(l => l.search(BRAILLE)).filter(i => i >= 0);
  return at.length ? Math.min(...at) : -1;
};
/** The dial's lines: every top-block line with anything drawn from the dial's
 *  first column on. The reading's unit and the scale labels count too, and the
 *  label row carries no Braille. */
const dialLines = (frame) => {
  const at = dialColumn(frame);
  return at < 0 ? [] : topBlock(frame).filter(l => l.slice(at).trim());
};

// ------------------------------------------------------------ off

// Off is the default, and it must not cost the dashboard a byte: whatever the
// meter holds, a frame with the setting unset, false, or on in attach mode is
// the frame the dashboard drew before the meter existed.
test('off, the frame is the same whatever the meter holds', () => {
  for (const width of [660, 230, 120]) {
    const plain = render(tuiFor(riksFleet()), width);
    // The operator's own header, unchanged: title, padding, port block.
    assert.equal(plain.frame[0], ` RikClaude Harness${' '.repeat(width - 30)}Port 3456 ▲ `);
    for (const config of [{}, { throughputMeter: false }]) {
      const tui = tuiFor(riksFleet(), config);
      // Everything the hooks could have left behind: a stream's progress, a
      // settled count in the meter, and the request itself gone again.
      traffic(tui);
      tui.active.clear();
      const { buf, frame } = render(tui, width);
      assert.equal(buf, plain.buf, `W=${width} ${JSON.stringify(config)}: the meter reached the frame`);
      assert.equal(dialLines(frame).length, 0);
    }
  }
});

test('off, a streaming request carries no estimate', () => {
  const tui = tuiFor(riksFleet());
  traffic(tui);
  const active = render(tui, 660).frame.find(l => l.includes('abc123'));
  assert.match(active.trimEnd(), / \(\d+\.\ds\.\.\.\)$/);
});

test('off, a finished request\'s line is what it always was, even if the server still timed it', () => {
  // A toggle mid-request: the server sampled the meter on at dispatch, so the
  // end carries a count, but the operator has turned it off since.
  const tui = tuiFor(riksFleet(), { throughputMeter: false });
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestEnd(9, { method: 'POST', path: '/v1/messages', account: 'seat1@example.com', status: 200, model: 'm', sessionId: null, outputTokens: 500, firstTokenAt: 0, lastTokenAt: 5_000 });
  assert.match(strip(tui.log[0].msg), /\(200, \d+\.\ds\)$/);
});

// ------------------------------------------------------------ on: per request

test('a finished request carries its exact rate inside the parentheses', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestEnd(9, { method: 'POST', path: '/v1/messages', account: 'seat1@example.com', status: 200, model: 'claude-opus-5-5', sessionId: null, outputTokens: 840, firstTokenAt: 1_000, lastTokenAt: 11_000 });
  assert.match(strip(tui.log[0].msg), /POST \/v1\/messages \(claude-opus-5-5\) → seat1@example\.com \(200, \d+\.\ds, 84 tok\/s\)$/);
});

test('a request with no measurable rate keeps the line it always had', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  for (const [id, extra] of [[1, { outputTokens: null, firstTokenAt: null, lastTokenAt: null }], [2, { outputTokens: 50, firstTokenAt: 1_000, lastTokenAt: 1_100 }]]) {
    tui.onRequestStart(id, { method: 'POST', path: '/v1/messages', sessionId: null });
    tui.onRequestEnd(id, { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: null, sessionId: null, ...extra });
    assert.match(strip(tui.log[0].msg), /\(200, \d+\.\ds\)$/, JSON.stringify(extra));
  }
});

test('a streaming request shows a marked estimate once it has streamed for a second', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  const now = Date.now();
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.active.get(1).started = now - 3_000;
  tui.onRequestProgress(1, { chars: 10, at: now - 300 });
  const line = () => render(tui, 230).frame.find(l => l.includes('/v1/messages') && l.includes('s...')).trimEnd();
  assert.match(line(), /\(\d+\.\ds\.\.\.\)$/, 'no estimate before a second of text');
  tui.active.get(1).firstAt = now - 2_000;
  tui.active.get(1).chars = 672;
  // 168 estimated tokens over two seconds: 84, less whatever time the test took.
  const [, tps] = line().match(/\(\d+\.\ds\.\.\. ~(\d+) tok\/s\)$/) || [];
  assert.ok(tps >= 78 && tps <= 84, `estimate ${tps}`);
});

test('the progress hook adds to counters and never paints', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: null });
  let renders = 0;
  tui.render = () => { renders++; };
  tui.onRequestProgress(1, { chars: 40, at: Date.now() });
  tui.onRequestProgress(1, { chars: 2, at: Date.now() });
  tui.onRequestProgress(999, { chars: 7, at: Date.now() });   // a request this TUI never opened
  assert.equal(renders, 0);
  assert.equal(tui.active.get(1).chars, 42);
});

// ------------------------------------------------------------ on: the dial

test('on an ultrawide terminal the dial sits beside the top block, and cuts nothing', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  traffic(tui);
  // How wide the block is as composed, trailing blanks and all: a panel line
  // padded to its column counts, and a frame cannot tell that from the pad.
  let used = -1;
  const place = tui._placeSpeedo.bind(tui);
  tui._placeSpeedo = (block, ...rest) => { used = Math.max(...block.map(l => displayWidth(l))); return place(block, ...rest); };
  const { frame, rows, panel } = render(tui, 660);
  assert.ok(frame.every(l => l.length === 660), 'the frame is not square');
  const block = topBlock(frame);
  const dial = dialLines(frame);
  assert.equal(dial.length, SPEEDO_MAX_H, 'a ten-row dial beside an eleven-line block');
  // Past everything the block draws, across the panel's two-column gutter
  // and the dial's own blank margin column: beside the block, not at the far
  // edge of the terminal.
  const dialAt = dialColumn(frame);
  assert.equal(dialAt, used + 2 + 1);
  assert.ok(used < 330, `the block ran to ${used} of 660 columns`);
  assert.ok(block.every(l => !l.slice(0, used + 2).match(BRAILLE)), 'the dial reached into the block');
  assert.ok(dialAt - 1 + speedoWidth(SPEEDO_MAX_H) <= 660);
  // The reading and its unit are on it, and the header does not repeat them.
  const unit = dial.findIndex(l => l.slice(dialAt).includes('tok/s'));
  assert.ok(unit > 0, 'no unit on the dial');
  const reading = dial[unit - 1].slice(dialAt).trim().split(/\s+/);
  assert.ok(reading.some(t => /^\d+(\.\d)?k$|^\d+$/.test(t)), `no reading above the unit: ${dial[unit - 1].slice(dialAt)}`);
  assert.doesNotMatch(frame[0], /tok\/s/, 'the reading is on the dial and in the header both');
  // Every row and every panel line survives the merge whole.
  for (const r of rows) assert.ok(frame.some(f => f.includes(r.trimEnd())), `a row lost its tail: ${r}`);
  for (const p of panel) if (p.trim()) assert.ok(frame.some(f => f.includes(p.trimEnd())), `a panel line lost its tail: ${p}`);
});

test('the dial takes the block\'s place in every fleet mode that leaves it room', () => {
  for (const mode of ['split', 'full', 'off']) {
    const tui = tuiFor(riksFleet(), { throughputMeter: true });
    tui.fleetMode = mode;
    const { frame, rows, panel } = render(tui, 660);
    assert.ok(dialLines(frame).length >= 6, `${mode}: no dial`);
    assert.doesNotMatch(frame[0], /tok\/s/, `${mode}: the header repeats it`);
    for (const r of rows) assert.ok(frame.some(f => f.includes(r.trimEnd())), `${mode}: a row lost its tail`);
    for (const p of panel) if (p.trim()) assert.ok(frame.some(f => f.includes(p.trimEnd())), `${mode}: a panel line lost its tail`);
  }
});

test('a terminal with no room for the dial puts the reading in the header instead', () => {
  for (const [width, height] of [[230, 40], [120, 30], [80, 24]]) {
    const tui = tuiFor(riksFleet(), { throughputMeter: true });
    traffic(tui);
    const { frame } = render(tui, width, height);
    assert.equal(dialLines(frame).length, 0, `W=${width}: a dial with no room for one`);
    assert.match(frame[0], /\s\d+(\.\d)?k? tok\/s {2}(\d+ sess.* {2})?Port 3456 ▲ $/, `W=${width}: ${frame[0]}`);
    assert.equal(frame[0].length, width);
  }
});

test('the header drops the reading rather than its own port block', () => {
  const am = riksFleet(2);
  const tui = tuiFor(am, { throughputMeter: true });
  // A session count wide enough that the reading no longer fits beside it:
  // the rest of the header is 47 columns, and the reading would take nine.
  am.sessionStats = () => ({ active: 123456789, known: 1, draining: 0 });
  const { frame } = render(tui, 50, 24);
  assert.match(frame[0], /Port 3456 ▲ $/);
  assert.doesNotMatch(frame[0], /tok\/s/);
});

test('attach mode draws neither the dial nor the number', () => {
  for (const width of [660, 120]) {
    const remote = new RemoteAccountManager();
    remote.applyStatus({ accounts: riksFleet().accounts.map((a, i) => ({ name: a.name, index: i, type: 'oauth', provider: a.provider, quota: a.quota })) });
    const on = render(tuiFor(remote, { throughputMeter: true }, { remote: true }), width);
    const off = render(tuiFor(remote, {}, { remote: true }), width);
    assert.equal(dialLines(on.frame).length, 0);
    assert.doesNotMatch(strip(on.buf), /tok\/s/);
    assert.equal(on.buf, off.buf, `W=${width}: attach mode drew something for the setting`);
  }
});

test('other screens carry the reading in the header, since they have no dial', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  tui.mode = 'settings';
  const { frame } = render(tui, 660);
  assert.match(frame[0], /0 tok\/s {2}Port 3456/);
});

test('a short block grows to hold the dial only on a terminal with rows to spare', () => {
  const small = () => {
    const am = new AccountManager([claude('one@example.com'), claude('two@example.com')], 0.98, {});
    for (const a of am.accounts) Object.assign(a.quota, { unified5h: 0.2, unified5hReset: Date.now() + H, unified7d: 0.3, unified7dReset: Date.now() + 24 * H });
    const tui = tuiFor(am, { throughputMeter: true });
    tui.fleetMode = 'off';
    return tui;
  };
  const tall = render(small(), 200, 60).frame;
  assert.equal(dialLines(tall).length, 6, 'a sixty-row terminal can spare the lines');
  const short = render(small(), 200, 24).frame;
  assert.equal(dialLines(short).length, 0, 'a short terminal keeps its log');
  assert.match(short[0], /tok\/s/);
});

// ------------------------------------------------------------ the setting

test('the settings row turns the meter on and off, live, and saves it', async () => {
  const saved = [];
  const tui = tuiFor(riksFleet(), {}, { saveConfig: async (c) => { saved.push(c.throughputMeter); } });
  const row = () => tui._settingsFields().find(f => f.id === 'throughputMeter');
  assert.equal(strip(row().value()), 'off', 'absent reads off');
  assert.equal(dialLines(render(tui, 660).frame).length, 0);

  await row().right();
  assert.equal(tui.config.throughputMeter, true);
  assert.equal(strip(row().value()), 'on');
  assert.ok(dialLines(render(tui, 660).frame).length > 0, 'the dial did not appear on the next frame');

  await row().enter();
  assert.equal(tui.config.throughputMeter, false);
  assert.equal(dialLines(render(tui, 660).frame).length, 0);
  assert.deepEqual(saved, [true, false]);
});

test('a save that fails leaves the meter as it was', async () => {
  const tui = tuiFor(riksFleet(), {}, { saveConfig: async () => { throw new Error('disk full'); } });
  await tui._settingsFields().find(f => f.id === 'throughputMeter').right();
  assert.equal(tui.config.throughputMeter, undefined);
  assert.match(tui.log[0].msg, /throughput left unchanged/);
});

test('the settings screen names the setting', () => {
  const tui = tuiFor(riksFleet());
  tui.mode = 'settings';
  const { frame } = render(tui, 120, 80);
  assert.ok(frame.some(l => /^ {2}Throughput {2}— output tokens per second/.test(l)));
  assert.ok(frame.some(l => /Throughput\s+off/.test(l)));
});

// ------------------------------------------------------------ the cadence

test('the tick stays fast while the reading falls back to zero, and only then', () => {
  const tui = tuiFor(riksFleet(), { throughputMeter: true });
  assert.equal(tui._tickDelay(), 5_000, 'idle, and nothing to settle');
  tui.throughput.progress(400, Date.now());
  assert.equal(tui._tickDelay(), 500, 'a reading still on its way down');
  tui.config.throughputMeter = false;
  assert.equal(tui._tickDelay(), 5_000, 'off, the cadence is what it was');
});

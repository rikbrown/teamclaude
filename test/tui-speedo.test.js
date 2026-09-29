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
 *  window: a two-provider pool whose top block, on a 660-column terminal,
 *  leaves hundreds of columns blank. */
function wideFleet(count = 10) {
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
  tui.throughput.finish('earlier', { outputTokens: 8_000, firstAt: now - 9_000, lastAt: now - 500, endedAt: now - 500, model: 'm' });
}

/** The frame line of the activity entry or request that contains `needle`. */
const lineOf = (tui, width, needle) => render(tui, width).frame.find(l => l.includes(needle))?.trimEnd();

const END = { method: 'POST', path: '/v1/messages', account: 'seat1@example.com', status: 200, model: 'claude-opus-5-5', sessionId: null };

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
    const plain = render(tuiFor(wideFleet()), width);
    // The header as it always was: title, padding, port block.
    assert.match(plain.frame[0], /^ \S.*\S {2,}Port 3456 ▲ $/);
    assert.equal(plain.frame[0].length, width);
    for (const config of [{}, { throughputMeter: false }]) {
      const tui = tuiFor(wideFleet(), config);
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
  const tui = tuiFor(wideFleet());
  traffic(tui);
  const active = render(tui, 660).frame.find(l => l.includes('abc123'));
  assert.match(active.trimEnd(), / \(\d+\.\ds\.\.\.\)$/);
});

test('off, a finished request\'s line is what it always was, even if the server still timed it', () => {
  // A toggle mid-request: the server sampled the meter on at dispatch, so the
  // end carries a count, but the operator has turned it off since.
  const tui = tuiFor(wideFleet(), { throughputMeter: false });
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestEnd(9, { ...END, outputTokens: 500, firstTokenAt: 0, lastTokenAt: 5_000 });
  assert.match(strip(tui.log[0].msg), /\(200, \d+\.\ds\)$/);
  assert.match(lineOf(tui, 200, 'seat1@example.com (200'), /\(200, \d+\.\ds\)$/);
});

// The rate is kept beside the line, not in it, so an entry logged while the
// meter was on reads as it always did once the meter is off.
test('turning the meter off takes the rate off lines already logged', async () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  const off = tuiFor(wideFleet());
  for (const t of [tui, off]) {
    t.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
    t.onRequestEnd(9, { ...END, outputTokens: 840, firstTokenAt: 1_000, lastTokenAt: 11_000 });
    t.log[0].t = '12:00:00';
  }
  assert.match(lineOf(tui, 200, 'seat1@example.com (200'), /, 84 tok\/s\)$/);
  await tui._toggleThroughputMeter();
  tui.log.shift();   // the toggle's own log line
  assert.equal(lineOf(tui, 200, 'seat1@example.com (200'), lineOf(off, 200, 'seat1@example.com (200'));
  assert.equal(render(tui, 200).buf, render(off, 200).buf);
});

// ------------------------------------------------------------ on: per request

test('a finished request carries its exact rate inside the parentheses', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestEnd(9, { ...END, outputTokens: 840, firstTokenAt: 1_000, lastTokenAt: 11_000 });
  assert.match(lineOf(tui, 200, 'seat1@example.com (200'), /POST \/v1\/messages \(claude-opus-5-5\) → seat1@example\.com \(200, \d+\.\ds, 84 tok\/s\)$/);
  // The stored line is the one the meter-off frame draws.
  assert.match(strip(tui.log[0].msg), /seat1@example\.com \(200, \d+\.\ds\)$/);
});

test('a request with no measurable rate keeps the line it always had', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  for (const [id, extra] of [[1, { outputTokens: null, firstTokenAt: null, lastTokenAt: null }], [2, { outputTokens: 50, firstTokenAt: 1_000, lastTokenAt: 1_100 }]]) {
    tui.onRequestStart(id, { method: 'POST', path: '/v1/messages', sessionId: null });
    tui.onRequestEnd(id, { ...END, account: `acct${id}`, ...extra });
    assert.match(lineOf(tui, 200, `acct${id} (200`), /\(200, \d+\.\ds\)$/, JSON.stringify(extra));
  }
});

// A buffered response has no generation interval, and the time before the
// attempt that answered was sent (a quota hold, a failover) is not generation.
test('a buffered response is timed from the dispatch of the attempt that answered', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  const now = Date.now();
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.active.get(9).started = now - 95_000;
  tui.onRequestEnd(9, { ...END, outputTokens: 1_000, firstTokenAt: null, lastTokenAt: null, dispatchedAt: now - 5_000 });
  const [, tps] = lineOf(tui, 200, 'seat1@example.com (200').match(/, (\d+) tok\/s\)$/) || [];
  assert.ok(tps >= 195 && tps <= 200, `read ${tps}, where the 90 s hold would read 10`);
});

test('a streaming request shows a marked estimate once it has generated for a second', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  const now = Date.now();
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: 'aaa111' });
  tui.active.get(1).started = now - 3_000;
  tui.onRequestProgress(1, { chars: 10, at: now - 300 });
  assert.match(lineOf(tui, 230, 'aaa111'), /\(\d+\.\ds\.\.\.\)$/, 'no estimate before a second of generating');
  tui.onRequestStart(2, { method: 'POST', path: '/v1/messages', sessionId: 'bbb222' });
  tui.active.get(2).started = now - 3_000;
  tui.onRequestProgress(2, { chars: 0, at: now - 2_000 });
  tui.onRequestProgress(2, { chars: 672, at: now });
  // 168 tokens of text over two seconds: 84, less whatever time the test took.
  const [, tps] = lineOf(tui, 230, 'bbb222').match(/\(\d+\.\ds\.\.\. ~(\d+) tok\/s\)$/) || [];
  assert.ok(tps >= 78 && tps <= 84, `estimate ${tps}`);
});

// Hidden thinking streams nothing for its tokens; once the model has a pace
// the line reads at it, where a character count read zero.
test('a request thinking in silence reads at its model\'s pace, not at zero', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  const now = Date.now();
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: 'aaa111' });
  tui.onRequestModel(1, { model: 'claude-opus-5-5' });
  tui.onRequestProgress(1, { chars: 0, at: now - 40_000 });
  tui.onRequestEnd(1, { ...END, outputTokens: 3_000, firstTokenAt: now - 40_000, lastTokenAt: now - 30_000 });   // 300 tok/s
  tui.onRequestStart(2, { method: 'POST', path: '/v1/messages', sessionId: 'bbb222' });
  tui.onRequestModel(2, { model: 'claude-opus-5-5' });
  tui.onRequestProgress(2, { chars: 0, at: now - 5_000 });   // a thinking block opens
  const [, tps] = lineOf(tui, 230, 'bbb222').match(/ ~(\d+) tok\/s\)$/) || [];
  assert.ok(tps >= 290 && tps <= 300, `estimate ${tps}`);
});

test('the progress hook adds to counters and never paints', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestModel(1, { model: 'm' });
  let renders = 0;
  tui.render = () => { renders++; };
  tui.onRequestProgress(1, { chars: 40, at: Date.now() });
  tui.onRequestProgress(1, { chars: 2, at: Date.now() });
  tui.onRequestProgress(999, { chars: 7, at: Date.now() });   // a request this TUI never opened
  assert.equal(renders, 0);
  assert.equal(tui.throughput.streams.get(1).chars, 42);
  assert.equal(tui.throughput.streams.get(1).model, 'm');
  assert.equal(tui.throughput.streams.has(999), false);
});

test('a request\'s end settles its stream in the meter', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestProgress(1, { chars: 40, at: Date.now() });
  tui.onRequestEnd(1, { ...END, outputTokens: null, firstTokenAt: null, lastTokenAt: null, status: 499 });
  assert.equal(tui.throughput.streams.size, 0);
});

// ------------------------------------------------------------ on: line widths

// The rate is at the END of the line, where fitLine cuts. So with the meter
// on, a line that would pass the edge gives up its middle — path, then model,
// then account — and keeps the parentheses whole.
test('a line that would pass the edge shortens its middle, not its rate', () => {
  const account = 'someone.with.a.long.name@example.com';
  for (let width = 70; width <= 200; width++) {
    const tui = tuiFor(wideFleet(), { throughputMeter: true });
    const now = Date.now();
    tui.onRequestStart(9, { method: 'POST', path: '/v1/messages?beta=true', sessionId: 'abcdef' });
    tui.onRequestEnd(9, { ...END, path: '/v1/messages?beta=true', account, sessionId: 'abcdef', outputTokens: 300, firstTokenAt: now - 3_000, lastTokenAt: now });
    tui.onRequestStart(8, { method: 'POST', path: '/v1/messages?beta=true', sessionId: 'fedcba' });
    tui.onRequestModel(8, { model: 'claude-opus-5-5' });
    tui.onRequestRouted(8, { account });
    tui.active.get(8).started = now - 3_000;
    tui.onRequestProgress(8, { chars: 0, at: now - 2_000 });
    tui.onRequestProgress(8, { chars: 800, at: now });
    const { frame } = render(tui, width);
    const done = frame.find(l => l.includes('abcdef')).trimEnd();
    const live = frame.find(l => l.includes('fedcba')).trimEnd();
    assert.match(done, / \(200, \d+\.\ds, 100 tok\/s\)$/, `W=${width}: ${done}`);
    assert.match(live, / \(\d+\.\ds\.\.\. ~\d+ tok\/s\)$/, `W=${width}: ${live}`);
    for (const l of [done, live]) {
      assert.ok(l.length <= width);
      // Shortened only when it had to be, and then with a mark.
      assert.equal(l.includes('…'), !l.includes(`/v1/messages?beta=true (claude-opus-5-5) → ${account}`), `W=${width}: ${l}`);
    }
  }
});

test('the path gives way before the model and the account', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  const now = Date.now();
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages?beta=true', sessionId: 'abcdef' });
  tui.onRequestEnd(9, { ...END, path: '/v1/messages?beta=true', sessionId: 'abcdef', outputTokens: 300, firstTokenAt: now - 3_000, lastTokenAt: now });
  const full = lineOf(tui, 200, 'abcdef');
  assert.match(lineOf(tui, full.length - 8, 'abcdef'), /POST \/v1\/messages\?… \(claude-opus-5-5\) → seat1@example\.com \(200/);
  // Past the path's floor, the model gives way next, and the account last.
  assert.match(lineOf(tui, full.length - 18, 'abcdef'), /POST \/v1\/mes… \(claude-opu…\) → seat1@example\.com \(200/);
});

test('off, a line past the edge is cut as it always was', () => {
  const tui = tuiFor(wideFleet());
  const now = Date.now();
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages?beta=true', sessionId: 'abcdef' });
  tui.onRequestEnd(9, { ...END, sessionId: 'abcdef', outputTokens: 300, firstTokenAt: now - 3_000, lastTokenAt: now });
  const line = lineOf(tui, 80, 'abcdef');
  assert.doesNotMatch(line, /…/);
  assert.equal(line.length, 80);
  assert.ok(`   ${tui.log[0].t}  ${strip(tui.log[0].msg)}`.startsWith(line));
});

test('a hostile model string stays inert on a fitted line', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  const now = Date.now();
  tui.onRequestStart(9, { method: 'POST', path: '/v1/messages', sessionId: null });
  tui.onRequestEnd(9, { ...END, model: 'claude-\x1b]52;c;aGVsbG8=\x07\x1b[2Jevil', outputTokens: 300, firstTokenAt: now - 3_000, lastTokenAt: now });
  for (const width of [70, 200]) {
    const { buf } = render(tui, width);
    assert.doesNotMatch(buf.replace(/\x1b\[[0-9;]*m|\x1b\[H|\x1b\[\?25[hl]/g, ''), /\x1b|\x07/);
  }
});

// ------------------------------------------------------------ on: the dial

test('on an ultrawide terminal the dial sits beside the top block, and cuts nothing', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
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
    const tui = tuiFor(wideFleet(), { throughputMeter: true });
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
    const tui = tuiFor(wideFleet(), { throughputMeter: true });
    traffic(tui);
    const { frame } = render(tui, width, height);
    assert.equal(dialLines(frame).length, 0, `W=${width}: a dial with no room for one`);
    assert.match(frame[0], /\s\d+(\.\d)?k? tok\/s {2}(\d+ sess.* {2})?Port 3456 ▲ $/, `W=${width}: ${frame[0]}`);
    assert.equal(frame[0].length, width);
  }
});

test('the header drops the reading rather than its own port block', () => {
  const am = wideFleet(2);
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
    remote.applyStatus({ accounts: wideFleet().accounts.map((a, i) => ({ name: a.name, index: i, type: 'oauth', provider: a.provider, quota: a.quota })) });
    const on = render(tuiFor(remote, { throughputMeter: true }, { remote: true }), width);
    const off = render(tuiFor(remote, {}, { remote: true }), width);
    assert.equal(dialLines(on.frame).length, 0);
    assert.doesNotMatch(strip(on.buf), /tok\/s/);
    assert.equal(on.buf, off.buf, `W=${width}: attach mode drew something for the setting`);
  }
});

test('other screens carry the reading in the header, since they have no dial', () => {
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
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
  const tui = tuiFor(wideFleet(), {}, { saveConfig: async (c) => { saved.push(c.throughputMeter); } });
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
  const tui = tuiFor(wideFleet(), {}, { saveConfig: async () => { throw new Error('disk full'); } });
  await tui._settingsFields().find(f => f.id === 'throughputMeter').right();
  assert.equal(tui.config.throughputMeter, undefined);
  assert.match(tui.log[0].msg, /throughput left unchanged/);
});

test('the settings screen names the setting', () => {
  const tui = tuiFor(wideFleet());
  tui.mode = 'settings';
  const { frame } = render(tui, 120, 80);
  assert.ok(frame.some(l => /^ {2}Throughput {2}— output tokens per second/.test(l)));
  assert.ok(frame.some(l => /Throughput\s+off/.test(l)));
});

// ------------------------------------------------------------ the cadence

test('the tick stays fast while the reading falls back to zero, and only then', () => {
  let now = 1e12;
  const tui = tuiFor(wideFleet(), { throughputMeter: true });
  tui.throughput.now = () => now;
  assert.equal(tui._tickDelay(), 5_000, 'idle, and nothing to settle');
  tui.throughput.progress('s', 400, now);
  assert.equal(tui._tickDelay(), 500, 'a stream in flight');
  tui.throughput.finish('s', { outputTokens: 100, firstAt: now, lastAt: now, endedAt: now });
  // The last tokens sit in the second they were booked in, and leave the
  // window a second after the window's length has passed.
  now += 10_999;
  assert.ok(tui.throughput.rate() > 0);
  assert.equal(tui._tickDelay(), 500, 'a reading still on its way down');
  now += 1;
  assert.equal(tui.throughput.rate(), 0);
  assert.equal(tui._tickDelay(), 5_000, 'the needle is at zero, so the cadence can slow');
  tui.throughput.progress('t', 400, now);
  tui.config.throughputMeter = false;
  assert.equal(tui._tickDelay(), 5_000, 'off, the cadence is what it was');
});

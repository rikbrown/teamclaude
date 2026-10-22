import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { STEER_MAX_MS, parseSteerDuration, resolveSteerUntil, formatSteerLeft } from '../src/steer.js';

// `teamclaude steer <account>`: new conversations of one provider go to one
// account for a while; running conversations keep theirs. These drive the
// manager's own selection walk, so what they check is where getActiveAccount
// sends a request, not what a helper says it would.

const H = 3600_000;
const DAY = 24 * H;
const OPUS = 'claude-opus-4-1';
const FABLE = 'claude-fable-5-1';

const oauth = (/** @type {string} */ name, extra = {}) => ({
  name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 10 * DAY,
  accountUuid: `u-${name}`, orgUuid: `o-${name}`, ...extra,
});
const codex = (/** @type {string} */ name) => ({ name, type: 'oauth', provider: 'codex', accessToken: `c-${name}`, refreshToken: 'r', expiresAt: Date.now() + 10 * DAY, accountId: `acct-${name}` });

/** Every account healthy, a third through its week, the week ending in three days. */
function fleet(accounts, opts = {}) {
  const am = new AccountManager(accounts, 0.98, opts);
  for (const a of am.accounts) {
    Object.assign(a.quota, { unified5h: 0.1, unified5hReset: Date.now() + 2 * H, unified7d: 0.3, unified7dReset: Date.now() + 3 * DAY });
  }
  return am;
}

/** The account a request lands on, recorded as the server records it. */
function route(am, sessionId, model = OPUS, { provider = 'anthropic', exclude = null } = {}) {
  /** @type {{ steered?: boolean }} */
  const decision = {};
  const account = am.getActiveAccount(exclude, model, null, sessionId, provider, decision);
  if (account && sessionId) am.recordSession(sessionId, account.index, model, { steered: decision.steered === true });
  return { name: account?.name ?? null, steered: decision.steered === true };
}

/** Run `fn` (async) with console.log captured, returning the lines. */
async function loggedAsync(fn) {
  const original = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

/** Run `fn` with console.log captured, returning the lines. */
function logged(fn) {
  const original = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { fn(); } finally { console.log = original; }
  return lines;
}

const indexOf = (am, name) => am.accounts.findIndex(a => a.name === name);

// ── parsing ─────────────────────────────────────────────────────────────────

test('a steer length is seconds or run-together units, and nothing else', () => {
  assert.equal(parseSteerDuration(90), 90_000);
  assert.equal(parseSteerDuration('3600'), 3600_000);
  assert.equal(parseSteerDuration('6h'), 6 * H);
  assert.equal(parseSteerDuration('1d12h'), 36 * H);
  assert.equal(parseSteerDuration('2h30m'), 2.5 * H);
  for (const bad of ['', '6 hours', '-1h', '0', 0, -5, 'h', '1w', null, {}, '1h-']) {
    assert.equal(parseSteerDuration(bad), null, JSON.stringify(bad));
  }
});

test('every steer has an end time, at most seven days out', () => {
  const now = 1_000_000;
  assert.deepEqual(resolveSteerUntil({}, now), { until: now + STEER_MAX_MS, clamped: false });
  assert.deepEqual(resolveSteerUntil({ for: '6h' }, now), { until: now + 6 * H, clamped: false });
  assert.deepEqual(resolveSteerUntil({ for: '30d' }, now), { until: now + STEER_MAX_MS, clamped: true });
  const iso = new Date(now + DAY).toISOString();
  assert.deepEqual(resolveSteerUntil({ until: iso }, now), { until: now + DAY, clamped: false });
  assert.equal(resolveSteerUntil({ until: new Date(now + 9 * DAY).toISOString() }, now).clamped, true);
  assert.match(/** @type {any} */ (resolveSteerUntil({ until: new Date(now - 1).toISOString() }, now)).error, /past/);
  assert.match(/** @type {any} */ (resolveSteerUntil({ until: 'tomorrow' }, now)).error, /ISO/);
  assert.match(/** @type {any} */ (resolveSteerUntil({ for: '1h', until: iso }, now)).error, /not both/);
  assert.equal(formatSteerLeft(5 * H + 12 * 60_000), '5h12m');
  assert.equal(formatSteerLeft(3 * DAY + 4 * H), '3d4h');
});

// ── placement ───────────────────────────────────────────────────────────────

test('a new conversation goes to the steer target over priority and every distribution mode', () => {
  const am = fleet([oauth('a'), oauth('b'), oauth('t', { priority: 3 })], { distributeSessions: true });
  assert.notEqual(route(am, 'before').name, 't', 'unsteered, the last on priority gets nothing');

  logged(() => am.setSteer(indexOf(am, 't')));
  for (const mode of ['even', 'load', 'adaptive']) {
    am.setDistributeSessions(mode);
    assert.deepEqual(route(am, `new-${mode}`), { name: 't', steered: true }, mode);
  }
  // And the placement holds: the pin the steer made is exempt from the
  // priority preemption, so its next request is served by the pin, not placed.
  assert.deepEqual(route(am, 'new-even'), { name: 't', steered: false });
});

test('a new conversation goes to the steer target outside the expiry band', () => {
  // Same priority as the rest, but nearly spent with its window a week out:
  // far below the top pressure band, so expiry routing never places there.
  const am = fleet([oauth('a'), oauth('b'), oauth('t')], {
    distributeSessions: true, expiryRouting: { enabled: true, tolerance: 1.5, preempt: true },
  });
  Object.assign(am.accounts[2].quota, { unified7d: 0.9, unified7dReset: Date.now() + 6.5 * DAY });
  // The even picker would hand the third conversation to the idle target;
  // the band is what keeps it off.
  for (const sid of ['one', 'two', 'three']) assert.notEqual(route(am, sid).name, 't', sid);

  logged(() => am.setSteer(indexOf(am, 't')));
  assert.deepEqual(route(am, 'four'), { name: 't', steered: true });
});

test('a conversation already pinned elsewhere stays put when a steer starts', () => {
  const am = fleet([oauth('a'), oauth('b'), oauth('t')], { distributeSessions: true });
  const before = route(am, 'running').name;
  assert.notEqual(before, 't');
  logged(() => am.setSteer(indexOf(am, 't')));
  assert.deepEqual(route(am, 'running'), { name: before, steered: false }, 'the pin is honoured, not re-placed');
  assert.equal(route(am, 'fresh').name, 't');
});

test('untagged requests follow the steer, with distribution on and off', () => {
  for (const distributeSessions of [true, false]) {
    const am = fleet([oauth('a'), oauth('b'), oauth('t')], { distributeSessions });
    logged(() => am.setSteer(indexOf(am, 't')));
    assert.deepEqual(route(am, null), { name: 't', steered: true }, `distributeSessions ${distributeSessions}`);
    assert.equal(am.accounts[am.currentIndex].name, 'a', 'the cursor did not move');
  }
});

test('the steer yields while its target is 5h-walled, paused or already tried, and resumes after', () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const t = indexOf(am, 't');
  logged(() => am.setSteer(t));

  am.accounts[t].quota.unified5h = 0.99;
  assert.equal(route(am, 'walled').name, 'a');
  assert.equal(am.steerList().length, 1, 'still armed');
  am.accounts[t].quota.unified5h = 0.2;
  assert.equal(route(am, 'after-wall').name, 't');

  am.pauseAccount(t, 30);
  assert.equal(route(am, 'paused').name, 'a');
  am.accounts[t].pausedUntil = null;
  assert.equal(route(am, 'after-pause').name, 't');

  // A 429 hold makes it unavailable outright.
  logged(() => am.markRateLimited(t, 60));
  assert.equal(route(am, 'held').name, 'a');
  logged(() => am.clearRateLimited(t));

  assert.equal(route(am, 'tried', OPUS, { exclude: new Set([t]) }).name, 'a');
  assert.equal(route(am, 'untried').name, 't');
  assert.equal(am.steerList().length, 1);
});

test('a steer loses to an exclusive route, a manual route pin and another provider', () => {
  const am = fleet([oauth('a'), oauth('b'), oauth('t'), codex('cx1'), codex('cx2')], {
    distributeSessions: true,
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['a'] },
      { name: 'sonnet', match: ['*sonnet*'] },
    ],
  });
  logged(() => am.setSteer(indexOf(am, 't')));
  assert.equal(route(am, 'f', FABLE).name, 'a', 'the route does not list the target');
  assert.equal(am.setRoutePin('sonnet', indexOf(am, 'b')).ok, true);
  assert.equal(route(am, 's', 'claude-sonnet-4-6').name, 'b', 'a manual route pin resolves first');
  assert.equal(route(am, 'o', OPUS).name, 't');

  // A Codex request is another partition: the Anthropic steer is not its own.
  assert.notEqual(route(am, 'cx', 'gpt-5.6-sol', { provider: 'codex' }).name, 't');
  // A Codex steer stands beside the Anthropic one.
  logged(() => am.setSteer(indexOf(am, 'cx2')));
  assert.equal(route(am, 'cx-new', 'gpt-5.6-sol', { provider: 'codex' }).name, 'cx2');
  assert.deepEqual(am.steerList().map(s => s.target).sort(), ['cx2', 't']);
});

test('a spent family bucket diverts that family and leaves the steer standing', () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const t = indexOf(am, 't');
  logged(() => am.setSteer(t));
  Object.assign(am.accounts[t].quota, { unified7dFable: 1, unified7dFableReset: Date.now() + 2 * DAY, unified7dFableSeenAt: Date.now() });
  assert.equal(route(am, 'fable', FABLE).name, 'a');
  assert.equal(route(am, 'opus', OPUS).name, 't');
  assert.equal(am.steerList().length, 1);
});

// ── end conditions ──────────────────────────────────────────────────────────

test('the steer ends once, saying why, when its target reaches the weekly switch threshold', () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  logged(() => am.setSteer(indexOf(am, 't')));
  am.accounts[indexOf(am, 't')].quota.unified7d = 0.98;
  const lines = logged(() => { route(am, 'x'); route(am, 'y'); am.getStatus(); });
  assert.deepEqual(lines.filter(l => /Steer to "t" ended/.test(l)), ['[TeamClaude] Steer to "t" ended — its weekly quota reached the switch threshold (98.0%)']);
  assert.deepEqual(am.steerList(), []);
});

test('the steer ends at its end time, when cleared, when its account is removed, and when a reset is redeemed on it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const ti = indexOf(am, 't');
  logged(() => am.setSteer(ti, { until: Date.now() + H }));
  t.mock.timers.tick(H - 1);
  assert.equal(am.steerList().length, 1);
  t.mock.timers.tick(1);
  assert.match(logged(() => assert.deepEqual(am.steerList(), [])).join('\n'), /ended — its end time was reached/);

  logged(() => am.setSteer(ti));
  let cleared;
  assert.match(logged(() => { cleared = am.clearSteer(); }).join('\n'), /ended — cleared by the operator/);
  assert.deepEqual(/** @type {any} */ (cleared).map((/** @type {any} */ s) => s.target), ['t']);

  logged(() => am.setSteer(ti));
  assert.match(logged(() => am.noteResetRedeemed(am.accounts[ti])).join('\n'), /ended — a reset was redeemed on it/);

  logged(() => am.setSteer(ti));
  assert.match(logged(() => am.removeAccount(ti)).join('\n'), /Steer to "t" ended — the account was removed/);
  assert.deepEqual(am.steerList(), []);
  assert.equal(route(am, 'after-removal').name, 'a');
});

test('the steer ends when its weekly window rolls over, or is renewed ahead of its reset', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const ti = indexOf(am, 't');
  am.accounts[ti].quota.unified7dReset = Date.now() + 2 * H;
  logged(() => am.setSteer(ti));
  t.mock.timers.tick(2 * H);
  assert.match(logged(() => assert.deepEqual(am.steerList(), [])).join('\n'), /ended — its weekly window rolled over/);

  // A window that moves a week forward before its own end was renewed early:
  // a reset was redeemed, here or anywhere else.
  Object.assign(am.accounts[ti].quota, { unified7d: 0.4, unified7dReset: Date.now() + 2 * DAY });
  logged(() => am.setSteer(ti));
  am.accounts[ti].quota.unified7dReset = Date.now() + 7 * DAY;
  assert.match(logged(() => route(am, 'x')).join('\n'), /ended — its weekly window was renewed ahead of its reset/);
  // The two writers of a reset disagree by up to a second; that is no rollover.
  logged(() => am.setSteer(ti));
  am.accounts[ti].quota.unified7dReset += 1000;
  assert.equal(am.steerList().length, 1);
});

test('a steer is refused a --redeem it cannot use, and a target already at its wall', () => {
  const am = fleet([oauth('a'), { name: 'key', type: 'apikey', apiKey: 'k' }, oauth('t')]);
  assert.throws(() => am.setSteer(indexOf(am, 'key'), { redeem: true }), /holds no banked reset/);
  am.accounts[indexOf(am, 't')].quota.unified7d = 0.99;
  assert.throws(() => am.setSteer(indexOf(am, 't')), /already at its weekly switch threshold/);
  // With --redeem the same reading leaves room: it gates at upstream's wall.
  logged(() => am.setSteer(indexOf(am, 't'), { redeem: true }));
  assert.equal(am.steerList()[0].redeem, true);
  assert.deepEqual(am.steerList().map(s => s.target), ['t']);
});

// ── persistence ─────────────────────────────────────────────────────────────

test('a steer survives a restart by identity, following a rename; an ended or orphaned one is dropped', () => {
  const am1 = fleet([oauth('a'), oauth('t')]);
  logged(() => am1.setSteer(1, { until: Date.now() + 5 * H, redeem: true }));
  const saved = am1.exportSteers();
  assert.equal(JSON.stringify(saved).includes('t-t'), false, 'no credential in the state file');

  // The account was renamed and moved to the front of the list in between.
  const am2 = fleet([oauth('t-renamed', { accountUuid: 'u-t', orgUuid: 'o-t' }), oauth('a')]);
  const lines = logged(() => am2.restoreSteers(JSON.parse(JSON.stringify(saved))));
  assert.match(lines.join('\n'), /Restored the steer to "t-renamed"/);
  const [steer] = am2.steerList();
  assert.equal(steer.target, 't-renamed');
  assert.equal(steer.index, 0);
  assert.equal(steer.until, saved[0].until);
  assert.equal(steer.redeem, true);
  assert.equal(route(am2, 'new').name, 't-renamed');

  const am3 = fleet([oauth('a'), oauth('t')]);
  const dropped = logged(() => am3.restoreSteers([
    { ...saved[0], until: Date.now() - 1 },
    { ...saved[0], account: { ...saved[0].account, accountUuid: 'u-gone', name: 'gone' } },
  ]));
  assert.deepEqual(am3.steerList(), []);
  assert.match(dropped.join('\n'), /"t" not restored — it ended while the server was down/);
  assert.match(dropped.join('\n'), /"gone" not restored — no account in the fleet matches it/);
});

// ── distribution off ────────────────────────────────────────────────────────

test('with distribution off, a running conversation keeps its account, a new one goes to the target, and the cursor stays', () => {
  const am = fleet([oauth('a'), oauth('b'), oauth('t')]);
  assert.equal(route(am, 'running').name, 'a');
  logged(() => am.setSteer(indexOf(am, 't')));
  assert.equal(route(am, 'running').name, 'a');
  assert.deepEqual(route(am, 'fresh'), { name: 't', steered: true });
  assert.equal(route(am, 'fresh').name, 't', 'and stays there by its pin');
  assert.equal(am.accounts[am.currentIndex].name, 'a');
  // Where the steer cannot take a placement, the cursor walk does, as it
  // would unsteered: not the even picker, which distribution-off never runs.
  am.accounts[indexOf(am, 't')].quota.unified5h = 0.99;
  assert.equal(route(am, 'while-walled').name, 'a');
});

test('when a distribution-off steer ends, its conversations drain rather than snap to the cursor', () => {
  const am = fleet([oauth('a'), oauth('b'), oauth('t')]);
  route(am, 'running');
  logged(() => am.setSteer(indexOf(am, 't')));
  route(am, 'placed');
  logged(() => am.clearSteer());
  assert.equal(am.drainingCount(), 2);
  // The operator moves the cursor afterwards. Snapping would take both
  // conversations there; draining leaves each where its cache is.
  am.setCurrentAccount(indexOf(am, 'b'));
  assert.equal(route(am, 'placed').name, 't');
  assert.equal(route(am, 'running').name, 'a');
  assert.equal(route(am, 'after').name, 'b', 'a new conversation follows the cursor again');
});

test('a distributeSessions reload during a steer keeps affinity, and the end still drains', () => {
  const am = fleet([oauth('a'), oauth('b'), oauth('t')], { distributeSessions: true });
  const first = route(am, 'running').name;
  logged(() => am.setSteer(indexOf(am, 't')));
  am.setDistributeSessions(false);
  am.setCurrentAccount(indexOf(am, 'b'));
  assert.equal(route(am, 'running').name, first);
  assert.equal(route(am, 'fresh').name, 't');
  am.setDistributeSessions(false); // a second reload with it still off
  logged(() => am.clearSteer());
  assert.equal(route(am, 'fresh').name, 't');
  assert.equal(route(am, 'running').name, first);
  am.setDistributeSessions(true);
  assert.equal(am.drainingCount(), 0, 'turning distribution back on ends the drain, as it always has');
  assert.equal(route(am, 'fresh').name, 't', 'and the pins are honoured by distribution itself');
});

// ── --redeem ────────────────────────────────────────────────────────────────

test('--redeem lifts only its target\'s weekly thresholds, and only while the steer stands', () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const t = am.accounts[indexOf(am, 't')];
  am.accounts[indexOf(am, 'a')].quota.unified7d = 0.5;
  t.quota.unified7d = 0.99;
  assert.equal(route(am, 'unsteered').name, 'a', 'past its threshold, the target is out');
  logged(() => am.setSteer(t.index, { redeem: true }));
  for (const bucket of ['unified7d', 'unified7dFable', 'unified7dSonnet']) assert.equal(am.thresholdFor(bucket, t), 1, bucket);
  assert.equal(am.thresholdFor('unified5h', t), 0.98, 'the 5-hour wall is not relaxed');
  assert.equal(am.thresholdFor('unified7d', am.accounts[0]), 0.98, 'nor is anyone else\'s');
  assert.equal(route(am, 'steered').name, 't', 'it serves on toward upstream\'s own wall');
  logged(() => am.clearSteer());
  assert.equal(am.thresholdFor('unified7d', t), 0.98);
});

test('at upstream\'s weekly wall a --redeem steer redeems exactly once, then ends with the outcome', async () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const t = am.accounts[indexOf(am, 't')];
  /** @type {any[]} */
  const asked = [];
  am.setSteerRedeemer(async (account) => { asked.push(account); return { redeemed: true, reason: 'cleared seven_day' }; });
  logged(() => am.setSteer(t.index, { redeem: true }));
  t.quota.unified7d = 1;
  // A status read never starts it: that would be a GET sending an
  // irreversible POST upstream.
  logged(() => { am.getStatus(); am.steerList(); });
  const steer = am._steers.get('anthropic');
  assert.equal(steer?.phase, 'active');
  const lines = logged(() => {
    assert.equal(route(am, 'refused').name, 'a', 'the request that found the wall goes elsewhere at once');
    route(am, 'next');
    route(am, null);
  });
  assert.equal(steer?.phase, 'redeeming');
  await steer?.attempt;
  assert.deepEqual(asked, [t], 'one attempt, on the target');
  assert.match(lines.join('\n'), /its week is spent — redeeming its banked reset/);
  assert.deepEqual(am.steerList(), []);
});

test('an attempt that spent nothing for now leaves the steer armed, and asks again only after its back-off', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const target = am.accounts[indexOf(am, 't')];
  let asked = 0;
  am.setSteerRedeemer(async () => { asked++; return { redeemed: false, reason: 'not at a usage limit', outcome: 'not-now', retryAt: Date.now() + 30 * 60_000 }; });
  logged(() => am.setSteer(target.index, { redeem: true }));
  target.quota.unified7d = 1;
  logged(() => route(am, 'x'));
  const steer = am._steers.get('anthropic');
  const lines = await loggedAsync(async () => { await steer?.attempt; });
  assert.match(lines.join('\n'), /no reset was redeemed yet — not at a usage limit; the steer stays, and asks again in 30m/);
  assert.deepEqual(am.steerList().map(s => [s.target, s.redeeming, s.redeemRetryAt]), [['t', false, Date.now() + 30 * 60_000]]);

  logged(() => { route(am, 'y'); route(am, null); });
  assert.equal(asked, 1, 'not again inside the back-off');
  t.mock.timers.tick(30 * 60_000);
  logged(() => route(am, 'z'));
  assert.equal(am._steers.get('anthropic')?.phase, 'redeeming', 'asked again once it is over');
  await am._steers.get('anthropic')?.attempt;
  assert.equal(asked, 2);
});

test('an attempt ends the steer when it spent, may have spent, or found nothing to spend', async () => {
  for (const [r, want] of /** @type {Array<[any, RegExp]>} */ ([
    [{ redeemed: false, reason: 'holds no usable reset', outcome: 'nothing-held' }, /holds nothing to redeem: holds no usable reset/],
    [{ redeemed: false, reason: 'reset request failed (socket hang up)', outcome: 'unknown' }, /got no answer .*may have been spent — check the account/],
    [{ redeemed: false, reason: 'a redeemer that predates outcomes' }, /got no answer/],
  ])) {
    const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
    const target = am.accounts[indexOf(am, 't')];
    am.setSteerRedeemer(async () => r);
    logged(() => am.setSteer(target.index, { redeem: true }));
    target.quota.unified7d = 1;
    logged(() => route(am, 'x'));
    const steer = am._steers.get('anthropic');
    const lines = await loggedAsync(async () => { await steer?.attempt; });
    assert.match(lines.join('\n'), want, JSON.stringify(r));
    assert.deepEqual(am.steerList(), [], JSON.stringify(r));
  }
});

test('without --redeem the wall ends the steer and redeems nothing', () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const t = am.accounts[indexOf(am, 't')];
  let asked = 0;
  am.setSteerRedeemer(async () => { asked++; return { redeemed: true, reason: 'x' }; });
  logged(() => am.setSteer(t.index));
  t.quota.unified7d = 1;
  logged(() => { route(am, 'x'); route(am, 'y'); });
  assert.deepEqual(am.steerList(), []);
  assert.equal(asked, 0);
});

// ── review fixes ────────────────────────────────────────────────────────────

/** The headers of a refused request, as upstream sends them. */
const refusal = (/** @type {Record<string, string>} */ statuses, utilization = '0.999') => ({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-7d-utilization': utilization,
  ...statuses,
});

test('upstream\'s weekly refusal is the wall, whatever utilization it carries; a 5-hour or family refusal is not', async () => {
  for (const [label, headers, wall] of /** @type {Array<[string, Record<string, string>, boolean]>} */ ([
    ['weekly at 0.999', refusal({ 'anthropic-ratelimit-unified-7d-status': 'rejected' }), true],
    ['weekly, no utilization', { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-7d-status': 'rejected' }, true],
    ['5-hour only', refusal({ 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-7d-status': 'allowed' }), false],
    ['Fable only', refusal({ 'anthropic-ratelimit-unified-7d_oi-status': 'rejected', 'anthropic-ratelimit-unified-7d-status': 'allowed' }), false],
  ])) {
    const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
    const target = am.accounts[indexOf(am, 't')];
    let asked = 0;
    am.setSteerRedeemer(async () => { asked++; return { redeemed: true, reason: 'x', outcome: 'redeemed' }; });
    logged(() => am.setSteer(target.index, { redeem: true }));
    logged(() => { am.updateQuota(target.index, headers); am.markRateLimited(target.index, 600); });
    logged(() => route(am, 'failover'));
    await am._steers.get('anthropic')?.attempt;
    assert.equal(asked, wall ? 1 : 0, label);
    assert.equal(am.steerList().length, wall ? 0 : 1, label);
  }
});

test('without --redeem, upstream\'s weekly refusal ends the steer; a later allowed week clears the refusal', () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const target = am.accounts[indexOf(am, 't')];
  logged(() => am.updateQuota(target.index, refusal({ 'anthropic-ratelimit-unified-7d-status': 'rejected' }, '0.5')));
  assert.throws(() => am.setSteer(target.index), /already at its weekly switch threshold/);
  logged(() => am.updateQuota(target.index, { 'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
  logged(() => am.setSteer(target.index));
  logged(() => am.updateQuota(target.index, refusal({ 'anthropic-ratelimit-unified-7d-status': 'rejected' }, '0.5')));
  assert.match(logged(() => route(am, 'x')).join('\n'), /ended — upstream refused it on its weekly limit/);
});

test('a steer is written as mid-spend before its claim goes out, and a restart from there does not spend again', async () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const target = am.accounts[indexOf(am, 't')];
  /** @type {any[]} */
  let saved = [];
  am.onSteersChanged(async () => { saved = JSON.parse(JSON.stringify(am.exportSteers())); });
  /** @type {any[]} */
  let atClaim = [];
  am.setSteerRedeemer(async (_account, { beforeSpend }) => {
    assert.equal(await beforeSpend({ requestId: 'req-1' }), true);
    atClaim = saved; // what was on disk when the irreversible request went out
    return new Promise(() => {}); // the server stops before the answer
  });
  logged(() => am.setSteer(target.index, { redeem: true }));
  target.quota.unified7d = 1;
  logged(() => route(am, 'x'));
  while (!atClaim.length) await new Promise(r => setImmediate(r));
  assert.deepEqual(atClaim.map(r => [r.phase, r.redeemRequestId]), [['redeeming', 'req-1']]);

  const after = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  let asked = 0;
  after.setSteerRedeemer(async () => { asked++; return { redeemed: true, reason: 'x', outcome: 'redeemed' }; });
  const lines = logged(() => after.restoreSteers(atClaim));
  assert.match(lines.join('\n'), /"t" not restored — it was redeeming its banked reset when the server stopped, and the outcome of the redemption before the restart is unknown — check the account \(request id req-1\)/);
  after.accounts[1].quota.unified7d = 1;
  logged(() => route(after, 'y'));
  assert.deepEqual(after.steerList(), []);
  assert.equal(asked, 0, 'no second attempt after the restart');
});

test('a steer cleared during its attempt stops the spend at the last moment', async () => {
  const am = fleet([oauth('a'), oauth('t')], { distributeSessions: true });
  const target = am.accounts[indexOf(am, 't')];
  /** @type {boolean|null} */
  let answer = null;
  am.setSteerRedeemer(async (_account, { beforeSpend }) => {
    logged(() => am.clearSteer());
    answer = await beforeSpend({ requestId: 'req-2' });
    return { redeemed: false, reason: 'the steer ended before the reset was spent', outcome: 'cancelled' };
  });
  logged(() => am.setSteer(target.index, { redeem: true }));
  target.quota.unified7d = 1;
  const steer = am._steers.get('anthropic');
  logged(() => route(am, 'x'));
  await loggedAsync(async () => { await steer?.attempt; });
  assert.equal(answer, false);
  assert.deepEqual(am.steerList(), []);
});

test('a pin a steer placed on an outranked target is not preempted when the steer ends, with distribution on or off', () => {
  for (const distributeSessions of [true, false]) {
    const am = fleet([oauth('a'), oauth('t', { priority: 3 })], { distributeSessions });
    const t = indexOf(am, 't');
    logged(() => am.setSteer(t));
    assert.deepEqual(route(am, 'placed'), { name: 't', steered: true });
    assert.deepEqual(route(am, 'placed'), { name: 't', steered: false }, 'served by its pin, not placed again');
    logged(() => am.clearSteer());
    assert.equal(route(am, 'placed').name, 't', `no snap once the steer ends (distributeSessions ${distributeSessions})`);
    assert.equal(route(am, 'unsteered').name, 'a', 'priority still places what the steer did not');
    // It still moves when its account can no longer serve it, as every pin does.
    am.accounts[t].quota.unified5h = 0.99;
    assert.equal(route(am, 'placed').name, 'a');
  }
});

test('a plain steer replacing a --redeem one is judged against its own threshold', () => {
  const am = fleet([oauth('a'), oauth('t')]);
  const target = am.accounts[indexOf(am, 't')];
  target.quota.unified7d = 0.99;
  logged(() => am.setSteer(target.index, { redeem: true }));
  assert.equal(am.thresholdFor('unified7d', target), 1, 'lifted by the steer standing');
  assert.throws(() => am.setSteer(target.index), /already at its weekly switch threshold/);
  assert.equal(am.steerList()[0].redeem, true, 'the refused replacement left the old steer alone');
});

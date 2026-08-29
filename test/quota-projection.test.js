import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaProjection, formatProjection } from '../src/quota-projection.js';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

// Feed `steps` evenly spaced samples rising by `perStep` utilization each.
function burn(qp, bucket, { from = 0, perStep, steps, everyMs = MIN, start = T0, account = 0 }) {
  for (let i = 0; i <= steps; i++) {
    qp.record(account, bucket, from + perStep * i, start + everyMs * i);
  }
  return start + everyMs * steps;
}

test('no rate until the samples span the minimum interval', () => {
  const qp = new QuotaProjection();
  qp.record(0, 'unified7d', 0.10, T0);
  qp.record(0, 'unified7d', 0.12, T0 + 2 * MIN);
  assert.equal(qp.rate(0, 'unified7d'), null);
});

test('computes a rate once the samples span the minimum interval', () => {
  const qp = new QuotaProjection();
  // 0.01 utilization per minute for ten minutes.
  burn(qp, 'unified7d', { from: 0.10, perStep: 0.01, steps: 10 });
  const rate = qp.rate(0, 'unified7d');
  assert.ok(rate != null, 'expected a rate');
  // Per millisecond, so 0.01 / 60000.
  assert.ok(Math.abs(rate - 0.01 / MIN) < 1e-12, `rate was ${rate}`);
});

test('a null reading clears the bucket history so a reset is not a negative burn', () => {
  const qp = new QuotaProjection();
  const end = burn(qp, 'unified7d', { from: 0.90, perStep: 0.01, steps: 10 });
  assert.ok(qp.rate(0, 'unified7d') != null);
  // _clearExpiredQuotas sets the bucket to null exactly when the window rolls.
  qp.record(0, 'unified7d', null, end + MIN);
  qp.record(0, 'unified7d', 0.01, end + 2 * MIN);
  assert.equal(qp.rate(0, 'unified7d'), null, 'history should restart after a roll');
});

test('flat utilization reports no rate', () => {
  const qp = new QuotaProjection();
  burn(qp, 'unified7d', { from: 0.42, perStep: 0, steps: 10 });
  assert.equal(qp.rate(0, 'unified7d'), null);
});

test('samples older than the window are dropped', () => {
  const qp = new QuotaProjection({ windowMinutes: 30 });
  // A fast early burst, then a slow later one. Only the later one is in window.
  burn(qp, 'unified7d', { from: 0, perStep: 0.05, steps: 10 });
  const late = T0 + 60 * MIN;
  burn(qp, 'unified7d', { from: 0.50, perStep: 0.001, steps: 10, start: late });
  const rate = qp.rate(0, 'unified7d');
  assert.ok(Math.abs(rate - 0.001 / MIN) < 1e-12, `stale samples leaked in: ${rate}`);
});

test('projects a deficit when the bucket exhausts before its reset', () => {
  const qp = new QuotaProjection();
  const end = burn(qp, 'unified5h', { from: 0.50, perStep: 0.01, steps: 10 });
  // At 0.60 used and 0.01/min, the remaining 0.40 lasts 40 minutes.
  const p = qp.project(0, 'unified5h', { utilization: 0.60, resetAt: end + 5 * 60 * MIN, now: end });
  assert.equal(p.kind, 'deficit');
  assert.ok(Math.abs(p.exhaustsInMs - 40 * MIN) < MIN / 10, `exhaustsInMs was ${p.exhaustsInMs}`);
});

test('projects a surplus when the reset arrives first', () => {
  const qp = new QuotaProjection();
  const end = burn(qp, 'unified7d', { from: 0.20, perStep: 0.001, steps: 10 });
  // 0.001/min leaves 0.06 spent over the next hour, so 0.73 of the window expires.
  const p = qp.project(0, 'unified7d', { utilization: 0.21, resetAt: end + 60 * MIN, now: end });
  assert.equal(p.kind, 'surplus');
  assert.ok(Math.abs(p.unspent - 0.73) < 0.01, `unspent was ${p.unspent}`);
});

test('a surplus below the waste floor is not reported', () => {
  const qp = new QuotaProjection({ wasteFloor: 0.10 });
  const end = burn(qp, 'unified7d', { from: 0.20, perStep: 0.01, steps: 10 });
  // 0.01/min over an hour spends 0.60, leaving 0.10 of headroom unspent... just
  // under the floor once the floor is exclusive.
  const p = qp.project(0, 'unified7d', { utilization: 0.31, resetAt: end + 60 * MIN, now: end });
  assert.equal(p, null);
});

test('the session bucket never reports a surplus', () => {
  const qp = new QuotaProjection();
  const end = burn(qp, 'unified5h', { from: 0.05, perStep: 0.001, steps: 10 });
  const p = qp.project(0, 'unified5h', { utilization: 0.06, resetAt: end + 60 * MIN, now: end });
  assert.equal(p, null, 'a 5h window refills the same day, so its tail is not worth reporting');
});

test('utilization at or above 1 reports an immediate deficit', () => {
  const qp = new QuotaProjection();
  const end = burn(qp, 'unified7dFable', { from: 0.90, perStep: 0.02, steps: 10 });
  const p = qp.project(0, 'unified7dFable', { utilization: 1, resetAt: end + 60 * MIN, now: end });
  assert.equal(p.kind, 'deficit');
  assert.equal(p.exhaustsInMs, 0);
});

test('no rate means no projection', () => {
  const qp = new QuotaProjection();
  qp.record(0, 'unified7d', 0.5, T0);
  const p = qp.project(0, 'unified7d', { utilization: 0.5, resetAt: T0 + 60 * MIN, now: T0 });
  assert.equal(p, null);
});

test('a deficit outranks a surplus in the headline', () => {
  const qp = new QuotaProjection();
  const deficit = { bucket: 'unified5h', kind: 'deficit', exhaustsInMs: 90 * MIN };
  const surplus = { bucket: 'unified7d', kind: 'surplus', unspent: 0.80 };
  assert.equal(qp.headline([surplus, deficit]).bucket, 'unified5h');
});

test('the soonest deficit wins among deficits', () => {
  const qp = new QuotaProjection();
  const near = { bucket: 'unified5h', kind: 'deficit', exhaustsInMs: 10 * MIN };
  const far = { bucket: 'unified7d', kind: 'deficit', exhaustsInMs: 100 * MIN };
  assert.equal(qp.headline([far, near]).bucket, 'unified5h');
});

test('the largest unspent fraction wins among surpluses', () => {
  const qp = new QuotaProjection();
  const small = { bucket: 'unified7dFable', kind: 'surplus', unspent: 0.20 };
  const large = { bucket: 'unified7d', kind: 'surplus', unspent: 0.60 };
  assert.equal(qp.headline([small, large]).bucket, 'unified7d');
});

test('headline of nothing is null', () => {
  const qp = new QuotaProjection();
  assert.equal(qp.headline([]), null);
  assert.equal(qp.headline([null, null]), null);
});

test('disabled projection records nothing and projects nothing', () => {
  const qp = new QuotaProjection({ enabled: false });
  const end = burn(qp, 'unified7d', { from: 0.10, perStep: 0.01, steps: 10 });
  assert.equal(qp.rate(0, 'unified7d'), null);
  assert.equal(qp.project(0, 'unified7d', { utilization: 0.20, resetAt: end + MIN, now: end }), null);
});

test('accounts and buckets are tracked independently', () => {
  const qp = new QuotaProjection();
  burn(qp, 'unified7d', { from: 0.10, perStep: 0.01, steps: 10, account: 0 });
  burn(qp, 'unified7d', { from: 0.10, perStep: 0.002, steps: 10, account: 1 });
  const a = qp.rate(0, 'unified7d');
  const b = qp.rate(1, 'unified7d');
  assert.ok(a > b * 4, `expected account 0 to burn faster: ${a} vs ${b}`);
  assert.equal(qp.rate(0, 'unified5h'), null);
});

test('formats a deficit as the time left', () => {
  assert.equal(formatProjection({ bucket: 'unified5h', kind: 'deficit', exhaustsInMs: 38 * MIN }), 'Ses TTL 38m');
});

test('formats a surplus as an unspent fraction', () => {
  assert.equal(formatProjection({ bucket: 'unified7d', kind: 'surplus', unspent: 0.22 }), 'Wk 22% unspent');
});

test('formats the family weekly buckets with their row labels', () => {
  assert.equal(formatProjection({ bucket: 'unified7dFable', kind: 'surplus', unspent: 0.5 }), 'F7 50% unspent');
  assert.equal(formatProjection({ bucket: 'unified7dSonnet', kind: 'deficit', exhaustsInMs: 2 * 60 * MIN }), 'S7 TTL 2h0m');
});

test('a drop in utilization restarts the history', () => {
  const qp = new QuotaProjection();
  const end = burn(qp, 'unified7d', { from: 0.90, perStep: 0.01, steps: 10 });
  // A probe can report the fresh window before _clearExpiredQuotas nulls the
  // bucket, so the roll arrives as a decrease rather than a null.
  burn(qp, 'unified7d', { from: 0.01, perStep: 0.001, steps: 10, start: end + MIN });
  const rate = qp.rate(0, 'unified7d');
  assert.ok(Math.abs(rate - 0.001 / MIN) < 1e-12, `pre-roll samples leaked in: ${rate}`);
});

// --- AccountManager wiring -------------------------------------------------

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

function mgr(names, opts = {}) {
  return new AccountManager(names.map(oauth), 0.98, opts);
}

// Seed `minutes` of steady burn ending now, so project() sees a usable rate.
function seed(am, index, bucket, { from, perStep, minutes = 10, now = Date.now() }) {
  for (let i = 0; i <= minutes; i++) {
    am.projection.record(index, bucket, from + perStep * i, now - (minutes - i) * MIN);
  }
}

test('updateQuota records a sample for every reported bucket', () => {
  const am = mgr(['a']);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.20',
    'anthropic-ratelimit-unified-7d-utilization': '0.40',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.60',
  });
  assert.equal(am.projection.samples.get('0:unified5h')?.length, 1);
  assert.equal(am.projection.samples.get('0:unified7d')?.length, 1);
  assert.equal(am.projection.samples.get('0:unified7dFable')?.length, 1);
});

test('applyUsageData records samples from a probe', () => {
  const am = mgr(['a']);
  am.applyUsageData(0, {
    fiveHour: { utilization: 0.2, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.4, resetAt: Date.now() + 86_400_000 },
  });
  assert.equal(am.projection.samples.get('0:unified5h')?.length, 1);
  assert.equal(am.projection.samples.get('0:unified7d')?.length, 1);
});

test('getStatus reports a headline and per-bucket projections', () => {
  const now = Date.now();
  const am = mgr(['a']);
  seed(am, 0, 'unified7d', { from: 0.10, perStep: 0.001 });
  am.accounts[0].quota.unified7d = 0.11;
  am.accounts[0].quota.unified7dReset = now + 60 * MIN;
  const account = am.getStatus().accounts[0];
  assert.equal(account.projection.headline.bucket, 'unified7d');
  assert.equal(account.projection.headline.kind, 'surplus');
  assert.ok(account.projection.buckets.unified7d);
});

test('getStatus reports a null headline when nothing can be projected', () => {
  const am = mgr(['a']);
  assert.equal(am.getStatus().accounts[0].projection.headline, null);
});

test('projection disabled by config records nothing', () => {
  const am = mgr(['a'], { projection: { enabled: false } });
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.40' });
  assert.equal(am.projection.samples.size, 0);
});

test('setProjection applies a config change live', () => {
  const am = mgr(['a'], { projection: { enabled: false } });
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.40' });
  assert.equal(am.projection.samples.size, 0);
  am.setProjection({ enabled: true, windowMinutes: 15, wasteFloor: 0.2 });
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.41' });
  assert.equal(am.projection.samples.get('0:unified7d')?.length, 1);
  assert.equal(am.getStatus().projection.windowMinutes, 15);
  assert.equal(am.getStatus().projection.wasteFloor, 0.2);
});

// --- TUI row tag -----------------------------------------------------------

function tuiFor(am) {
  const tui = new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: [], routes: [] },
    sx: null,
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
    probeQuota: () => {},
  });
  tui.render = () => {};
  return tui;
}

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('the account row carries the headline projection', () => {
  const now = Date.now();
  const am = mgr(['a']);
  seed(am, 0, 'unified7d', { from: 0.10, perStep: 0.001, now });
  am.accounts[0].quota.unified7d = 0.11;
  am.accounts[0].quota.unified7dReset = now + 60 * MIN;
  const row = plain(tuiFor(am)._renderAcct(0, 10, true));
  assert.match(row, /Wk \d+% unspent/);
});

test('the account row carries no tag when nothing can be projected', () => {
  const am = mgr(['a']);
  const row = plain(tuiFor(am)._renderAcct(0, 10, true));
  assert.doesNotMatch(row, /unspent|TTL/);
});

test('every projected bucket is shown, deficits first', () => {
  const now = Date.now();
  const am = mgr(['a']);
  seed(am, 0, 'unified5h', { from: 0.50, perStep: 0.01, now });
  seed(am, 0, 'unified7d', { from: 0.10, perStep: 0.001, now });
  const q = am.accounts[0].quota;
  q.unified5h = 0.60;
  q.unified5hReset = now + 5 * 60 * MIN;
  q.unified7d = 0.11;
  q.unified7dReset = now + 60 * MIN;
  const row = plain(tuiFor(am)._renderAcct(0, 10, true));
  assert.match(row, /Ses TTL \d+m/);
  // Both buckets are reported, and the one that will stop the account is first.
  assert.match(row, /Wk \d+% unspent/);
  // 'Wk' also labels a bar, so compare against the tag itself.
  assert.ok(row.indexOf('Ses TTL') < row.indexOf('% unspent'), row);
  assert.match(row, / · /);
});

test('the row renders against a manager without projection support', () => {
  const am = mgr(['a']);
  delete am.projectionsFor;
  assert.doesNotThrow(() => tuiFor(am)._renderAcct(0, 10, true));
});

test('rank orders deficits by urgency, then surpluses by waste', () => {
  const qp = new QuotaProjection();
  const slowDeficit = { bucket: 'unified7d', kind: 'deficit', exhaustsInMs: 100 * MIN };
  const fastDeficit = { bucket: 'unified5h', kind: 'deficit', exhaustsInMs: 10 * MIN };
  const smallWaste = { bucket: 'unified7dSonnet', kind: 'surplus', unspent: 0.2 };
  const bigWaste = { bucket: 'unified7dFable', kind: 'surplus', unspent: 0.6 };
  const order = qp.rank([smallWaste, slowDeficit, bigWaste, fastDeficit]).map(p => p.bucket);
  assert.deepEqual(order, ['unified5h', 'unified7d', 'unified7dFable', 'unified7dSonnet']);
});

test('rank drops empty entries and headline stays its first result', () => {
  const qp = new QuotaProjection();
  const only = { bucket: 'unified7d', kind: 'surplus', unspent: 0.5 };
  assert.deepEqual(qp.rank([null, only, undefined]), [only]);
  assert.equal(qp.headline([null, only]), only);
  assert.deepEqual(qp.rank([]), []);
});

test('the default sampling window is wide enough for a slow weekly burn', () => {
  // Utilization is quantised to whole percent, so a short window can contain no
  // step at all. 90 minutes keeps a 1%/h burn readable.
  const qp = new QuotaProjection();
  assert.equal(qp.settings().windowMinutes, 90);
});

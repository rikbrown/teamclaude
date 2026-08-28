import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const HOUR = 3600_000;
const now = Date.now();

// Accounts get a future governing weekly reset so _clearExpiredQuotas leaves
// them alone for the duration of the test run.
function setWeekly(am, idx, hoursFromNow) {
  am.accounts[idx].quota.unified7dReset = now + hoursFromNow * HOUR;
}

function setFableWeekly(am, idx, hoursFromNow) {
  am.accounts[idx].quota.unified7dFableReset = now + hoursFromNow * HOUR;
}

function mgr(names, opts = {}) {
  return new AccountManager(names.map((n) => oauth(n)), 0.98, opts);
}

test('disabled (default): an equal-priority sooner-resetting account does not preempt', () => {
  const am = mgr(['a', 'b']);
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  am.currentIndex = 1; // sticky on the later-resetting account
  assert.equal(am.getActiveAccount().name, 'b');
});

test('enabled: preempts the current account for one whose weekly resets more than poolHours sooner', () => {
  const am = mgr(['a', 'b'], { soonestWeekly: { enabled: true, poolHours: 12 } });
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'a');
});

test('enabled: no preemption within poolHours (stickiness and cache preserved)', () => {
  const am = mgr(['a', 'b'], { soonestWeekly: { enabled: true, poolHours: 12 } });
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 30); // 6h apart — inside the 12h pool
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('enabled: an account with an unknown weekly reset never preempts', () => {
  const am = mgr(['a', 'b'], { soonestWeekly: { enabled: true, poolHours: 12 } });
  setWeekly(am, 1, 100); // 'a' quota still unknown
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('enabled: a current account with an unknown weekly reset is not preempted (still probing)', () => {
  const am = mgr(['a', 'b'], { soonestWeekly: { enabled: true, poolHours: 12 } });
  setWeekly(am, 0, 24); // current 'b' unknown
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('enabled: priority still outranks a sooner weekly reset', () => {
  const am = new AccountManager([
    oauth('a', { priority: 1 }), // sooner reset, lower rank
    oauth('b', { priority: 0 }),
  ], 0.98, { soonestWeekly: { enabled: true, poolHours: 12 } });
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('enabled: preemption ranks by the bucket governing the requested model', () => {
  const am = mgr(['a', 'b'], { soonestWeekly: { enabled: true, poolHours: 12 } });
  // Shared weekly: 'a' sooner. Fable weekly: 'b' sooner.
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  setFableWeekly(am, 0, 100);
  setFableWeekly(am, 1, 24);
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'a');
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'b');
});

test('enabled + distributeSessions: new sessions balance only within the pool', () => {
  const am = mgr(['a', 'b', 'c'], {
    soonestWeekly: { enabled: true, poolHours: 12 },
    distributeSessions: true,
  });
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 30);  // within 12h of 'a' — in the pool
  setWeekly(am, 2, 150); // out of the pool
  const seen = [];
  for (const sid of ['s1', 's2', 's3', 's4']) {
    const acc = am.getActiveAccount(null, null, null, sid);
    am.recordSession(sid, acc.index);
    seen.push(acc.name);
  }
  // Four sessions spread across the two pool accounts; 'c' serves none.
  assert.ok(!seen.includes('c'), `expected no session on c, got ${seen}`);
  assert.deepEqual([...new Set(seen)].sort(), ['a', 'b']);
});

test('enabled + distributeSessions: a session pinned outside the pool re-routes into it', () => {
  const am = mgr(['a', 'b'], {
    soonestWeekly: { enabled: true, poolHours: 12 },
    distributeSessions: true,
  });
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  am.recordSession('s1', 1); // pinned to the later-resetting account
  assert.equal(am.getActiveAccount(null, null, null, 's1').name, 'a');
});

test('eligibility names the sooner-resetting preemptor', () => {
  const am = mgr(['a', 'b'], { soonestWeekly: { enabled: true, poolHours: 12 } });
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  const r = am.eligibility(1);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /"a".*resets sooner/);
});

test('setSoonestWeekly applies a config change live', () => {
  const am = mgr(['a', 'b']);
  setWeekly(am, 0, 24);
  setWeekly(am, 1, 100);
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'b');
  am.setSoonestWeekly({ enabled: true, poolHours: 12 });
  assert.equal(am.getActiveAccount().name, 'a');
  am.setSoonestWeekly(undefined); // reload with the field removed disables it
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount().name, 'b');
});

test('getStatus reports the mode', () => {
  const am = mgr(['a'], { soonestWeekly: { enabled: true, poolHours: 6 } });
  assert.deepEqual(am.getStatus().soonestWeekly, { enabled: true, poolHours: 6 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { fleetAggregate } from '../src/quota-summary.js';

function oauth(name, tier = {}) {
  return { name, type: 'oauth', accessToken: `token-${name}`, ...tier };
}

test('AccountManager exposes a quota summary for status clients', () => {
  const am = new AccountManager([], 0.98);

  assert.equal(typeof am.getQuotaSummary, 'function');
});

test('quota summary classifies supported subscription and Team seat tiers', () => {
  const am = new AccountManager([
    oauth('pro', { rateLimitTier: 'default_claude_ai', organizationType: 'claude_pro' }),
    oauth('max-5', { rateLimitTier: 'default_claude_max_x5' }),
    oauth('max-20', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('team-standard', { rateLimitTier: 'default_raven', seatTier: 'team_standard' }),
    oauth('team-tier-1', { rateLimitTier: 'default_raven', seatTier: 'team_tier_1' }),
    oauth('team-tier-2', { rateLimitTier: 'default_raven', seatTier: 'team_tier_2' }),
    oauth('future-tier', { rateLimitTier: 'default_heron', seatTier: 'team_tier_9' }),
  ], 0.98);

  const summary = am.getQuotaSummary();
  assert.deepEqual(
    summary.accounts?.map(account => [account.name, account.tier.weight]),
    [
      ['pro', 1],
      ['max-5', 5],
      ['max-20', 20],
      ['team-standard', 1],
      ['team-tier-1', 5],
      ['team-tier-2', 20],
      ['future-tier', null],
    ],
  );
  assert.deepEqual(summary.unknownTiers, [{
    name: 'future-tier',
    rateLimitTier: 'default_heron',
    seatTier: 'team_tier_9',
  }]);
});

test('quota summary returns per-account buckets and tier-weighted fleet totals', () => {
  const am = new AccountManager([
    oauth('pro', { rateLimitTier: 'default_claude_ai' }),
    oauth('max-5', { rateLimitTier: 'default_claude_max_5x' }),
    oauth('unknown', { rateLimitTier: 'default_heron' }),
  ], 0.98);
  const resetPro = Date.now() + 3_600_000;
  const resetMax = Date.now() + 7_200_000;
  Object.assign(am.accounts[0].quota, {
    unified5h: 0.2, unified5hReset: resetPro,
    unified7d: 0.4, unified7dReset: resetPro,
    unified7dSonnet: 0.6, unified7dSonnetReset: resetMax,
  });
  Object.assign(am.accounts[1].quota, {
    unified5h: 0.8, unified5hReset: resetMax,
    unified7d: 0.2, unified7dReset: resetMax,
    unified7dFable: 0.5, unified7dFableReset: resetPro,
  });
  Object.assign(am.accounts[2].quota, {
    unified5h: 0, unified5hReset: resetPro,
    unified7d: 0, unified7dReset: resetPro,
  });

  const summary = am.getQuotaSummary();
  assert.deepEqual(summary.accounts[0].buckets, {
    fiveHour: { utilization: 0.2, remaining: 0.8, resetAt: resetPro, source: 'unified5h' },
    weeklyShared: { utilization: 0.4, remaining: 0.6, resetAt: resetPro, source: 'unified7d' },
    weeklySonnet: { utilization: 0.6, remaining: 0.4, resetAt: resetMax, source: 'unified7dSonnet' },
    weeklyFable: { utilization: 0.4, remaining: 0.6, resetAt: resetPro, source: 'unified7d' },
  });
  assert.deepEqual(summary.accounts[1].buckets.weeklySonnet, {
    utilization: 0.2, remaining: 0.8, resetAt: resetMax, source: 'unified7d',
  });

  assert.deepEqual(summary.aggregate.fiveHour, {
    capacityWeight: 6,
    usedWeight: 4.2,
    remainingWeight: 1.8,
    utilization: 0.7,
    remaining: 0.3,
    knownAccounts: 2,
    nextResetAt: resetPro,
  });
  assert.deepEqual(summary.aggregate.weeklyShared, {
    capacityWeight: 6,
    usedWeight: 1.4,
    remainingWeight: 4.6,
    utilization: 0.233333333333,
    remaining: 0.766666666667,
    knownAccounts: 2,
    nextResetAt: resetPro,
  });
  assert.deepEqual(summary.aggregate.weeklySonnet, {
    capacityWeight: 6,
    usedWeight: 1.6,
    remainingWeight: 4.4,
    utilization: 0.266666666667,
    remaining: 0.733333333333,
    knownAccounts: 2,
    nextResetAt: resetMax,
  });
  assert.deepEqual(summary.aggregate.weeklyFable, {
    capacityWeight: 6,
    usedWeight: 2.9,
    remainingWeight: 3.1,
    utilization: 0.483333333333,
    remaining: 0.516666666667,
    knownAccounts: 2,
    nextResetAt: resetPro,
  });
});

test('quota summary keeps API-key limits per account without mixing their units into subscription aggregates', () => {
  const am = new AccountManager([
    oauth('subscription', { rateLimitTier: 'default_claude_ai' }),
    { name: 'api', type: 'apikey', apiKey: 'sk-test' },
  ], 0.98);
  Object.assign(am.accounts[0].quota, { unified5h: 0.5, unified7d: 0.25 });
  Object.assign(am.accounts[1].quota, {
    tokensLimit: 1000, tokensRemaining: 250,
    requestsLimit: 100, requestsRemaining: 40,
    resetsAt: 1_900_000_000_000,
  });

  const summary = am.getQuotaSummary();
  const api = summary.accounts.find(account => account.name === 'api');
  assert.ok(api);
  assert.deepEqual(api.buckets.tokens, {
    utilization: 0.75, remaining: 0.25, resetAt: 1_900_000_000_000, source: 'tokens',
    limit: 1000, remainingAmount: 250,
  });
  assert.deepEqual(api.buckets.requests, {
    utilization: 0.6, remaining: 0.4, resetAt: 1_900_000_000_000, source: 'requests',
    limit: 100, remainingAmount: 40,
  });
  assert.equal(summary.aggregate.fiveHour.capacityWeight, 1);
  assert.deepEqual(summary.unknownTiers, []);
});

test('quota summary does not report an expired cached window', () => {
  const am = new AccountManager([oauth('pro', { rateLimitTier: 'default_claude_ai' })], 0.98);
  Object.assign(am.accounts[0].quota, { unified5h: 0.9, unified5hReset: Date.now() - 1 });

  const summary = am.getQuotaSummary();

  assert.equal(summary.accounts[0].buckets.fiveHour, null);
  assert.equal(summary.aggregate.fiveHour, null);
});

// ── Fleet aggregate ─────────────────────────────────────────────────────────
//
// A different question from the aggregate above, and the tests are separate for
// the same reason the functions are: this one measures what the fleet can still
// SPEND, against the thresholds and caps rotation actually enforces, per
// provider pool. Driven through fleetAggregate directly rather than through a
// manager, because both dashboards call it with plain account-shaped objects
// (the attached one's come off a status payload).

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** An account as either dashboard holds one: manager record or status row. */
function seat(name, over = {}) {
  return { name, type: 'oauth', quota: {}, ...over };
}

/** The pool for `provider`, or undefined when no such block was produced. */
const pool = (groups, provider) => groups.find(g => g.provider === provider);

test('fleet aggregate weights a pool by subscription size', () => {
  // A 20x seat and a Pro seat, both half spent. The pool is not "50% used": the
  // big seat holds twenty times the quota, so it decides almost all of it.
  const groups = fleetAggregate([
    seat('max20', { rateLimitTier: 'default_claude_max_20x', quota: { unified5h: 0.5 } }),
    seat('pro', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0 } }),
  ], { thresholdFor: () => 1, now: NOW });

  const anthropic = pool(groups, 'anthropic');
  assert.equal(anthropic.counted, 2);
  // 20 × 0.5 spent of 21 spendable.
  assert.equal(anthropic.buckets.unified5h.spentWeight, 10);
  assert.equal(anthropic.buckets.unified5h.capacityWeight, 21);
  assert.ok(Math.abs(anthropic.buckets.unified5h.utilization - 10 / 21) < 1e-9);
});

test('a disabled seat is out of the pool, not sitting in it at its last reading', () => {
  const accounts = [
    seat('live', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } }),
    seat('off', { rateLimitTier: 'default_claude_max_20x', disabled: true, quota: { unified7d: 0 } }),
  ];
  const anthropic = pool(fleetAggregate(accounts, { thresholdFor: () => 1, now: NOW }), 'anthropic');

  // The disabled 20x seat would otherwise dominate and report the fleet nearly
  // empty — quota that is real but unspendable.
  assert.equal(anthropic.total, 1, 'a disabled seat is not even in the tally');
  assert.equal(anthropic.counted, 1);
  assert.equal(anthropic.buckets.unified7d.capacityWeight, 1);
  assert.equal(anthropic.buckets.unified7d.utilization, 0.5);
});

test('a local backend is not a seat and never reaches the tally', () => {
  // A conduit is a translating proxy in front of another vendor: no
  // subscription, a placeholder token, no quota of its own. Counted as an
  // unpriced seat it would read as one the fleet is missing, which is exactly
  // what that tally is for saying. The account table already keeps it out of
  // the rows for the same reason.
  const groups = fleetAggregate([
    seat('real', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } }),
    seat('kimi', { upstream: 'http://127.0.0.1:18789', quota: { unified7d: 0.9 } }),
  ], { thresholdFor: () => 1, now: NOW });

  const anthropic = pool(groups, 'anthropic');
  assert.equal(anthropic.total, 1, 'the conduit is not one of the seats');
  assert.equal(anthropic.counted, 1, 'and so cannot read as an uncounted one');
  assert.equal(anthropic.buckets.unified7d.utilization, 0.5, 'its borrowed quota stays out of the pool');
});

test('an Anthropic seat on an unrecognised tier is excluded but still counted', () => {
  const groups = fleetAggregate([
    seat('known', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.5 } }),
    seat('future', { rateLimitTier: 'default_heron', seatTier: 'team_tier_9', quota: { unified5h: 1 } }),
  ], { thresholdFor: () => 1, now: NOW });

  const anthropic = pool(groups, 'anthropic');
  assert.equal(anthropic.total, 2);
  assert.equal(anthropic.counted, 1, 'the unknown tier is not priced as a Pro seat');
  assert.equal(anthropic.buckets.unified5h.capacityWeight, 1);
  assert.equal(anthropic.buckets.unified5h.utilization, 0.5);
});

test('Codex seats weigh one each and never merge with the Anthropic pool', () => {
  const groups = fleetAggregate([
    seat('claude', { rateLimitTier: 'default_claude_max_20x', quota: { unified5h: 0.1, unified7d: 0.1 } }),
    seat('gpt-a', { provider: 'codex', quota: { unified5h: 0.5, unified7d: 0.5 } }),
    seat('gpt-b', { provider: 'codex', quota: { unified5h: 0.9, unified7d: 0.9 } }),
  ], { thresholdFor: () => 1, now: NOW });

  assert.deepEqual(groups.map(g => g.provider), ['anthropic', 'codex']);
  // No ChatGPT tier exists to read, so a seat is a seat: two of them.
  assert.equal(pool(groups, 'codex').buckets.unified5h.capacityWeight, 2);
  assert.equal(pool(groups, 'codex').buckets.unified5h.utilization, 0.7);
  // The 20x Anthropic seat is untouched by the Codex readings beside it.
  assert.equal(pool(groups, 'anthropic').buckets.unified5h.utilization, 0.1);
  // Codex publishes a session and a weekly window and nothing else.
  assert.deepEqual(Object.keys(pool(groups, 'codex').buckets), ['unified5h', 'unified7d']);
  assert.deepEqual(
    Object.keys(pool(groups, 'anthropic').buckets),
    ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable'],
  );
});

test('headroom is measured against the threshold rotation actually stops at', () => {
  // One Pro seat at 49% with a 98% threshold is halfway through what it will be
  // allowed to spend, not halfway through the window.
  const anthropic = pool(fleetAggregate([
    seat('pro', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.49 } }),
  ], { thresholdFor: () => 0.98, now: NOW }), 'anthropic');

  assert.equal(anthropic.buckets.unified7d.capacityWeight, 0.98);
  assert.equal(anthropic.buckets.unified7d.utilization, 0.5);
});

test('a per-account cap is the harder ceiling and lowers that seat alone', () => {
  const groups = fleetAggregate([
    seat('capped', { rateLimitTier: 'default_claude_ai', maxUsage: { unified7d: 0.5 }, quota: { unified7d: 0.25 } }),
    seat('free', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.25 } }),
  ], { thresholdFor: () => 1, now: NOW });

  const weekly = pool(groups, 'anthropic').buckets.unified7d;
  // Spendable is 0.5 + 1, spent is 0.25 + 0.25.
  assert.equal(weekly.capacityWeight, 1.5);
  assert.equal(weekly.spentWeight, 0.5);
  assert.ok(Math.abs(weekly.utilization - 1 / 3) < 1e-9);
  // The cap does not reach the 5h bucket it was not written for.
  assert.equal(pool(groups, 'anthropic').buckets.unified5h, null);
});

test('the aggregate reads 100% exactly when rotation would refuse every seat', () => {
  const anthropic = pool(fleetAggregate([
    seat('a', { rateLimitTier: 'default_claude_max_20x', quota: { unified7d: 0.98 } }),
    // Past its own cap, and past it by more than the threshold would allow: the
    // overshoot must not push the pool over 100% and drown the seat beside it.
    seat('b', { rateLimitTier: 'default_claude_ai', maxUsage: 0.6, quota: { unified7d: 1.04 } }),
  ], { thresholdFor: () => 0.98, now: NOW }), 'anthropic');

  assert.equal(anthropic.buckets.unified7d.utilization, 1);
  assert.equal(anthropic.buckets.unified7d.remaining, 0);
});

test('a bucket nothing reports is null rather than an empty bar', () => {
  const anthropic = pool(fleetAggregate([
    seat('pro', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.2 } }),
  ], { thresholdFor: () => 0.98, now: NOW }), 'anthropic');

  assert.ok(anthropic.buckets.unified5h);
  assert.equal(anthropic.buckets.unified7d, null);
  assert.equal(anthropic.buckets.unified7dFable, null);
});

test('the reset reported is the soonest one still ahead', () => {
  const anthropic = pool(fleetAggregate([
    seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.2, unified5hReset: NOW + 4 * HOUR } }),
    seat('b', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.2, unified5hReset: NOW + HOUR } }),
    // Already past: the sweep has not caught up with it, and it must not win
    // "soonest" and freeze the countdown on a dead timestamp.
    seat('c', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.2, unified5hReset: NOW - HOUR } }),
  ], { thresholdFor: () => 0.98, now: NOW }), 'anthropic');

  assert.equal(anthropic.buckets.unified5h.nextResetAt, NOW + HOUR);
  assert.equal(anthropic.buckets.unified5h.knownAccounts, 3);
});

test('a pool whose seats cannot be weighed still reports itself', () => {
  const groups = fleetAggregate([
    seat('api', { type: 'apikey', quota: { tokensLimit: 10, tokensRemaining: 5 } }),
  ], { thresholdFor: () => 0.98, now: NOW });

  // Told rather than hidden: a pool that vanished would read as a config error.
  assert.equal(groups.length, 1);
  assert.equal(groups[0].total, 1);
  assert.equal(groups[0].counted, 0);
  assert.deepEqual(Object.values(groups[0].buckets), [null, null, null, null]);
});

test('a pool with nothing but disabled seats is not reported at all', () => {
  const groups = fleetAggregate([
    seat('off', { provider: 'codex', disabled: true, quota: { unified5h: 0.5 } }),
    seat('on', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.5 } }),
  ], { thresholdFor: () => 0.98, now: NOW });

  assert.deepEqual(groups.map(g => g.provider), ['anthropic']);
});

test('the fleet aggregate takes the tier the wire carried when there is one', () => {
  // An account off a status payload has no rateLimitTier — the payload sends the
  // resolved `tier` instead — so without this the attached dashboard would count
  // no seats at all.
  const anthropic = pool(fleetAggregate([
    { name: 'remote', tier: { rateLimitTier: 'default_claude_max_20x', seatTier: null, weight: 20 }, quota: { unified5h: 0.5 } },
    // A weight off a socket is validated, not trusted: it is about to be
    // multiplied into a total.
    { name: 'hostile', tier: { weight: 'lots' }, quota: { unified5h: 0.5 } },
  ], { thresholdFor: () => 1, now: NOW }), 'anthropic');

  assert.equal(anthropic.counted, 1);
  assert.equal(anthropic.buckets.unified5h.capacityWeight, 20);
});

test('the published /teamclaude/quota aggregate is untouched by the fleet view', () => {
  // The two answer different questions and the older one is a documented
  // contract (docs/quota.md). This pins that it still measures RAW quota: a seat
  // at 49% with a 98% threshold is 49% used there, and 50% used in the fleet view.
  const am = new AccountManager([oauth('pro', { rateLimitTier: 'default_claude_ai' })], 0.98);
  Object.assign(am.accounts[0].quota, { unified7d: 0.49, unified7dReset: Date.now() + HOUR });

  assert.equal(am.getQuotaSummary().aggregate.weeklyShared.utilization, 0.49);
});

test('the status payload carries each account tier so a remote view can weigh it', () => {
  const am = new AccountManager([
    oauth('max-20', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('future', { rateLimitTier: 'default_heron' }),
  ], 0.98);

  assert.deepEqual(am.getStatus().accounts.map(a => a.tier.weight), [20, null]);
});

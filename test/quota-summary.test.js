import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { fleetAggregate, routeHeadroom, routeFamily } from '../src/quota-summary.js';

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

// ── Routing and the fleet ────────────────────────────────────────────────────
//
// A seat no route will send traffic to holds quota nothing will spend, which is
// the disabled-seat error one step removed. These pin the rule and the two ways
// it deliberately does NOT fire: no routing table at all, and a pool the routing
// table says nothing about.

/** The resolved shape getRoutes() publishes: membership already worked out. */
const route = (name, names, over = {}) => ({
  name, match: [`${name}-*`], accounts: names.map(n => ({ name: n, provider: 'anthropic', eligible: true })), ...over,
});

test('a seat no route reaches is out of the figures and still in the tally', () => {
  const accounts = [
    seat('routed', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } }),
    seat('stranded', { rateLimitTier: 'default_claude_max_20x', quota: { unified7d: 0 } }),
  ];
  const groups = fleetAggregate(accounts, {
    thresholdFor: () => 1, now: NOW, routes: [route('bulk', ['routed'])],
  });
  const anthropic = pool(groups, 'anthropic');

  // The stranded 20x seat would otherwise hold twenty of the pool's twenty-one
  // units of capacity and report the fleet nearly untouched.
  assert.equal(anthropic.total, 2, 'it is still a seat, and the tally says so');
  assert.equal(anthropic.counted, 1);
  assert.equal(anthropic.buckets.unified7d.capacityWeight, 1);
  assert.equal(anthropic.buckets.unified7d.utilization, 0.5);
});

test('with no routing table every seat counts', () => {
  const accounts = [
    seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } }),
    seat('b', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } }),
  ];
  // Absent, empty, and a table whose routes resolve to nobody: three ways of
  // saying nothing about routing, and none of them says "no seat is reachable".
  for (const routes of [undefined, null, [], [route('empty', [])]]) {
    const anthropic = pool(fleetAggregate(accounts, { thresholdFor: () => 1, now: NOW, routes }), 'anthropic');
    assert.equal(anthropic.counted, 2, `routes=${JSON.stringify(routes)}`);
    assert.equal(anthropic.buckets.unified7d.capacityWeight, 2);
  }
});

test('a pool no route mentions is left alone rather than emptied', () => {
  // Routes are written about Claude models, and a route that lists no accounts
  // resolves to the asking provider's own pool — so an ordinary routing table
  // names no Codex seat at all. Read fleet-wide that emptied the whole Codex
  // block the moment one route existed.
  const groups = fleetAggregate([
    seat('claude', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.5 } }),
    seat('gpt', { provider: 'codex', quota: { unified5h: 0.5 } }),
  ], { thresholdFor: () => 1, now: NOW, routes: [route('bulk', ['claude'])] });

  assert.equal(pool(groups, 'codex').counted, 1);
  assert.equal(pool(groups, 'codex').buckets.unified5h.utilization, 0.5);
});

test('routeFamily classifies a route by its name and its globs', () => {
  assert.equal(routeFamily({ name: 'fable', match: [] }), 'fable');
  assert.equal(routeFamily({ name: 'cheap', match: ['*sonnet*'] }), 'sonnet');
  assert.equal(routeFamily({ name: 'bulk', match: ['claude-haiku-*'] }), null);
});

// ── routeHeadroom ────────────────────────────────────────────────────────────

const HALF_SPENT = { unified7d: 0.5, unified5h: 0.5 };

test('a route reports the bucket nearest its ceiling, not the fullest window', () => {
  // The shared weekly is 80% through what rotation will hand out; the session
  // window is 20%. The weekly is what will stop this route.
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.8, unified5h: 0.2 } })],
    [route('bulk', ['a'])],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.name, 'bulk');
  assert.equal(entry.bucket, 'unified7d');
  assert.equal(entry.value.utilization, 0.8);
  assert.equal(entry.counted, 1);
});

test('the session window binds when it is the one running out', () => {
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.3, unified5h: 0.95 } })],
    [route('bulk', ['a'])],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.bucket, 'unified5h');
  assert.equal(entry.value.utilization, 0.95);
});

test('a family route watches its own weekly bucket', () => {
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { ...HALF_SPENT, unified7dFable: 0.9 } })],
    [{ name: 'fable', match: ['*fable*'], accounts: [{ name: 'a' }] }],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.bucket, 'unified7dFable');
  assert.equal(entry.value.utilization, 0.9);
});

test('a family route is still stopped by the shared weekly when that goes first', () => {
  // Family spend meters into the shared weekly too (#175), so an account under
  // its Fable cap can be over the shared one and unable to serve Fable at all.
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified5h: 0.1, unified7d: 0.97, unified7dFable: 0.4 } })],
    [{ name: 'fable', match: ['*fable*'], accounts: [{ name: 'a' }] }],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.bucket, 'unified7d');
});

test('a general route never reports a family bucket', () => {
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { ...HALF_SPENT, unified7dFable: 0.99 } })],
    [route('bulk', ['a'])],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.bucket, 'unified7d');
  assert.equal(entry.value.utilization, 0.5);
});

test('a route is measured against ITS members, weighted, and nobody else', () => {
  const accounts = [
    seat('big', { rateLimitTier: 'default_claude_max_20x', quota: { unified7d: 0.5 } }),
    seat('small', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0 } }),
    seat('elsewhere', { rateLimitTier: 'default_claude_max_20x', quota: { unified7d: 0 } }),
  ];
  const [entry] = routeHeadroom(accounts, [route('bulk', ['big', 'small'])], { thresholdFor: () => 1, now: NOW });

  // 20 × 0.5 spent of 21 spendable — the third seat is in the fleet and not in
  // this route, so it is no part of this answer.
  assert.equal(entry.counted, 2);
  assert.ok(Math.abs(entry.value.utilization - 10 / 21) < 1e-9);
});

test('a route pool obeys the fleet rules: disabled out, conduits out, unpriced tallied', () => {
  const accounts = [
    seat('live', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } }),
    seat('off', { rateLimitTier: 'default_claude_max_20x', disabled: true, quota: { unified7d: 0 } }),
    seat('kimi', { upstream: 'http://127.0.0.1:18789', quota: { unified7d: 0.9 } }),
    seat('future', { rateLimitTier: 'default_heron', quota: { unified7d: 0 } }),
  ];
  const [entry] = routeHeadroom(
    accounts,
    [route('bulk', ['live', 'off', 'kimi', 'future', 'ghost'])],
    { thresholdFor: () => 1, now: NOW },
  );

  // Two seats in the tally: the disabled one and the conduit are not seats, and
  // a member naming no account this build holds was never one either.
  assert.equal(entry.total, 2);
  assert.equal(entry.counted, 1, 'the unpriced tier is out of the figures');
  assert.equal(entry.value.utilization, 0.5);
});

test('a route with nothing countable reports that instead of a number', () => {
  const [entry] = routeHeadroom(
    [seat('future', { rateLimitTier: 'default_heron', quota: { unified7d: 0.5 } })],
    [route('bulk', ['future'])],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.counted, 0);
  assert.equal(entry.bucket, null);
  assert.equal(entry.value, null);
});

test('a route whose members have reported nothing yet reports no bucket', () => {
  const [entry] = routeHeadroom(
    [seat('fresh', { rateLimitTier: 'default_claude_ai' })],
    [route('bulk', ['fresh'])],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.counted, 1);
  assert.equal(entry.bucket, null);
});

test('a member named twice is weighed once', () => {
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.5 } })],
    [{ name: 'bulk', match: ['x-*'], accounts: [{ name: 'a' }, { name: 'a' }] }],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.counted, 1);
  assert.equal(entry.value.capacityWeight, 1);
});

test('headroom answers one entry per route, in the order it was asked', () => {
  const accounts = [seat('a', { rateLimitTier: 'default_claude_ai', quota: HALF_SPENT })];
  const entries = routeHeadroom(accounts, [route('one', ['a']), route('two', ['a'])], { thresholdFor: () => 1, now: NOW });

  assert.deepEqual(entries.map(e => e.name), ['one', 'two']);
  assert.deepEqual(routeHeadroom(accounts, [], { now: NOW }), []);
  assert.deepEqual(routeHeadroom(accounts, null, { now: NOW }), []);
});

test('a route reports the soonest reset of the bucket that binds', () => {
  const [entry] = routeHeadroom(
    [
      seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.9, unified7dReset: NOW + 4 * HOUR } }),
      seat('b', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.9, unified7dReset: NOW + HOUR } }),
    ],
    [route('bulk', ['a', 'b'])],
    { thresholdFor: () => 1, now: NOW },
  );

  assert.equal(entry.value.nextResetAt, NOW + HOUR);
});

test('a route measures against the threshold rotation stops at, per bucket', () => {
  // The weekly ceiling is lower than the session one here, so the weekly is the
  // binding bucket even though more of the session window has been spent.
  const [entry] = routeHeadroom(
    [seat('a', { rateLimitTier: 'default_claude_ai', quota: { unified7d: 0.45, unified5h: 0.5 } })],
    [route('bulk', ['a'])],
    { thresholdFor: bucket => (bucket === 'unified7d' ? 0.5 : 1) },
  );

  assert.equal(entry.bucket, 'unified7d');
  assert.equal(entry.value.utilization, 0.9);
});

test('routeMembership answers exactly the membership getRoutes resolves', () => {
  // The fleet sampler reads the cheap one on the request path and the dashboard
  // reads the full one per frame. They must not disagree about who is in a
  // route, or the bar and the burn tag beside it would be measuring two fleets.
  const am = new AccountManager([
    oauth('a', { rateLimitTier: 'default_claude_ai' }),
    oauth('b', { rateLimitTier: 'default_claude_ai' }),
  ], 0.98, {
    routes: [
      { name: 'bulk', match: ['claude-haiku-*'], accounts: ['a'] },
      // Lists nobody: constrains models, not accounts, so it reaches the pool.
      { name: 'wide', match: ['claude-opus-*'], accounts: [] },
    ],
  });
  // A Fable bucket nothing routes brings the auto-created route out too.
  am.accounts[0].quota.unified7dFable = 0.5;

  const shape = rs => rs.map(r => [r.name, r.accounts.map(a => a.name).join(' ')]);
  assert.deepEqual(shape(am.routeMembership()), shape(am.getRoutes()));
});

test('the fleet series is sampled over the pool the routes reach', () => {
  // The projection takes its RATE from this series and its remainder from the
  // aggregate on screen, so the two have to be the same measurement.
  const am = new AccountManager([
    oauth('routed', { rateLimitTier: 'default_claude_ai' }),
    oauth('stranded', { rateLimitTier: 'default_claude_max_20x' }),
  ], 1, { routes: [{ name: 'bulk', match: ['claude-haiku-*'], accounts: ['routed'] }] });
  Object.assign(am.accounts[0].quota, { unified7d: 0.5, unified7dReset: Date.now() + HOUR });
  Object.assign(am.accounts[1].quota, { unified7d: 0, unified7dReset: Date.now() + HOUR });

  am._recordFleetSamples();
  const series = am.projection.samples.get('fleet:anthropic:unified7d');
  // The stranded 20x seat would drag this to 10/21 ≈ 0.024 if it were counted.
  assert.equal(series.at(-1).u, 0.5);
});

import { providerOf, isLocalUpstream } from './provider.js';
import { resolveMaxUsage } from './model.js';

/** Resolve a subscription's quota capacity relative to a Claude Pro account. */
export function quotaTier(account) {
  const rateLimitTier = account.rateLimitTier || null;
  const seatTier = account.seatTier || null;
  const normalizedRate = String(rateLimitTier || '').toLowerCase();
  const normalizedSeat = String(seatTier || '').toLowerCase();

  let weight = null;
  if (normalizedRate.includes('20x') || normalizedRate.includes('x20') || normalizedSeat === 'team_tier_2') {
    weight = 20;
  } else if (normalizedRate.includes('5x') || normalizedRate.includes('x5') || normalizedSeat === 'team_tier_1') {
    weight = 5;
  } else if (normalizedSeat === 'team_standard'
      || normalizedRate === 'default_claude_ai'
      || account.organizationType === 'claude_pro'
      || account.hasClaudePro === true) {
    weight = 1;
  }

  return { rateLimitTier, seatTier, weight };
}

const BUCKETS = ['fiveHour', 'weeklyShared', 'weeklySonnet', 'weeklyFable'];

function clean(value) {
  return Math.round(value * 1e12) / 1e12;
}

function bucket(utilization, resetAt, source) {
  if (utilization == null) return null;
  const used = Number(utilization);
  if (!Number.isFinite(used)) return null;
  return {
    utilization: used,
    remaining: clean(Math.max(0, 1 - used)),
    resetAt: resetAt ?? null,
    source,
  };
}

function standardBucket(limit, remaining, resetAt, source) {
  if (limit == null || remaining == null || Number(limit) <= 0) return null;
  const value = bucket(1 - Number(remaining) / Number(limit), resetAt, source);
  return value && { ...value, limit: Number(limit), remainingAmount: Number(remaining) };
}

function accountBuckets(quota) {
  const shared = bucket(quota.unified7d, quota.unified7dReset, 'unified7d');
  const buckets = {
    fiveHour: bucket(quota.unified5h, quota.unified5hReset, 'unified5h'),
    weeklyShared: shared,
    weeklySonnet: bucket(
      quota.unified7dSonnet ?? quota.unified7d,
      quota.unified7dSonnet != null ? quota.unified7dSonnetReset : quota.unified7dReset,
      quota.unified7dSonnet != null ? 'unified7dSonnet' : 'unified7d',
    ),
    weeklyFable: bucket(
      quota.unified7dFable ?? quota.unified7d,
      quota.unified7dFable != null ? quota.unified7dFableReset : quota.unified7dReset,
      quota.unified7dFable != null ? 'unified7dFable' : 'unified7d',
    ),
  };
  const tokens = standardBucket(quota.tokensLimit, quota.tokensRemaining, quota.resetsAt, 'tokens');
  const requests = standardBucket(quota.requestsLimit, quota.requestsRemaining, quota.resetsAt, 'requests');
  if (tokens) buckets.tokens = tokens;
  if (requests) buckets.requests = requests;
  return buckets;
}

function aggregateBucket(accounts, key) {
  let capacityWeight = 0;
  let usedWeight = 0;
  let remainingWeight = 0;
  let knownAccounts = 0;
  let nextResetAt = null;
  for (const account of accounts) {
    const weight = account.tier.weight;
    const value = account.buckets[key];
    if (weight == null || value == null) continue;
    const boundedUtilization = Math.max(0, Math.min(1, value.utilization));
    capacityWeight += weight;
    usedWeight += weight * boundedUtilization;
    remainingWeight += weight * (1 - boundedUtilization);
    knownAccounts++;
    if (value.resetAt != null && (nextResetAt == null || value.resetAt < nextResetAt)) {
      nextResetAt = value.resetAt;
    }
  }
  if (knownAccounts === 0) return null;
  return {
    capacityWeight: clean(capacityWeight),
    usedWeight: clean(usedWeight),
    remainingWeight: clean(remainingWeight),
    utilization: clean(usedWeight / capacityWeight),
    remaining: clean(remainingWeight / capacityWeight),
    knownAccounts,
    nextResetAt,
  };
}

/** Build the quota payload shared by the control endpoint and status clients. */
export function buildQuotaSummary(accounts) {
  const summaries = accounts
    .map(account => ({
      name: account.name,
      type: account.type,
      disabled: !!account.disabled,
      status: account.status,
      tier: quotaTier(account),
      buckets: accountBuckets(account.quota || {}),
    }));
  return {
    accounts: summaries,
    aggregate: Object.fromEntries(BUCKETS.map(key => [key, aggregateBucket(summaries, key)])),
    unknownTiers: summaries
      .filter(account => account.type === 'oauth' && account.tier.weight == null)
      .map(account => ({
        name: account.name,
        rateLimitTier: account.tier.rateLimitTier,
        seatTier: account.tier.seatTier,
      })),
  };
}

// ── Fleet aggregate ──────────────────────────────────────────────────────────
//
// A SECOND aggregate, and deliberately not the one above. The two answer
// different questions and are meant to disagree; do not unify them.
//
// `buildQuotaSummary`'s `aggregate` answers "how full is the fleet's quota" —
// raw `1 - utilization`, tier-weighted, every account in one pool. It is the
// shape published on `GET /teamclaude/quota` and documented in docs/quota.md,
// so status-line consumers already depend on those rules and they are frozen.
//
// `fleetAggregate` answers the dashboard's question: "how much can this fleet
// still SPEND". Three things make that a different number.
//
//   - Rotation stops using an account at its switch threshold, and a per-account
//     `maxUsage` cap stops it harder still. Quota above that ceiling is quota
//     nobody will ever spend, so counting it as headroom promises capacity the
//     router will refuse to hand out. Measuring against the ceiling instead
//     makes the aggregate read 100% at exactly the moment every seat is refused.
//   - A disabled seat still holds quota, and none of it is available. It is out
//     of the pool entirely rather than sitting in it at its last reading.
//   - Anthropic and Codex meter different windows on unrelated subscriptions.
//     One averaged number over both is true of neither pool, so they never mix.

/**
 * One bucket's usable headroom across a provider pool.
 *
 * `utilization` is the share of the pool's SPENDABLE capacity already spent, so
 * 1 means every counted seat is at the point rotation refuses it. The weighted
 * totals it is derived from are carried along so a caller can frame the same
 * measurement differently (absolute seats-worth left, say) without re-deriving
 * the weighting and drifting from this one.
 *
 * @typedef {object} FleetBucket
 * @property {number} utilization Spent / spendable, 0-1.
 * @property {number} remaining 1 - utilization, floored at 0.
 * @property {number} spentWeight Σ weight × min(utilization, limit).
 * @property {number} capacityWeight Σ weight × limit.
 * @property {number} remainingWeight capacityWeight - spentWeight, floored at 0.
 * @property {number} knownAccounts Counted seats that reported this bucket.
 * @property {number|null} nextResetAt Soonest still-future reset among them.
 */

/**
 * The quota fields each provider actually reports.
 *
 * Anthropic meters the two shared windows plus a weekly bucket per metered model
 * family; Codex publishes a session and a weekly window and nothing else (see
 * src/codex-quota.js). Listing them per provider keeps the Codex block from
 * carrying two permanently empty rows for buckets that backend has never heard
 * of. Key order is display order.
 *
 * @type {Record<string, string[]>}
 */
const PROVIDER_BUCKETS = {
  anthropic: ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable'],
  codex: ['unified5h', 'unified7d'],
};

/** A Codex seat's weight. See seatWeight. */
const CODEX_SEAT_WEIGHT = 1;

/**
 * How much capacity one seat contributes to its provider's pool, or null when
 * this build cannot price it.
 *
 * CODEX IS A PER-PROVIDER RULE, NOT A FALLBACK. `quotaTier` scores an account
 * from the Anthropic OAuth profile — rateLimitTier, seatTier, organizationType,
 * hasClaudePro — and a ChatGPT subscription carries none of them, so every Codex
 * seat scores null and the Codex pool would aggregate to nothing at all. OpenAI
 * publishes no tier concept to read instead, so one seat counting as one seat is
 * the only model available here rather than a guess at a hidden one.
 *
 * Written as `provider === 'codex'` and emphatically NOT as `weight ?? 1`,
 * because that fallback would also catch an ANTHROPIC account whose tier this
 * build does not recognise — silently pricing a future Max-40x seat as a Pro
 * one, in the direction that understates how much the fleet holds. Those seats
 * stay excluded, and the group's `total` is what says they were left out.
 *
 * @param {any} account
 * @param {string} provider
 */
function seatWeight(account, provider) {
  if (provider === 'codex') return CODEX_SEAT_WEIGHT;
  // `account.tier` is the tier the server already resolved, which is what an
  // account off the wire carries: the status payload sends `tier` precisely
  // because it does not send the raw profile fields `quotaTier` reads. A local
  // AccountManager account has no such field and is scored here. Preferring the
  // resolved one keeps an attached dashboard weighting the same seats the
  // server does instead of silently counting none of them.
  const weight = (account?.tier ?? quotaTier(account || {}))?.weight;
  // Validated rather than trusted: on the attached path this number came off a
  // socket, and it is about to be multiplied into a total.
  return Number.isFinite(weight) && weight > 0 ? weight : null;
}

/**
 * The utilization at which this account stops serving `bucket` — the lower of
 * the rotation threshold and the account's own `maxUsage` cap, either of which
 * may be absent. Clamped into 0-1: a threshold set above 1 would otherwise
 * credit the pool with quota the window does not have.
 *
 * @param {any} account
 * @param {string} bucket
 * @param {((bucket: string) => number)|null} thresholdFor
 */
function usableLimit(account, bucket, thresholdFor) {
  const threshold = typeof thresholdFor === 'function' ? thresholdFor(bucket) : null;
  const cap = resolveMaxUsage(account?.maxUsage, bucket);
  let limit = 1;
  if (Number.isFinite(threshold)) limit = Math.min(limit, Number(threshold));
  if (Number.isFinite(cap)) limit = Math.min(limit, Number(cap));
  return Math.max(0, limit);
}

/**
 * Usable headroom for one bucket across a pool's counted seats.
 *
 * @param {Array<{account: any, weight: number}>} members
 * @param {string} bucket
 * @param {((bucket: string) => number)|null} thresholdFor
 * @param {number} now
 * @returns {FleetBucket|null}
 */
function aggregateHeadroom(members, bucket, thresholdFor, now) {
  let capacityWeight = 0;
  let spentWeight = 0;
  let knownAccounts = 0;
  /** @type {number|null} */
  let nextResetAt = null;
  for (const { account, weight } of members) {
    const quota = account.quota || {};
    const reading = quota[bucket];
    if (reading == null || !Number.isFinite(Number(reading))) continue;
    const limit = usableLimit(account, bucket, thresholdFor);
    // Spend is capped at the limit as well as weighted. Upstream keeps counting
    // past a spent window (104% arrives as 1.04) and an account may sit above a
    // `maxUsage` cap set after it had already spent more, so without the clamp a
    // single overshooting seat would push the pool past 100% and make the bar
    // read as though healthy seats elsewhere were also gone.
    capacityWeight += weight * limit;
    spentWeight += weight * Math.min(Math.max(0, Number(reading)), limit);
    knownAccounts++;
    // Resets already in the past are skipped rather than winning "soonest"
    // forever: a window whose reset has passed is one the sweep has not caught
    // up with yet (#237), and it would freeze the countdown on a dead timestamp.
    const reset = Number(quota[`${bucket}Reset`]);
    if (Number.isFinite(reset) && reset > now && (nextResetAt == null || reset < nextResetAt)) {
      nextResetAt = reset;
    }
  }
  // No counted seat reported this bucket. Null, not zero: an unobserved window
  // is not an empty one, and a 0% bar would read as headroom nobody has measured.
  if (knownAccounts === 0) return null;
  // Every seat capped at 0 (a threshold or cap of zero) is a pool that can spend
  // nothing, which is 100% used — the same reading it would give at the ceiling.
  // Guarded because the division is 0/0 rather than because the answer is unclear.
  const utilization = capacityWeight > 0 ? spentWeight / capacityWeight : 1;
  return {
    utilization: clean(utilization),
    remaining: clean(Math.max(0, 1 - utilization)),
    spentWeight: clean(spentWeight),
    capacityWeight: clean(capacityWeight),
    remainingWeight: clean(Math.max(0, capacityWeight - spentWeight)),
    knownAccounts,
    nextResetAt,
  };
}

/** Display order for the pools, so the block does not reshuffle itself as
 *  accounts come and go. Anything not listed sorts after what is. */
const PROVIDER_ORDER = Object.keys(PROVIDER_BUCKETS);
/** @param {string} id */
const providerRank = (id) => {
  const i = PROVIDER_ORDER.indexOf(id);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
};

/**
 * Usable headroom across the fleet, one aggregate per provider pool.
 *
 * MEMBERSHIP. A disabled seat is skipped entirely — it is not spendable, so it
 * belongs in neither the capacity nor the tally. A seat this build cannot price
 * is skipped too but still counted, so `counted` of `total` can say how much of
 * the pool the figures actually cover instead of quietly shrinking the fleet.
 *
 * A local backend is not a seat at all and is skipped before either rule. It is
 * a translating proxy in front of another vendor: it holds no subscription, its
 * token is a placeholder, and it has no quota of its own to pool. The account
 * table already draws it as a readout below the rows rather than among them (see
 * _displayOrder in tui.js), and the same reasoning applies harder here — priced
 * it would invent capacity, and left unpriced it would sit in `total` as a seat
 * the fleet is missing, which is the one thing that tally is for saying.
 *
 * A pool appears when it has at least one seat that is not disabled, even when
 * none of them can be priced: "three seats, none of them counted" is a state the
 * operator needs told, and a pool that vanished would look like a config error.
 *
 * @param {Array<any>} accounts Manager accounts, or the `accounts` of a status payload.
 * @param {{thresholdFor?: ((bucket: string) => number)|null, now?: number}} [options]
 * @returns {Array<{provider: string, total: number, counted: number, buckets: Record<string, FleetBucket|null>}>}
 */
export function fleetAggregate(accounts, { thresholdFor = null, now = Date.now() } = {}) {
  /** @type {Map<string, {provider: string, total: number, counted: number, members: Array<{account: any, weight: number}>}>} */
  const groups = new Map();
  for (const account of accounts || []) {
    if (!account || account.disabled || isLocalUpstream(account)) continue;
    const provider = providerOf(account);
    let group = groups.get(provider);
    if (!group) groups.set(provider, group = { provider, total: 0, counted: 0, members: [] });
    group.total++;
    const weight = seatWeight(account, provider);
    if (weight == null) continue;
    group.counted++;
    group.members.push({ account, weight });
  }
  return [...groups.values()]
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider))
    .map(group => ({
      provider: group.provider,
      total: group.total,
      counted: group.counted,
      // A provider added to PROVIDERS without a bucket list here aggregates
      // nothing, rather than being assumed to meter Anthropic's windows.
      buckets: Object.fromEntries((PROVIDER_BUCKETS[group.provider] || [])
        .map(bucket => [bucket, aggregateHeadroom(group.members, bucket, thresholdFor, now)])),
    }));
}

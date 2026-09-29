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
//     of the pool entirely rather than sitting in it at its last reading. A
//     seat no route will send traffic to is the same error one step removed —
//     quota that exists and that nothing will spend — so it is out of the
//     figures too, and only the tally still reports it.
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

/**
 * Which quota family a route spends, or null for a general route.
 *
 * Auto-created routes are named 'fable'/'sonnet'; a configured route is
 * classified by its globs, so `*fable*` binds to the same weekly bucket the F7
 * bar draws.
 *
 * It lives here rather than in the TUI — which is where it was written and
 * where it is still used — because routeHeadroom below asks the same question
 * of the same routes, and a glob test written out twice is two answers waiting
 * to disagree about which bucket a route spends.
 *
 * @param {{name?: string, match?: string[]}} route
 * @returns {'fable'|'sonnet'|null}
 */
export function routeFamily(route) {
  const hay = `${route.name} ${(route.match || []).join(' ')}`.toLowerCase();
  if (/fable/.test(hay)) return 'fable';
  if (/sonnet/.test(hay)) return 'sonnet';
  return null;
}

/** The weekly bucket each model family meters on its own. */
const FAMILY_WEEKLY = { fable: 'unified7dFable', sonnet: 'unified7dSonnet' };

/**
 * Every seat some route will send traffic to, or null when the routing table
 * says nothing about that.
 *
 * Membership is read off a RESOLVED view (`getRoutes()`, `routeMembership()`,
 * or the `routes` of a status payload), never re-derived from the configured
 * `accounts` list, because an empty list there means the opposite of what it
 * looks like: a route that names nobody constrains models rather than accounts,
 * and resolves to every account of its provider. Deriving "a route with no
 * accounts reaches no accounts" from the raw config would exclude the whole
 * fleet on the commonest configuration there is.
 *
 * Null for an empty table, and also for a table whose routes resolve to nobody
 * at all. That union carries no information about which seats are reachable —
 * it is equally what an older server, a payload that dropped the field, or a
 * stand-in manager looks like — and reading it as "no seat is reachable" would
 * blank every pool on the dashboard over a missing field, which is the one
 * thing a capacity readout must never invent. The caller applies the same
 * reasoning per pool; see fleetAggregate.
 *
 * @param {Array<{accounts?: Array<{name?: string}>}>|null|undefined} routes
 * @returns {Set<string>|null}
 */
function routableNames(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return null;
  /** @type {Set<string>} */
  const names = new Set();
  for (const route of routes) {
    for (const member of route?.accounts || []) {
      if (member?.name != null) names.add(member.name);
    }
  }
  return names.size ? names : null;
}

/**
 * The spendable seats among `accounts`, with the tally that says how many were
 * left out of the figures.
 *
 * ONE PLACE, because the provider pools and the route readout have to agree
 * about what a seat is. The rules:
 *
 *   - A disabled seat is skipped entirely — it is not spendable, so it belongs
 *     in neither the capacity nor the tally.
 *   - A local backend is not a seat at all and is skipped before either rule.
 *     It is a translating proxy in front of another vendor: it holds no
 *     subscription, its token is a placeholder, and it has no quota of its own
 *     to pool. The account table already draws it as a readout below the rows
 *     rather than among them (see _displayOrder in tui.js), and the same
 *     reasoning applies harder here — priced it would invent capacity, and left
 *     unpriced it would sit in `total` as a seat the fleet is missing, which is
 *     the one thing that tally is for saying.
 *   - A seat this build cannot price is skipped but still counted, so
 *     `counted` of `total` can say how much of the pool the figures actually
 *     cover instead of quietly shrinking the fleet.
 *   - `include`, when given, is the same shape of exclusion: out of the
 *     figures, still in the tally.
 *
 * @param {Array<any>} accounts
 * @param {((account: any) => boolean)|null} [include] Extra membership test.
 * @returns {{total: number, counted: number, members: Array<{account: any, weight: number}>}}
 */
function countedPool(accounts, include = null) {
  /** @type {Array<{account: any, weight: number}>} */
  const members = [];
  let total = 0;
  let counted = 0;
  for (const account of accounts || []) {
    if (!account || account.disabled || isLocalUpstream(account)) continue;
    total++;
    if (include && !include(account)) continue;
    const weight = seatWeight(account, providerOf(account));
    if (weight == null) continue;
    counted++;
    members.push({ account, weight });
  }
  return { total, counted, members };
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
 * MEMBERSHIP is countedPool's — disabled seats out, local backends out,
 * unpriceable seats out of the figures but in the tally — plus one rule of its
 * own when `routes` is given: a seat no route will send traffic to contributes
 * nothing spendable, so it is excluded from the capacity and left in `total`,
 * exactly as an unpriceable seat is. Counting it was the same class of error as
 * counting a disabled one: quota that exists and that nothing will ever spend.
 *
 * THE RULE IS APPLIED PER POOL, and only to a pool some route actually reaches.
 * A route that lists no accounts resolves to the asking provider's own pool
 * (see _routeAccountsView), so an Anthropic-only routing table — which is what
 * nearly every routing table is, since routes are written about Claude models —
 * names no Codex seat at all. Read fleet-wide, that emptied the whole Codex
 * block the moment a single route existed: every seat in it "unroutable", no
 * bars, a pool the operator can plainly see working reported as nothing. Where
 * no route mentions a pool, the routing table is saying nothing about that pool
 * rather than refusing it, and the seats count as they would with no routes at
 * all.
 *
 * THIS ERRS TOWARD UNDERSTATING, on purpose. A seat outside every route is not
 * strictly unreachable even within a pool the routes do reach: a model that
 * matches no route at all is not routed, and falls back to plain rotation over
 * the whole provider pool — so that seat will take unrouted traffic even though
 * no route names it. The alternative error is the expensive one. Understating
 * spendable capacity costs a pessimistic bar; overstating it is how an operator
 * gets surprised by exhaustion on a pool the dashboard said was half full.
 *
 * `routes` must be a RESOLVED view — AccountManager's `getRoutes()` or its
 * cheaper `routeMembership()`, or the `routes` a status payload carries. See
 * routableNames for what goes wrong when membership is re-derived from config.
 *
 * A pool appears when it has at least one seat that is not disabled, even when
 * none of them can be priced: "three seats, none of them counted" is a state the
 * operator needs told, and a pool that vanished would look like a config error.
 *
 * @param {Array<any>} accounts Manager accounts, or the `accounts` of a status payload.
 * @param {{thresholdFor?: ((bucket: string) => number)|null, now?: number, routes?: Array<any>|null}} [options]
 * @returns {Array<{provider: string, total: number, counted: number, buckets: Record<string, FleetBucket|null>}>}
 */
export function fleetAggregate(accounts, { thresholdFor = null, now = Date.now(), routes = null } = {}) {
  const routable = routableNames(routes);
  // Grouped first, pooled second: a seat the routing rule drops still has to
  // reach its provider's `total`, the rule itself is decided per pool, and
  // pooling per group is what keeps that rule (and every other membership rule)
  // in one place.
  /** @type {Map<string, Array<any>>} */
  const byProvider = new Map();
  for (const account of accounts || []) {
    if (!account || account.disabled || isLocalUpstream(account)) continue;
    const provider = providerOf(account);
    const list = byProvider.get(provider);
    if (list) list.push(account);
    else byProvider.set(provider, [account]);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => providerRank(a) - providerRank(b))
    .map(([provider, list]) => {
      // Some seat here has to be routable before "unroutable" can mean anything
      // about the rest — see the note above.
      const reaching = routable && list.some(account => routable.has(account.name)) ? routable : null;
      const pool = countedPool(list, reaching ? (/** @type {any} */ a) => reaching.has(a.name) : null);
      return {
        provider,
        total: pool.total,
        counted: pool.counted,
        // A provider added to PROVIDERS without a bucket list here aggregates
        // nothing, rather than being assumed to meter Anthropic's windows.
        buckets: Object.fromEntries((PROVIDER_BUCKETS[provider] || [])
          .map(bucket => [bucket, aggregateHeadroom(pool.members, bucket, thresholdFor, now)])),
      };
    });
}

/**
 * What stops each route first.
 *
 * A route holds no quota of its own — it spends its members' buckets — so the
 * only honest answer to "how much has this route left" is the bucket nearest
 * its ceiling, because that is the one that will refuse the route's traffic
 * while the others still have room.
 *
 * WHICH BUCKETS. A general route spends the shared weekly and the shared 5-hour
 * window. A family route (see routeFamily) spends its family's weekly bucket
 * AND both of those, because family spend meters into the shared weekly too:
 * an account under its Fable cap can be over the shared one and unable to serve
 * Fable at all (#175), so a readout that watched F7 alone would keep saying the
 * route was fine right up to the moment nothing could serve it.
 *
 * WHICH ONE BINDS. The highest utilization, not the soonest reset. Every
 * candidate is measured as a fraction of its own spendable capacity — each
 * bucket against its own threshold and cap — which is exactly what makes them
 * comparable: at equal burn rates the fullest reaches 1 first. Rates are not
 * modelled here; the burn tags beside the bars are what speak to those. A tie
 * goes to the earlier candidate, so a family route names its family bucket over
 * the shared weekly and the weekly over the 5-hour one — the more specific
 * window first, then the one that takes days rather than hours to come back.
 *
 * Membership is countedPool's, so the pool a route is measured over obeys the
 * same rules the fleet pools do. A route member that names no account this
 * build holds is not a seat at all and never reaches the tally.
 *
 * One entry per route, in the order given, so a caller can pair an entry with
 * the route it came from by index (the colour and the pin live there).
 *
 * @param {Array<any>} accounts Manager accounts, or the `accounts` of a status payload.
 * @param {Array<any>} routes The resolved routing view — see routableNames.
 * @param {{thresholdFor?: ((bucket: string) => number)|null, now?: number}} [options]
 * @returns {Array<{name: string, counted: number, total: number, bucket: string|null, value: FleetBucket|null}>}
 */
export function routeHeadroom(accounts, routes, { thresholdFor = null, now = Date.now() } = {}) {
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const account of accounts || []) {
    if (account?.name != null && !byName.has(account.name)) byName.set(account.name, account);
  }
  return (Array.isArray(routes) ? routes : []).map(route => {
    // Deduplicated by name on the way in: a route lists each account once, but
    // this list can also arrive off a socket, and a name repeated there would
    // otherwise weigh that seat twice in its own route's aggregate.
    const seen = new Set();
    const members = [];
    for (const entry of route?.accounts || []) {
      const name = entry?.name;
      if (name == null || seen.has(name)) continue;
      seen.add(name);
      const account = byName.get(name);
      if (account) members.push(account);
    }
    const pool = countedPool(members);
    const family = routeFamily(route || {});
    const candidates = family
      ? [FAMILY_WEEKLY[family], 'unified7d', 'unified5h']
      : ['unified7d', 'unified5h'];
    /** @type {{bucket: string, value: FleetBucket}|null} */
    let binding = null;
    for (const bucket of candidates) {
      const value = aggregateHeadroom(pool.members, bucket, thresholdFor, now);
      // A bucket no counted member reports is not a constraint that has been
      // measured, so it cannot be the one that binds. Strict `>` keeps the tie
      // with the earlier, more specific candidate.
      if (value && (!binding || value.utilization > binding.value.utilization)) binding = { bucket, value };
    }
    return {
      name: route?.name ?? '',
      counted: pool.counted,
      total: pool.total,
      bucket: binding?.bucket ?? null,
      value: binding?.value ?? null,
    };
  });
}

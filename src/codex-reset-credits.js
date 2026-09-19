// Codex rate-limit reset credits.
//
// OpenAI occasionally grants a ChatGPT subscription a free "rate limit reset
// credit": redeeming one clears the account's spent rate-limit windows ahead of
// their own reset. Codex's own client offers it only as a manual action, so a
// pooled account that runs dry sits out the rest of its week with an unspent
// credit in hand — which is the whole reason this file exists.
//
// Same private ChatGPT backend as codex-usage.js, and the same isolation
// discipline: an account's credential is sent to the provider that issued it
// and nowhere else, so — like that file — nothing here knows an Anthropic path.
//
// Three facts about the wire format shape everything below.
//
// First, the COUNT is already in `/wham/usage`: that payload carries
// `rate_limit_reset_credits: { available_count, applicable_available_count }`
// at the top level, so reporting "this account holds a credit" costs no request
// of its own — the quota probe has already made it. That one field is parsed
// next to the rest of that payload, in codex-usage.js, rather than here: it
// belongs to the reading, and importing it back would put a cycle between two
// files that otherwise depend one way.
//
// Second, the detail rows (`GET /wham/rate-limit-reset-credits`) state
// `granted_at` / `expires_at` as ISO-8601 STRINGS. The Rust app-server layer
// states the same fields as epoch seconds; this is the HTTP layer, which does
// not, so the two must not be parsed the same way.
//
// Third — and this is the one that bites — the consume endpoint answers HTTP
// 200 on failure just as readily as on success, and puts its verdict in a
// `code` field (`reset`, `nothing_to_reset`, `no_credit`, `already_redeemed`).
// Classifying on the status code would read "you hold no credits" as a
// redemption that worked, and a redemption that worked is not recoverable.

import { randomUUID } from 'node:crypto';

import { fetchCodexUsage } from './codex-usage.js';
import { providerOf } from './provider.js';
import { safeLine } from './safe-text.js';
import { proxyFetch } from './upstream-fetch.js';

export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
export const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;

/** How close to expiry a credit must be for "use it or lose it" to override a pool that still has headroom. */
export const CREDIT_EXPIRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// How long a fetched list of credit rows is trusted. Expiry dates move at the
// pace of a monthly grant, so re-reading them per 429 would be all cost: this
// is the only thing bounding how often a hot rejection loop touches the detail
// endpoint before the policy has even had a chance to say no.
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;

// After an attempt that spent nothing (upstream declined, or the request
// failed), how long before this account may try again.
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

// After an attempt that DID spend a credit. Longer, and deliberately so: if the
// weekly window still reads exhausted afterwards — a reset that only covered
// the session window, a usage read that had not caught up — the next 429 must
// not reach for a second credit to fix what the first one apparently did not.
const SUCCESS_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * How long the whole redemption may take — the token refresh, the detail read
 * and the consume TOGETHER, not each.
 *
 * `maybeRedeem` runs inline, with the rejected request waiting on it, and a
 * Codex client gives the response head a fixed 60s before abandoning the
 * attempt and retrying the whole request (see test/codex-no-inline-hold.test.js
 * for where that number is from). That retry is the entire point: it is the
 * request the reset exists to let through, on the same account whose windows
 * were just cleared. So the decision gets a sixth of the head budget and the
 * ~50s left over belong to the retry — a redemption that wins the argument but
 * eats the time the retried request needed has helped nobody.
 */
export const REDEEM_BUDGET_MS = 10_000;

// Utilization at which the weekly window counts as genuinely spent. Exactly 1,
// not the rotation threshold: rotating away from an account at 98% costs
// nothing, while a credit is scarce and unrecoverable, so the bar for spending
// one is the window actually being over.
const WEEKLY_SPENT = 1;

/** @param {Record<string, any>} account */
function codexHeaders(account) {
  return {
    Authorization: `Bearer ${account.credential}`,
    'ChatGPT-Account-Id': account.accountId,
    Accept: 'application/json',
  };
}

/**
 * One detail row, or null when it names no credit we could ever redeem.
 *
 * @param {any} raw
 */
function creditRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const expires = raw.expires_at == null ? NaN : Date.parse(raw.expires_at);
  return {
    id: safeLine(id, 128),
    // `available` | `redeeming` | `redeemed`.
    status: typeof raw.status === 'string' ? raw.status : null,
    // A hard gate on redemption, checked alongside `status` — but `!== false`,
    // so a payload that predates the field degrades to usable. Reading an
    // absent field as "your plan cannot spend this" would switch the whole
    // feature off silently, which is the one failure mode nobody would notice.
    supportedByPlan: raw.is_supported_by_plan !== false,
    // ISO-8601 at this layer (epoch seconds one layer down, in the Rust
    // app-server). Null means the credit does not expire.
    expiresAt: Number.isFinite(expires) ? expires : null,
    title: typeof raw.title === 'string' ? safeLine(raw.title, 64) : null,
  };
}

/** @typedef {{id: string, status: string|null, supportedByPlan: boolean, expiresAt: number|null, title: string|null}} ResetCredit */

/**
 * The account's credit rows, with the expiry dates the policy reasons about.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 */
export async function fetchResetCreditDetails(account, { fetchImpl = proxyFetch, timeoutMs = 10_000, url = CODEX_RESET_CREDITS_URL } = {}) {
  if (!account?.credential || !account?.accountId) return { error: 'missing Codex account identity' };
  try {
    const res = await fetchImpl(url, {
      headers: codexHeaders(account),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    /** @type {ResetCredit[]} */
    const credits = Array.isArray(data?.credits)
      ? data.credits.flatMap((/** @type {any} */ row) => creditRow(row) ?? [])
      : [];
    const stated = Number(data?.available_count);
    return {
      credits,
      // Upstream's own count when it states one, else what the rows show. This
      // is the account's HOLDINGS, not the redeemable set — see the split in
      // normalizeResetCredits.
      availableCount: Number.isFinite(stated) ? stated : credits.filter(c => c.status === 'available').length,
    };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}

/**
 * Spend one credit. The single irreversible call in this file.
 *
 * `redeemRequestId` is an idempotency key: replaying the same one after a
 * failure that may or may not have reached upstream answers `already_redeemed`
 * rather than spending a second credit, so a caller that cannot tell what
 * happened must reuse its key rather than mint a fresh one.
 *
 * `creditId` is optional — omitted, the backend picks the next available credit
 * itself.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ creditId?: string|null, redeemRequestId: string }} attempt
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 */
export async function consumeResetCredit(account, { creditId = null, redeemRequestId }, { fetchImpl = proxyFetch, timeoutMs = 20_000, url = CODEX_RESET_CREDITS_CONSUME_URL } = {}) {
  if (!account?.credential || !account?.accountId) return { error: 'missing Codex account identity' };
  if (!redeemRequestId) return { error: 'missing redeem request id' };
  // `credit_id` is written only when the caller named one, so the shape is
  // declared rather than inferred from the seed.
  /** @type {{redeem_request_id: string, credit_id?: string}} */
  const payload = { redeem_request_id: redeemRequestId };
  if (creditId) payload.credit_id = creditId;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...codexHeaders(account), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A declined redemption comes back 200 with its reason in `code`, so the
    // verdict is read from the BODY and a non-2xx means only that no verdict
    // was reached. Reversing those two would report "no_credit" as a success.
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    const windows = Number(data?.windows_reset);
    return {
      code: typeof data?.code === 'string' ? safeLine(data.code, 64) : null,
      windowsReset: Number.isFinite(windows) ? windows : 0,
      credit: creditRow(data?.credit),
    };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}

/**
 * Is this account's weekly window actually spent?
 *
 * The 429 path cannot answer this from the flat `x-codex-*-used-percent`
 * headers: those are positions, not durations, so a spent 5-hour window looks
 * identical there. The parsed quota keeps the two apart (see codex-quota.js),
 * and the 5-hour one is explicitly NOT a trigger — it heals by itself within
 * the hour, and a "Full reset" is far too scarce to burn on that.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {number} [now]
 */
export function weeklyExhausted(account, now = Date.now()) {
  const q = account?.quota;
  if (!q || q.unified7d == null) return false;
  // A reading whose window has already rolled over describes a week that is
  // over. Nothing sweeps it until the account is next considered, so trusting
  // it here would redeem a credit against last week's exhaustion.
  if (q.unified7dReset != null && q.unified7dReset <= now) return false;
  return q.unified7d >= WEEKLY_SPENT;
}

/**
 * The checks that need no network — shared by the policy and by the caller that
 * decides whether to fetch the detail rows at all, so the two cannot drift.
 *
 * `autoRedeemResets` is the FLEET switch (`config.autoRedeemResets`), and it is
 * the only thing that arms anything. It defaults to false here as well as in
 * the config: a caller that forgets to pass it redeems nothing, which is the
 * only safe direction for a decision that spends something unrecoverable.
 *
 * @param {{account: Record<string, any>, autoRedeemResets?: boolean, now?: number}} args
 * @returns {{ok: boolean, reason: string}}
 */
export function redeemPreconditions({ account, autoRedeemResets = false, now = Date.now() }) {
  if (!account) return { ok: false, reason: 'no account' };
  if (providerOf(account) !== 'codex') return { ok: false, reason: 'not a Codex account' };
  // Off unless the fleet switch says otherwise: the absent key is the common
  // case, and it means the operator has not armed this at all.
  if (autoRedeemResets !== true) return { ok: false, reason: 'auto-redeem is switched off' };
  // Negative-only override, and this polarity is easy to read backwards: an
  // account may say `false` to exempt itself, but an account saying `true`
  // arms NOTHING on its own — only the fleet switch above does. Written as
  // `=== false` so it reads the same on a raw config entry (absent =
  // undefined) as on a running account (absent = normalised to true).
  if (account.autoRedeemReset === false) return { ok: false, reason: 'auto-redeem is switched off for this account' };
  if (!weeklyExhausted(account, now)) return { ok: false, reason: 'weekly window is not exhausted' };
  return { ok: true, reason: 'weekly window is exhausted' };
}

/**
 * Whether to spend one of this account's reset credits, and which one.
 *
 * Pure on purpose. This is the function that decides to consume something
 * scarce and irreversible, so every input is a value the caller has already
 * gathered and the whole decision table is exercised without a single request.
 *
 * Beyond the preconditions above, a redemption needs one of two justifications:
 *
 *  - the rest of the Codex pool is unavailable too, so the credit actually
 *    unblocks work rather than topping up an account rotation would have
 *    stepped past anyway; or
 *  - the credit is about to expire, in which case holding it costs more than
 *    spending it.
 *
 * @param {Object} args
 * @param {Record<string, any>} args.account
 * @param {boolean} [args.autoRedeemResets]  the fleet switch — see redeemPreconditions
 * @param {Array<{name?: string, available: boolean}>} [args.pool]  the OTHER Codex accounts, with availability already resolved
 * @param {ResetCredit[]} [args.credits]  this account's detail rows
 * @param {number} [args.now]
 * @returns {{redeem: boolean, reason: string, creditId: string|null}}
 */
export function shouldRedeemReset({ account, autoRedeemResets = false, pool = [], credits = [], now = Date.now() }) {
  const pre = redeemPreconditions({ account, autoRedeemResets, now });
  if (!pre.ok) return { redeem: false, reason: pre.reason, creditId: null };

  // `is_supported_by_plan` is as hard a gate as `status`, so it is applied
  // BEFORE any expiry reasoning: a credit this plan cannot spend is not one we
  // hold for this purpose, and must not be what makes an expiring-credit
  // decision look justified.
  const redeemable = credits
    .filter(credit => credit?.status === 'available' && credit.supportedByPlan !== false)
    // Soonest to expire first, so "use it or lose it" spends the one that would
    // be lost. Two credits that never expire compare equal rather than NaN.
    .sort((a, b) => {
      const left = a.expiresAt ?? Infinity;
      const right = b.expiresAt ?? Infinity;
      return left === right ? 0 : left - right;
    });
  const credit = redeemable[0];
  if (!credit) return { redeem: false, reason: 'holds no redeemable credit', creditId: null };

  // No other Codex account left: `every` over an empty list is true, which is
  // the right answer for a single-account pool — that one account being out IS
  // the pool being dry.
  if (pool.every(other => !other.available)) {
    return { redeem: true, reason: 'every other Codex account is unavailable', creditId: credit.id };
  }

  if (credit.expiresAt != null && credit.expiresAt - now <= CREDIT_EXPIRY_WINDOW_MS) {
    const days = Math.max(0, Math.round((credit.expiresAt - now) / (24 * 60 * 60 * 1000)));
    return { redeem: true, reason: `credit expires in ~${days}d and this weekly is spent`, creditId: credit.id };
  }

  return { redeem: false, reason: 'another Codex account can still serve', creditId: null };
}

/**
 * What every path through `maybeRedeem` answers with. `redeemed` is the only
 * field a caller must read: the rest describe the decision for a log line.
 *
 * @typedef {{redeemed: boolean, reason: string, code?: string|null, windowsReset?: number}} RedeemResult
 */

/**
 * The per-account transient state the redeemer keeps. `credits` is null when
 * nothing is cached — distinct from an empty list, which is a fetched "this
 * account holds none" — and `inFlight` is the attempt concurrent rejections
 * join rather than start again.
 *
 * @typedef {{cooldownUntil: number, credits: ResetCredit[]|null, creditsAt: number, redeemRequestId: string|null, inFlight: Promise<RedeemResult>|null}} RedeemState
 */

/**
 * Turns the policy above into the one action it authorises.
 *
 * Everything with a side effect lives here: the token refresh, the two HTTP
 * calls, the cooldowns, and the re-read that puts a reset account back into
 * rotation. `maybeRedeem` is called from the 429 path, so it must be safe under
 * a burst — a spent weekly window rejects every request in flight at once, and
 * each of those rejections arrives here asking the same question.
 *
 * It is also called with a client waiting, which sets the time budget. That
 * budget is ONE deadline for the whole attempt (REDEEM_BUDGET_MS above), not a
 * timeout per call: what the waiting client can spare is a property of the
 * attempt, so each call gets whatever is left of it and never more, and a step
 * that finds nothing left does not run at all. Per-call timeouts would let a
 * refresh, a read and a POST each spend the full allowance and hand the client
 * a hold three times longer than anyone agreed to.
 *
 * The common path is one POST — the preconditions cost nothing and the rows are
 * cached — and every path that ends without a redemption, the exhausted budget
 * included, arms a cooldown and falls through to the ordinary rotation.
 */
export class ResetCreditRedeemer {
  /**
   * @param {any} accountManager
   * @param {{config?: Record<string, any>|null, detailsFn?: Function, consumeFn?: Function, usageFn?: Function, now?: () => number, log?: Function, timeoutMs?: number, detailTtlMs?: number}} [opts]
   */
  constructor(accountManager, {
    // The SHARED config object, not a snapshot of one field: `autoRedeemResets`
    // is read off it per rejection, so a TUI toggle or a reload binds on the
    // next 429 rather than at the next restart — and an operator who switches
    // this off is doing so precisely because they want it off now.
    config = null,
    detailsFn = fetchResetCreditDetails,
    consumeFn = consumeResetCredit,
    usageFn = fetchCodexUsage,
    now = Date.now,
    log = console.log,
    // The TOTAL budget for one attempt, not a per-call timeout.
    timeoutMs = REDEEM_BUDGET_MS,
    detailTtlMs = DETAIL_TTL_MS,
  } = {}) {
    this.am = accountManager;
    this.config = config;
    this.detailsFn = detailsFn;
    this.consumeFn = consumeFn;
    this.usageFn = usageFn;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.detailTtlMs = detailTtlMs;
    // Keyed by the account OBJECT, not its index or name: indices are renumbered
    // when an account is removed and names are not unique, while this state
    // (cooldown, cached rows, an unfinished attempt's idempotency key) is
    // meaningless for any account but the exact one it was learned for. It is
    // also purely transient, so it deliberately never reaches the persisted
    // quota state or the status payload.
    /** @type {WeakMap<object, RedeemState>} */
    this.state = new WeakMap();
  }

  /**
   * @param {object} account
   * @returns {RedeemState}
   */
  _stateFor(account) {
    let state = this.state.get(account);
    if (!state) {
      state = { cooldownUntil: 0, credits: null, creditsAt: 0, redeemRequestId: null, inFlight: null };
      this.state.set(account, state);
    }
    return state;
  }

  /**
   * Redeem a credit for `account` if the policy allows it.
   *
   * @param {Record<string, any>} account
   * @returns {Promise<RedeemResult>}
   */
  async maybeRedeem(account) {
    if (!account) return { redeemed: false, reason: 'no account' };
    const state = this._stateFor(account);
    // Concurrent rejections on one account are ONE decision. Without this, a
    // burst arriving the moment a weekly window ran dry would each read the
    // same "we hold a credit" and race into separate redemptions.
    if (state.inFlight) return state.inFlight;
    const attempt = this._attempt(account, state).finally(() => { state.inFlight = null; });
    state.inFlight = attempt;
    return attempt;
  }

  /**
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @returns {Promise<RedeemResult>}
   */
  async _attempt(account, state) {
    const now = this.now();
    const autoRedeemResets = this.config?.autoRedeemResets === true;
    const pre = redeemPreconditions({ account, autoRedeemResets, now });
    if (!pre.ok) return { redeemed: false, reason: pre.reason };
    if (now < state.cooldownUntil) return { redeemed: false, reason: 'cooling down after a recent attempt' };

    // The HOLDINGS count the usage probe last saw — the same number the TUI and
    // the dashboard draw, and not the redeemable set: it knows nothing about
    // plan support. So it is only ever a negative gate. Zero holdings means zero
    // redeemable and stops us here for free; anything else decides nothing, and
    // the detail rows below are what the policy actually reads. An ABSENT
    // reading is likewise not "none": the probe is off by default, and the
    // detail fetch reports the count anyway.
    if (account.quota?.resetCredits?.available === 0) {
      return { redeemed: false, reason: 'holds no reset credits' };
    }

    // Everything from here on can touch the network, and all of it shares this
    // one deadline: what the waiting client can spare belongs to the attempt,
    // not to each call inside it.
    const deadline = now + this.timeoutMs;

    const credits = await this._credits(account, state, now, deadline);
    if (credits.error) {
      state.cooldownUntil = now + RETRY_COOLDOWN_MS;
      return { redeemed: false, reason: `could not read reset credits (${credits.error})` };
    }

    // The policy asks whether the rest of the Codex pool can still serve, which
    // is exactly what rotation asks. Resolved through the manager so the two
    // answers cannot disagree.
    const pool = this.am.accounts
      .filter((/** @type {Record<string, any>} */ other) => other !== account && providerOf(other) === 'codex')
      .map((/** @type {Record<string, any>} */ other) => ({ name: other.name, available: this.am.unavailableReason(other) === null }));

    const verdict = shouldRedeemReset({ account, autoRedeemResets, pool, credits: credits.credits, now });
    // A policy "no" arms no cooldown: it turns on pool state that can change
    // within the minute, and the cached rows above already bound what asking
    // again costs.
    if (!verdict.redeem) return { redeemed: false, reason: verdict.reason };

    return this._consume(account, state, verdict, now, deadline);
  }

  /**
   * What is left of the attempt's budget, as the timeout for the next call.
   *
   * Zero or less means the client's share is gone: the caller makes no call and
   * declines, because a request started with nothing left cannot finish inside
   * the budget and would only push the hold past it.
   *
   * @param {number} deadline
   * @returns {number}
   */
  _timeLeft(deadline) {
    return deadline - this.now();
  }

  /**
   * The detail rows, from cache while they are fresh.
   *
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<{credits?: ResetCredit[], error?: string}>}
   */
  async _credits(account, state, now, deadline) {
    if (state.credits && now - state.creditsAt < this.detailTtlMs) return { credits: state.credits };
    // The refresh is inside the budget too. It is the one step here that can go
    // to the network without being given a timeout, so the only way to bound it
    // is to charge what it spends to the calls that follow.
    await this.am.ensureTokenFresh(account.index);
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0) return { error: 'ran out of the redeem budget before reading the credit rows' };
    const result = await this.detailsFn(account, { timeoutMs });
    if (result?.error) return { error: result.error };
    const credits = result?.credits || [];
    state.credits = credits;
    state.creditsAt = now;
    return { credits };
  }

  /**
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {{redeem: boolean, reason: string, creditId: string|null}} verdict
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<RedeemResult>}
   */
  async _consume(account, state, verdict, now, deadline) {
    const name = safeLine(account.name, 64);
    await this.am.ensureTokenFresh(account.index);
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0) {
      // Declined like any other attempt that spent nothing: a cooldown, so a
      // burst against a slow upstream cannot re-enter here per rejection, and
      // no idempotency key minted for a request never made.
      state.cooldownUntil = now + RETRY_COOLDOWN_MS;
      this.log(`[TeamClaude] Codex rate-limit reset on "${name}" ran out of its time budget before redeeming — rotating instead`);
      return { redeemed: false, reason: 'ran out of the redeem budget' };
    }

    // Reused across retries of the SAME logical attempt: an attempt that failed
    // after upstream had already acted is indistinguishable from one that never
    // arrived, and replaying the key is what makes upstream say so.
    state.redeemRequestId ||= randomUUID();
    this.log(`[TeamClaude] Redeeming a free Codex rate-limit reset on "${name}" — ${verdict.reason}`);

    const result = await this.consumeFn(account,
      { creditId: verdict.creditId, redeemRequestId: state.redeemRequestId },
      { timeoutMs });

    if (result?.error) {
      // Key deliberately kept: see above.
      state.cooldownUntil = now + RETRY_COOLDOWN_MS;
      this.log(`[TeamClaude] Codex rate-limit reset failed on "${name}" — ${safeLine(result.error, 120)}`);
      return { redeemed: false, reason: `redeem failed (${result.error})` };
    }

    state.redeemRequestId = null;
    // Whatever upstream decided, the list we hold describes a moment before it.
    state.credits = null;

    // `already_redeemed` is the idempotency key answering for an earlier attempt
    // that did land, so it is a success with the windows already reset.
    if (result?.code === 'reset' || result?.code === 'already_redeemed') {
      state.cooldownUntil = now + SUCCESS_COOLDOWN_MS;
      const windows = result.windowsReset || 0;
      this.log(`[TeamClaude] Redeemed a free Codex rate-limit reset on "${name}" — ${windows} window(s) reset (${result.code})`);
      await this._refresh(account, name, deadline);
      return { redeemed: true, reason: verdict.reason, code: result.code, windowsReset: windows };
    }

    state.cooldownUntil = now + RETRY_COOLDOWN_MS;
    this.log(`[TeamClaude] Codex rate-limit reset declined on "${name}" — upstream said "${result?.code || 'nothing'}", no credit spent`);
    return { redeemed: false, reason: `upstream declined (${result?.code || 'no code'})` };
  }

  /**
   * Put the account back in service after a successful reset: drop the hold and
   * re-read its quota.
   *
   * Nothing here fabricates a reading. If the read fails, or upstream has not
   * caught up with its own reset yet, the account stays blocked by its stale
   * exhausted numbers until the all-unavailable revalidation probe sends it a
   * live request — which is the same path that recovers every other account
   * whose quota we cannot see.
   *
   * That fallback is also why this read is held to the same deadline, and
   * skipped outright once it has passed: the hold clears either way, and a
   * reading we did not take is a delay of one request, while a client that gave
   * up waiting is the retry this redemption was spent to enable.
   *
   * @param {Record<string, any>} account
   * @param {string} name
   * @param {number} deadline
   */
  async _refresh(account, name, deadline) {
    this.am.clearRateLimited(account.index);
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0) {
      this.log(`[TeamClaude] Out of time to re-read Codex quota for "${name}" after the reset — it will be re-learned from traffic`);
      return;
    }
    const usage = await this.usageFn(account, { timeoutMs }).catch(() => null);
    if (!usage || usage.error) {
      this.log(`[TeamClaude] Could not re-read Codex quota for "${name}" after the reset — it will be re-learned from traffic`);
      return;
    }
    this.am.applyCodexUsageData(account.index, usage);
  }
}

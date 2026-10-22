// Steer: send NEW conversations to one account for a while.
//
// The operator's case: one account holds a banked usage-limit reset, and its
// current week should be spent as fast as possible before the reset is. Neither
// existing control does that without breaking prompt caches across the fleet.
// `teamclaude switch` moves the cursor, which every conversation follows when
// distribution is off and which new-conversation placement ignores when it is
// on. A priority change makes every pinned conversation on a lower-priority
// account re-route at once (the `betterExists` preemption).
//
// A steer changes only PLACEMENT: where a conversation with no usable pin goes,
// and where an untagged request goes. A running conversation keeps its account,
// so no prompt cache is broken. One steer per provider partition, so a Claude
// steer and a Codex steer can coexist; each names one account.
//
// This file holds the parts that need no manager: the time limits, parsing the
// operator's `for`/`until`, and the short "time left" form every surface prints.
// The routing itself is AccountManager's (_steerPlacement, _liveSteer).

import { providerOf, DEFAULT_PROVIDER } from './provider.js';

/**
 * One steer, as the manager holds it.
 *
 * The account is held by REFERENCE, as the extra-usage episodes hold theirs: a
 * removal renumbers every index above it and a reload renames an account in
 * place, and a reference survives both, while a removed account simply stops
 * being in the list (see AccountManager._liveSteer). The state file cannot
 * hold a reference, so it names the account by identity instead (exportSteers).
 *
 * @typedef {Object} Steer
 * @property {Record<string, any>} account  the running account new placements go to
 * @property {string} provider  the partition it steers: providerOf(account)
 * @property {number} startedAt  epoch ms
 * @property {number} until  epoch ms; never more than STEER_MAX_MS after it was set
 * @property {boolean} redeem  run the target to upstream's own weekly wall, then spend its banked reset once
 * @property {number|null} weekEnds  when the target's shared weekly window ends, as last read; a rollover past it ends the steer
 * @property {'active'|'redeeming'} phase  'redeeming' while the --redeem attempt is in flight, which owns the ending
 * @property {Promise<null>|null} [attempt]  that attempt, settled once the steer has ended or backed off
 * @property {number|null} [retryAt]  epoch ms before which no new --redeem attempt starts, after one that spent nothing
 * @property {string|null} [redeemRequestId]  the claim's request id once its irreversible request is about to go out; saved, so a restart knows a spend may have landed
 */

/**
 * What a redeemer's `redeemForSteer` answers. `outcome` is the steer's to act
 * on: 'redeemed' (spent), 'unknown' (no verdict read over a request that may
 * have spent), 'nothing-held' (nothing to spend, so asking again cannot help),
 * 'not-now' (nothing spent, and `retryAt` says when asking again could change
 * that), 'cancelled' (the steer ended before the spend).
 *
 * @typedef {Object} SteerRedeemResult
 * @property {boolean} redeemed
 * @property {string} reason
 * @property {'redeemed'|'unknown'|'nothing-held'|'not-now'|'cancelled'} [outcome]
 * @property {number} [retryAt]
 */

/**
 * A steer as status and the control plane report it.
 *
 * @typedef {Object} SteerView
 * @property {string} provider
 * @property {string} target  the account's name
 * @property {number} index  the account's position, for a reader that must tell two same-named accounts apart
 * @property {number} startedAt
 * @property {number} until
 * @property {boolean} redeem
 * @property {boolean} redeeming
 * @property {number|null} redeemRetryAt  after a --redeem attempt that spent nothing, when it asks again
 */

/** The longest a steer may run, however it is asked for: one weekly window. */
export const STEER_MAX_MS = 7 * 24 * 3600_000;

/**
 * How long a --redeem steer waits to ask again after an attempt that spent
 * nothing, when the redeemer named no back-off of its own: the redeemers'
 * own decline cooldown.
 */
export const STEER_REDEEM_RETRY_MS = 30 * 60_000;

/**
 * A steer refused for something the caller asked, safe to echo back to it:
 * the control surfaces answer it as a 400, the TUI as one line.
 */
export class SteerError extends Error {}

/**
 * Whether `account` is one a banked reset can be spent on at all: a Claude
 * subscription login, or a Codex one. An API key is metered capacity with no
 * plan windows to reset, and an Anthropic-shaped entry pointed at a third-party
 * backend (`upstream`) holds that backend's quota, not Anthropic's.
 * @param {Record<string, any>|null|undefined} account
 */
export function canRedeemOn(account) {
  if (account?.type !== 'oauth' || account.upstream) return false;
  const provider = providerOf(account);
  return provider === DEFAULT_PROVIDER || provider === 'codex';
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3600_000, d: 24 * 3600_000 };

/**
 * A steer's length as the operator wrote it, in ms, or null when it is not a
 * positive length.
 *
 * A number is seconds, as the endpoint's other durations are (`retry-after`,
 * `quotaProbeSeconds`). A string is either a bare number of seconds or units
 * run together the way the CLI prints them: `90m`, `6h`, `1d12h`, `2h30m`.
 * Anything else is refused rather than guessed at, since a misread unit is a
 * steer that runs a thousand times longer than asked.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseSteerDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds * 1000 : null;
  }
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(text)) return null;
  let ms = 0;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) ms += Number(n) * UNIT_MS[/** @type {'s'|'m'|'h'|'d'} */ (unit)];
  return ms > 0 ? ms : null;
}

/**
 * When a steer asked for with `for` (a length) or `until` (an ISO time) ends,
 * clamped to STEER_MAX_MS from `now`. Neither means the longest: the steer runs
 * until something else ends it (the weekly wall, a rollover), and the cap is
 * what stops one forgotten for good. `clamped` says the cap shortened what was
 * asked, so the caller can say so.
 *
 * @param {{ for?: unknown, until?: unknown }} spec
 * @param {number} [now]
 * @returns {{ until: number, clamped: boolean } | { error: string }}
 */
export function resolveSteerUntil(spec, now = Date.now()) {
  const forValue = spec?.for;
  const untilValue = spec?.until;
  const cap = now + STEER_MAX_MS;
  if (forValue != null && untilValue != null) return { error: 'give "for" or "until", not both' };
  if (forValue != null) {
    const ms = parseSteerDuration(forValue);
    if (ms == null) return { error: '"for" must be a positive number of seconds or a duration like 90m, 6h or 1d12h' };
    return { until: Math.min(now + ms, cap), clamped: now + ms > cap };
  }
  if (untilValue != null) {
    const at = typeof untilValue === 'string' ? Date.parse(untilValue) : NaN;
    if (!Number.isFinite(at)) return { error: '"until" must be an ISO 8601 time, e.g. 2026-10-23T18:00:00Z' };
    if (at <= now) return { error: '"until" is already in the past' };
    return { until: Math.min(at, cap), clamped: at > cap };
  }
  return { until: cap, clamped: false };
}

/**
 * `5h12m`, `3d4h`, `45m` — how long is left, in the form the TUI's reset
 * countdowns use, so a steer's clock reads like every other clock on screen.
 * @param {number} ms
 */
export function formatSteerLeft(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh ? `${days}d${rh}h` : `${days}d`;
}

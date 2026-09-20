/**
 * Burn-rate projection for quota buckets.
 *
 * Each bucket reports utilization as a 0-1 fraction. Sampling that over a
 * rolling window gives a consumption rate, and the rate against the bucket's
 * known reset answers the question the bars cannot: will this window stop you
 * before it resets, or expire with quota unspent?
 *
 * The rate is a least-squares slope rather than a first-to-last delta, so one
 * large response does not swing the figure. The window is a trade: consumption
 * is bursty and a recent-rate estimate is meant to track it, but utilization
 * arrives quantised to whole percent, so too narrow a window contains no step
 * to measure. Nothing is reported rather than a fabricated rate when the
 * samples cannot support one.
 */

/** Every bucket that reports utilization, in the order the TUI shows them. */
export const PROJECTED_BUCKETS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable'];

/** Buckets whose leftovers are worth reporting. A 5h window refills the same
 *  day, so its unspent tail costs nothing and is never reported as a surplus. */
const WEEKLY_BUCKETS = new Set(['unified7d', 'unified7dSonnet', 'unified7dFable']);

/** Row labels, matching the TUI's bar labels so one tag reads against them. */
const BUCKET_LABELS = {
  unified5h: 'Ses',
  unified7d: 'Wk',
  unified7dSonnet: 'S7',
  unified7dFable: 'F7',
};

/** Two samples one second apart would extrapolate a burst across a whole week.
 *  Below this span the samples are kept but no rate is reported. */
const MIN_SPAN_MS = 5 * 60_000;

/** Utilization is reported as whole percent, so the signal is a staircase with
 *  1% steps. A window narrower than this can contain no step at all: measured
 *  against a 1%/h burn, a 30-minute window reports nothing half the time and
 *  ranges 0.4-2.9%/h when it does speak, while 90 minutes holds 0.9-1.1%/h. */
const DEFAULT_WINDOW_MINUTES = 90;

/** The floor a fitted slope must clear to count as consumption at all.
 *
 *  `> 0` is not that test. The least-squares sums below cancel to a residue
 *  rather than to zero on a PERFECTLY FLAT series, and the residue keeps the
 *  sign of whichever rounding happened to survive: a series pinned at 0.51 or
 *  0.68 fits a slope of ~1e-22 and reads as consumption, while 0.42 or 0.29
 *  cancel exactly and report nothing. Same flat input, opposite answers,
 *  decided by the binary expansion of the reading.
 *
 *  It is not a rounding curiosity downstream. A rate of 1e-22 puts exhaustion
 *  ~1e19 years out, which clears `exhaustsInMs <= resetInMs` and lands in the
 *  surplus branch, so a wholly idle account announces "Wk 49% unspent" — a
 *  waste warning derived from a burn that was never measured, and one this
 *  module's own contract says it would not fabricate.
 *
 *  The floor sits in an empty band, so it cannot discard a real reading.
 *  Utilization arrives quantised to whole percent, so the slowest rate that is
 *  measurable at all is one 1% step across a 90-minute window — about 1.9e-9
 *  per ms. This is six orders below that and seven above the noise it rejects.
 */
const MIN_RATE = 1e-15;

export class QuotaProjection {
  constructor({ enabled = true, windowMinutes = DEFAULT_WINDOW_MINUTES, wasteFloor = 0.1 } = {}) {
    this.enabled = enabled !== false;
    this.windowMs = Math.max(1, windowMinutes) * 60_000;
    this.wasteFloor = Math.max(0, Math.min(1, wasteFloor));
    /** @type {Map<string, Array<{t: number, u: number}>>} */
    this.samples = new Map();
  }

  /** The settings in force, for the status readout. */
  settings() {
    return {
      enabled: this.enabled,
      windowMinutes: this.windowMs / 60_000,
      wasteFloor: this.wasteFloor,
    };
  }

  /** Record one utilization reading. A null reading means the window rolled
   *  (_clearExpiredQuotas nulls the bucket at its reset), so the history is
   *  dropped: without this the roll reads as a large negative burn.
   *
   *  `accountIndex` is only ever a map key here — concatenated, never indexed
   *  with — so a caller with a series that is not one account's may name it
   *  whatever is unambiguous. The fleet view samples each provider pool's
   *  aggregate under `fleet:<provider>`, which needs nothing of this module.
   *
   *  @param {number|string} accountIndex
   *  @param {string} bucket
   *  @param {number|null|undefined} utilization
   *  @param {number} [at] */
  record(accountIndex, bucket, utilization, at = Date.now()) {
    if (!this.enabled) return;
    const key = `${accountIndex}:${bucket}`;
    if (utilization == null || isNaN(utilization)) {
      this.samples.delete(key);
      return;
    }
    let list = this.samples.get(key);
    if (!list) {
      list = [];
      this.samples.set(key, list);
    }
    // A window can also roll as a decrease: a probe reports the fresh window
    // before _clearExpiredQuotas nulls the bucket. Utilization never falls
    // within a window, so a drop means the same restart a null does.
    if (list.length && utilization < list[list.length - 1].u) list.length = 0;
    list.push({ t: at, u: utilization });
    const cutoff = at - this.windowMs;
    while (list.length && list[0].t < cutoff) list.shift();
  }

  /** Consumption in utilization per millisecond, or null when the samples in
   *  the window cannot support an estimate (too few, too short a span, or no
   *  measurable consumption).
   *
   *  @param {number|string} accountIndex
   *  @param {string} bucket */
  rate(accountIndex, bucket) {
    if (!this.enabled) return null;
    const list = this.samples.get(`${accountIndex}:${bucket}`);
    if (!list || list.length < 2) return null;
    const span = list[list.length - 1].t - list[0].t;
    if (span < MIN_SPAN_MS) return null;

    // Times are relative to the first sample: epoch milliseconds squared loses
    // precision in the sums below.
    const t0 = list[0].t;
    let sumT = 0, sumU = 0, sumTT = 0, sumTU = 0;
    for (const { t, u } of list) {
      const x = t - t0;
      sumT += x;
      sumU += u;
      sumTT += x * x;
      sumTU += x * u;
    }
    const n = list.length;
    const denom = n * sumTT - sumT * sumT;
    if (denom === 0) return null;
    const slope = (n * sumTU - sumT * sumU) / denom;
    return slope > MIN_RATE ? slope : null;
  }

  /**
   * Project one bucket against its reset.
   * @param {number|string} accountIndex
   * @param {string} bucket
   * @param {{utilization?: number|null, resetAt?: number|null, now?: number}} [sample]
   * @returns {{bucket: string, kind: 'deficit'|'surplus', exhaustsInMs?: number,
   *   unspent?: number, resetInMs: number} | null}
   */
  project(accountIndex, bucket, { utilization, resetAt, now = Date.now() } = {}) {
    if (!this.enabled) return null;
    if (utilization == null || resetAt == null) return null;
    const rate = this.rate(accountIndex, bucket);
    if (rate == null) return null;

    const resetInMs = resetAt - now;
    const remaining = 1 - utilization;
    if (remaining <= 0) return { bucket, kind: 'deficit', exhaustsInMs: 0, resetInMs };

    const exhaustsInMs = remaining / rate;
    if (exhaustsInMs <= resetInMs) return { bucket, kind: 'deficit', exhaustsInMs, resetInMs };

    if (!WEEKLY_BUCKETS.has(bucket)) return null;
    const unspent = remaining - rate * resetInMs;
    if (unspent < this.wasteFloor) return null;
    return { bucket, kind: 'surplus', unspent, resetInMs };
  }

  /** Projections in display order: anything that will stop you comes before
   *  anything that will merely expire, soonest and largest first. */
  rank(projections) {
    const rank = p => (p.kind === 'deficit' ? 0 : 1);
    return (projections || []).filter(Boolean).sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.kind === 'deficit' ? a.exhaustsInMs - b.exhaustsInMs : b.unspent - a.unspent;
    });
  }

  /** The most urgent projection, or null when there is nothing to report. */
  headline(projections) {
    return this.rank(projections)[0] || null;
  }
}

/**
 * Render a projection as a row tag, e.g. "Ses TTL 38m" or "Wk 22% unspent".
 *
 * An account row carries every bucket's tag on one line, so each has to name the
 * bucket it is about. The fleet block gives each bucket a line of its own, with
 * the label already at the start of it, so `withLabel: false` drops the repeat
 * rather than making that caller reimplement the durations and lose the one
 * spelling of "2d4h" this codebase has.
 *
 * @param {{bucket: string, kind: 'deficit'|'surplus', exhaustsInMs?: number, unspent?: number}|null} projection
 * @param {{withLabel?: boolean}} [options]
 */
export function formatProjection(projection, { withLabel = true } = {}) {
  if (!projection) return null;
  const label = withLabel ? `${BUCKET_LABELS[projection.bucket] || projection.bucket} ` : '';
  if (projection.kind === 'deficit') return `${label}TTL ${formatDuration(projection.exhaustsInMs)}`;
  return `${label}${Math.round(projection.unspent * 100)}% unspent`;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

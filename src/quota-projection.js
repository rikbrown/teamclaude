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
   *  dropped: without this the roll reads as a large negative burn. */
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
   *  measurable consumption). */
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
    return slope > 0 ? slope : null;
  }

  /**
   * Project one bucket against its reset.
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

/** Render a projection as a row tag, e.g. "Ses TTL 38m" or "Wk 22% unspent". */
export function formatProjection(projection) {
  if (!projection) return null;
  const label = BUCKET_LABELS[projection.bucket] || projection.bucket;
  if (projection.kind === 'deficit') return `${label} TTL ${formatDuration(projection.exhaustsInMs)}`;
  return `${label} ${Math.round(projection.unspent * 100)}% unspent`;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

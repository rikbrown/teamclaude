// Output throughput: how fast each request generated its answer, and how fast
// the whole fleet is generating right now. Opt-in (`throughputMeter`), and the
// TUI is the only reader.
//
// Two halves, one per process role. The proxy tags each streamed response with
// an OutputTracker, which reads the SSE events the usage parser has ALREADY
// parsed: it never parses a line of its own. The TUI keeps a ThroughputMeter,
// fed by the tracker's per-event increments while a response streams and by
// the settled token count once it has finished.
//
// WHY AN ESTIMATE AT ALL. Neither dialect reports output tokens as they are
// generated: Anthropic states them once, cumulatively, in `message_delta` near
// the end, and a Responses stream only in its terminal event. A live figure has
// to come from the text itself, so the meter counts streamed characters and
// divides by CHARS_PER_TOKEN, then corrects to the exact count when it lands.
//
// Pure: no I/O, and every function that needs the time takes it, or takes a
// clock, so the tests drive time by hand.

/** Characters per output token, for the live estimate only. English prose and
 *  code both sit near four; the exact count replaces the guess at completion,
 *  so a better constant would only move where the needle waits for it. */
export const CHARS_PER_TOKEN = 4;

/** Seconds the fleet rate is averaged over. Short enough that the needle
 *  follows the fleet within a few seconds and an idle fleet reads zero ten
 *  seconds after its last token. Long enough to smooth over the bursts a
 *  stream arrives in, and to give a completion's correction somewhere to land:
 *  it is spread back over the seconds the tokens were generated in (see
 *  ThroughputMeter.complete), and only the part inside this window moves the
 *  needle. */
export const WINDOW_SEC = 10;

/** One-second buckets kept. The window reads the newest WINDOW_SEC of them; the
 *  rest is room for a correction that reaches back further than the window. */
export const RING_SEC = 60;

/** Shortest generation interval a per-request rate is shown for. A reply that
 *  arrives in one burst has no measurable pace, and dividing by a few
 *  milliseconds would print a number nobody could have generated. */
export const MIN_INTERVAL_MS = 250;

/** Streaming time before an in-progress request shows a live estimate. The
 *  first deltas arrive together, so an earlier figure is mostly noise. */
export const LIVE_AFTER_MS = 1_000;

/** Floor of the dial's scale, in tok/s: an idle fleet's needle rests on a scale
 *  that means something rather than one that stretches a trickle to full. */
export const MIN_SCALE = 100;

// The recent peak halves every two minutes, so the scale comes back down a few
// minutes after a burst rather than on the next quiet second.
const PEAK_HALF_LIFE_MS = 120_000;
// The scale shrinks only once the decayed peak, with this much room above it,
// fits a smaller step. It grows as soon as the rate passes it. The gap between
// the two is what keeps a rate near a step boundary from flipping the scale.
const SHRINK_HEADROOM = 1.25;

// Anthropic content deltas carry their text under one of these, by delta type:
// `text_delta`, `thinking_delta`, `input_json_delta`. A `signature_delta` (the
// thinking block's seal) carries none and counts as a boundary.
const ANTHROPIC_DELTA_FIELDS = /** @type {const} */ (['text', 'thinking', 'partial_json']);

// Responses deltas that stream generated text in `.delta`: the answer, the
// reasoning (summarised or raw), and tool-call arguments. Named rather than
// matched by suffix, as responses-usage.js names its terminal events, because
// `response.audio.delta` carries base64 audio in the same field.
const RESPONSES_TEXT_DELTAS = new Set([
  'response.output_text.delta',
  'response.refusal.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta',
]);

// Where a block of output starts or ends. These carry no text, but they mark
// generation all the same: a thinking block whose text is omitted, or a
// Responses reasoning item that streams nothing but its encrypted content, is
// generated between its start and its end. Counting only the deltas would time
// such a turn from its first VISIBLE token and credit the hidden ones to a
// sliver of the stream.
const BOUNDARY_EVENTS = new Set([
  'content_block_start', 'content_block_stop',
  'response.output_item.added', 'response.output_item.done',
]);

/**
 * What one parsed SSE event says about generated output: -1 when it is not
 * output at all (lifecycle, usage, ping), else the characters of text it
 * streams, which is 0 for a block boundary or a delta carrying no text.
 *
 * @param {any} event
 * @returns {number}
 */
export function contentChars(event) {
  const type = event?.type;
  if (type === 'content_block_delta') {
    const delta = event.delta;
    for (const field of ANTHROPIC_DELTA_FIELDS) {
      const text = delta?.[field];
      if (typeof text === 'string') return text.length;
    }
    return 0;
  }
  if (RESPONSES_TEXT_DELTAS.has(type)) return typeof event.delta === 'string' ? event.delta.length : 0;
  return BOUNDARY_EVENTS.has(type) ? 0 : -1;
}

/** @typedef {(reqId: number, progress: { chars: number, at: number }) => void} ProgressHook */

/**
 * One response's output, as the proxy relays it. Created per request only while
 * the meter is on, so with it off the stream reader's whole cost is testing its
 * reference for null.
 *
 * Only the attempt whose body reaches the client ever feeds it. The stream
 * parser runs after the response headers are written, and nothing fails over
 * once they are: a refused or retried attempt is cancelled unread, and a peeked
 * stream is replayed through the same single parse.
 */
export class OutputTracker {
  /**
   * @param {number} reqId the activity entry the progress belongs to
   * @param {ProgressHook} onProgress called once per output event, with the increment
   * @param {() => number} [now]
   */
  constructor(reqId, onProgress, now = Date.now) {
    this.reqId = reqId;
    this.onProgress = onProgress;
    this.now = now;
    /** @type {number|null} ms epoch of the first output event */
    this.firstTokenAt = null;
    /** @type {number|null} ms epoch of the latest output event */
    this.lastTokenAt = null;
    /** Characters of text streamed so far. */
    this.chars = 0;
    /** @type {number|null} settled output tokens, once upstream has stated them */
    this.outputTokens = null;
  }

  /** Read one parsed SSE event.
   *  @param {any} event */
  event(event) {
    const chars = contentChars(event);
    if (chars < 0) return;
    const at = this.now();
    if (this.firstTokenAt === null) this.firstTokenAt = at;
    this.lastTokenAt = at;
    this.chars += chars;
    this.onProgress(this.reqId, { chars, at });
  }

  /** The settled output count. The last report wins, because both dialects
   *  state a cumulative figure; anything but a finite count is ignored.
   *  @param {unknown} tokens */
  settle(tokens) {
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) this.outputTokens = tokens;
  }

  /** The fields the request's end hook carries. */
  summary() {
    return { outputTokens: this.outputTokens, firstTokenAt: this.firstTokenAt, lastTokenAt: this.lastTokenAt };
  }
}

/**
 * The exact rate of a finished request in tok/s, or null when there is none to
 * show: the count is unknown or zero, or the interval is too short to measure.
 *
 * The interval is the generation, first output event to last, when the
 * response streamed. A buffered response has no such interval, so its whole
 * duration stands in for it, time to first token included.
 *
 * @param {{ outputTokens?: number|null, firstAt?: number|null, lastAt?: number|null, startedAt?: number|null, endedAt?: number|null }} r
 * @returns {number|null}
 */
export function requestRate({ outputTokens, firstAt = null, lastAt = null, startedAt = null, endedAt = null }) {
  if (typeof outputTokens !== 'number' || !(outputTokens > 0)) return null;
  const span = firstAt != null && lastAt != null ? lastAt - firstAt
    : startedAt != null && endedAt != null ? endedAt - startedAt
      : NaN;
  return span >= MIN_INTERVAL_MS ? outputTokens / (span / 1000) : null;
}

/**
 * The estimated rate of a request still streaming, or null until it has
 * streamed text for LIVE_AFTER_MS. Estimated from its characters, so a stream
 * whose reasoning is hidden reads low until the exact count lands.
 *
 * @param {{ chars?: number, firstAt?: number|null, now: number }} r
 * @returns {number|null}
 */
export function liveRate({ chars = 0, firstAt = null, now }) {
  if (firstAt == null || !(chars > 0)) return null;
  const span = now - firstAt;
  return span >= LIVE_AFTER_MS ? chars / CHARS_PER_TOKEN / (span / 1000) : null;
}

/**
 * A rate as the TUI prints it: `84`, `950`, `1.4k`, `12k`, `1.2M`.
 * @param {number} n tok/s
 */
export function formatRate(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 999.5) return String(Math.round(v));
  if (v < 9_950) return `${(v / 1_000).toFixed(1)}k`;
  if (v < 999_500) return `${Math.round(v / 1_000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/**
 * The smallest 1, 2 or 5 × 10ⁿ at or above `v`, and never below MIN_SCALE.
 * @param {number} v
 */
export function niceCeil(v) {
  if (!(v > MIN_SCALE)) return MIN_SCALE;
  const base = 10 ** Math.floor(Math.log10(v));
  // The tolerance absorbs log10's rounding, so a value already on a step (1000)
  // stays there instead of moving up to the next one.
  for (const m of [1, 2, 5, 10]) if (m * base >= v * (1 - 1e-12)) return m * base;
  return 10 * base;
}

const mod = (/** @type {number} */ x, /** @type {number} */ n) => ((x % n) + n) % n;

/**
 * The fleet's output rate: tokens generated across every request in the last
 * WINDOW_SEC seconds, divided by WINDOW_SEC, kept in one-second buckets.
 *
 * A streaming request adds its estimate as it arrives. When it finishes, the
 * difference between the exact count and that estimate is spread evenly over
 * the seconds it generated in, so a turn that streamed little text but many
 * tokens (hidden or summarised reasoning) puts them back where they were made
 * rather than into one spike at the end. A buffered response, which streamed
 * nothing, spreads its whole count over its duration.
 */
export class ThroughputMeter {
  /** @param {{ now?: () => number, windowSec?: number, ringSec?: number }} [opts] */
  constructor({ now = Date.now, windowSec = WINDOW_SEC, ringSec = RING_SEC } = {}) {
    this.now = now;
    this.windowSec = windowSec;
    this.ring = new Float64Array(Math.max(ringSec, windowSec + 1));
    /** @type {number|null} the second the newest bucket holds */
    this.headSec = null;
    /** ms epoch of the latest token written anywhere in the ring. */
    this.lastAt = -Infinity;
    /** Recent peak rate, decayed (PEAK_HALF_LIFE_MS). */
    this.peak = 0;
    /** @type {number|null} when the peak was last decayed */
    this.sampledAt = null;
    /** The dial's full-scale value. */
    this.scale = MIN_SCALE;
  }

  /** Estimated tokens from `chars` of text streamed at `at`.
   *  @param {number} chars @param {number} [at] */
  progress(chars, at = this.now()) {
    if (chars > 0) this._bump(Math.floor(at / 1000), chars / CHARS_PER_TOKEN, at);
  }

  /**
   * Settle a finished request. `chars` is what it streamed, and so what
   * progress() already estimated; without an exact count the estimate stands.
   *
   * @param {{ outputTokens?: number|null, chars?: number, firstAt?: number|null, lastAt?: number|null, startedAt?: number|null, endedAt?: number|null }} r
   */
  complete({ outputTokens = null, chars = 0, firstAt = null, lastAt = null, startedAt = null, endedAt = null }) {
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return;
    if (firstAt != null) {
      this._spread(outputTokens - chars / CHARS_PER_TOKEN, firstAt, lastAt ?? firstAt);
    } else if (endedAt != null) {
      this._spread(outputTokens, startedAt ?? endedAt, endedAt);
    }
  }

  /** Fleet tok/s over the window ending at `at`.
   *  @param {number} [at] */
  rate(at = this.now()) {
    const sec = Math.floor(at / 1000);
    this._advance(sec);
    const n = this.ring.length;
    const w = this.windowSec;
    // The current second is partly elapsed, so the window takes the same
    // fraction LESS of the second it reaches back into: exactly `w` seconds
    // either way, and the needle slides between buckets instead of stepping.
    const into = (at - sec * 1000) / 1000;
    let sum = 0;
    for (let k = 0; k < w; k++) sum += this.ring[mod(sec - k, n)];
    sum += this.ring[mod(sec - w, n)] * (1 - into);
    return Math.max(0, sum / w);
  }

  /** Whether any token landed in the window ending at `at`.
   *  @param {number} [at] */
  recent(at = this.now()) {
    return at - this.lastAt < this.windowSec * 1000;
  }

  /**
   * Read the rate for display, moving the peak and the scale with it. Call once
   * per frame: the peak's decay is by elapsed time, so the cadence does not
   * matter, but the scale only learns of a rate it is shown.
   *
   * @param {number} [at]
   * @returns {{ rate: number, peak: number, scale: number }}
   */
  sample(at = this.now()) {
    const rate = this.rate(at);
    const dt = this.sampledAt === null ? 0 : Math.max(0, at - this.sampledAt);
    this.sampledAt = at;
    this.peak = Math.max(rate, this.peak * 0.5 ** (dt / PEAK_HALF_LIFE_MS));
    if (rate > this.scale) {
      this.scale = niceCeil(rate);
    } else {
      const fit = niceCeil(this.peak * SHRINK_HEADROOM);
      if (fit < this.scale) this.scale = fit;
    }
    return { rate, peak: this.peak, scale: this.scale };
  }

  /** Move the ring's head forward to `sec`, emptying the seconds it passes.
   *  @param {number} sec */
  _advance(sec) {
    if (this.headSec === null) { this.headSec = sec; return; }
    if (sec <= this.headSec) return;
    const n = this.ring.length;
    const steps = Math.min(sec - this.headSec, n);
    for (let k = 1; k <= steps; k++) this.ring[mod(this.headSec + k, n)] = 0;
    this.headSec = sec;
  }

  /** Add `tokens` to second `sec`, if it is still in the ring. Never below zero:
   *  a correction that takes more than a bucket holds takes it to zero.
   *  @param {number} sec @param {number} tokens @param {number} at */
  _bump(sec, tokens, at) {
    this._advance(sec);
    const head = /** @type {number} */ (this.headSec);
    if (sec <= head - this.ring.length) return;
    const i = mod(sec, this.ring.length);
    this.ring[i] = Math.max(0, this.ring[i] + tokens);
    if (at > this.lastAt) this.lastAt = at;
  }

  /** `tokens` spread evenly over [from, to], the part inside the ring only.
   *  @param {number} tokens @param {number} from @param {number} to */
  _spread(tokens, from, to) {
    if (!Number.isFinite(tokens) || tokens === 0) return;
    if (!(to > from)) { this._bump(Math.floor(to / 1000), tokens, to); return; }
    const last = Math.floor(to / 1000);
    this._advance(last);
    const head = /** @type {number} */ (this.headSec);
    const first = Math.max(Math.floor(from / 1000), head - this.ring.length + 1);
    const perMs = tokens / (to - from);
    for (let s = first; s <= last; s++) {
      const lo = Math.max(from, s * 1000);
      const hi = Math.min(to, (s + 1) * 1000);
      if (hi > lo) this._bump(s, perMs * (hi - lo), Math.min(to, hi));
    }
  }
}

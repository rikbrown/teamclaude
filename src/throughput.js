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
// the end, and a Responses stream only in its terminal event. And the text a
// stream shows is a poor guide to what it generates: a reasoning model spends
// most of its tokens on thinking that is hidden or summarised, so a turn can
// stream a few hundred characters for thousands of tokens. So an in-flight
// stream is estimated from how long it has been generating, at the pace its
// model has been measured at, with the text it has shown as a floor (see
// ThroughputMeter). Only exact counts are ever booked.
//
// Pure: no I/O, and every function that needs the time takes it, or takes a
// clock, so the tests drive time by hand.

/** Characters per output token, for the floor under a live estimate. English
 *  prose and code both sit near four. It is only ever a floor: the tokens a
 *  stream has generated are at least the tokens it has shown. */
export const CHARS_PER_TOKEN = 4;

/** Seconds the fleet rate is averaged over. Short enough that the needle
 *  follows the fleet within a few seconds and an idle fleet reads zero ten
 *  seconds after its last token. Long enough to smooth over the bursts a
 *  stream arrives in, and to hold a fair share of a finished stream's tokens:
 *  they are spread over the seconds they were generated in, and only the part
 *  inside this window moves the needle. */
export const WINDOW_SEC = 10;

/** One-second buckets kept. The window reads the newest WINDOW_SEC of them; the
 *  rest is room for a finished stream whose generation reaches back further. */
export const RING_SEC = 60;

/** The most output tokens one request is booked for. Far past any real turn;
 *  it is here so a wild count from upstream cannot carry the scale to Infinity. */
export const MAX_REQUEST_TOKENS = 10_000_000;

/** The fastest a single stream is taken to generate, in tok/s, when a finished
 *  one teaches its model's pace. A stream that arrives all at once has no pace
 *  to learn, and without a ceiling one such turn would inflate every estimate
 *  for that model until enough slower turns had averaged it away. */
export const MAX_STREAM_RATE = 5_000;

/** Shortest generation interval a per-request rate is shown for. A reply that
 *  arrives in one burst has no measurable pace, and dividing by a few
 *  milliseconds would print a number nobody could have generated. */
export const MIN_INTERVAL_MS = 250;

/** Generating time before an in-progress request shows a live estimate. The
 *  first deltas arrive together, so an earlier figure is mostly noise. */
export const LIVE_AFTER_MS = 1_000;

/** How much of each finished turn's rate goes into its model's pace. A quarter:
 *  one odd turn moves the estimate a little, and a model that really changes
 *  pace is followed within a handful of turns. */
export const MODEL_RATE_WEIGHT = 0.25;

/** Models whose pace is remembered. A fleet uses a handful; past this the one
 *  heard from least recently is forgotten. */
export const MODEL_RATE_KEYS = 32;

/** In-flight streams the meter follows at once. Every stream is settled when
 *  its request ends, so this is a bound against a leak, not a working limit. */
export const MAX_STREAMS = 512;

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
    /** @type {number|null} ms epoch the upstream attempt that answered was sent */
    this.dispatchedAt = null;
  }

  /** The upstream attempt is being sent now. Called once per attempt, so the
   *  one that answered is the last: a buffered response is timed from here,
   *  which leaves out the holds, the queueing and the attempts before it. */
  dispatched() {
    this.dispatchedAt = this.now();
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
    return { outputTokens: this.outputTokens, firstTokenAt: this.firstTokenAt, lastTokenAt: this.lastTokenAt, dispatchedAt: this.dispatchedAt };
  }
}

/** A finite time, or null. @param {unknown} v */
const time = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A token count clamped to what one request can be booked for, or null when it
 *  is not a count at all. @param {unknown} v */
const tokens = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_REQUEST_TOKENS) : null);

/**
 * The exact rate of a finished request in tok/s, or null when there is none to
 * show: the count is unknown or zero, or the interval is too short to measure.
 *
 * The interval is the generation, first output event to last, when the
 * response streamed. A buffered response has no such interval, so the time
 * from dispatching the attempt that answered to the end stands in for it,
 * time to first token included.
 *
 * @param {{ outputTokens?: number|null, firstAt?: number|null, lastAt?: number|null, startedAt?: number|null, endedAt?: number|null }} r
 * @returns {number|null}
 */
export function requestRate({ outputTokens, firstAt = null, lastAt = null, startedAt = null, endedAt = null }) {
  const n = tokens(outputTokens);
  if (!n) return null;
  const first = time(firstAt);
  const last = time(lastAt);
  const from = time(startedAt);
  const to = time(endedAt);
  const span = first !== null && last !== null ? last - first
    : from !== null && to !== null ? to - from
      : NaN;
  return span >= MIN_INTERVAL_MS ? n / (span / 1000) : null;
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
  if (!Number.isFinite(v)) return MIN_SCALE;
  const base = 10 ** Math.floor(Math.log10(v));
  // The tolerance absorbs log10's rounding, so a value already on a step (1000)
  // stays there instead of moving up to the next one.
  for (const m of [1, 2, 5, 10]) if (m * base >= v * (1 - 1e-12)) return m * base;
  return 10 * base;
}

const mod = (/** @type {number} */ x, /** @type {number} */ n) => ((x % n) + n) % n;

/** @typedef {{ chars: number, firstAt: number, lastAt: number, model: string|null }} Stream */

/**
 * The fleet's output rate: tokens generated across every request in the last
 * WINDOW_SEC seconds, divided by WINDOW_SEC.
 *
 * TWO KINDS OF TOKEN, KEPT APART. The one-second buckets hold only SETTLED
 * tokens: a finished stream's exact count, spread evenly over the seconds from
 * its first output event to its last. Nothing is ever taken back out of them,
 * because nothing that goes in is a guess.
 *
 * A stream still in flight is never written to the buckets. Each reading
 * works out its share afresh: its estimate so far, spread evenly over the time
 * it has been generating, and the part of that inside the window. The estimate
 * is the larger of its text (CHARS_PER_TOKEN) and its generating time at its
 * model's measured pace. The pace is learnt from that model's finished turns;
 * until there is one, the text alone stands. So a reasoning turn that streams
 * a few hundred characters for thousands of tokens reads at its model's usual
 * pace while it runs, not at the pace of its visible text, and its exact count
 * replaces the estimate when it lands with a small step rather than a jump.
 *
 * Generating time runs from the stream's first output event to now, not to its
 * latest one: hidden thinking sends nothing while it thinks.
 */
export class ThroughputMeter {
  /** @param {{ now?: () => number, windowSec?: number, ringSec?: number }} [opts] */
  constructor({ now = Date.now, windowSec = WINDOW_SEC, ringSec = RING_SEC } = {}) {
    this.now = now;
    this.windowSec = windowSec;
    this.ring = new Float64Array(Math.max(ringSec, windowSec + 1));
    /** @type {number|null} the second the newest bucket holds */
    this.headSec = null;
    /** @type {Map<unknown, Stream>} streams in flight, by request id */
    this.streams = new Map();
    /** @type {Map<string, number>} each model's measured pace, tok/s, least recently heard first */
    this.paces = new Map();
    /** Recent peak rate, decayed (PEAK_HALF_LIFE_MS). */
    this.peak = 0;
    /** @type {number|null} when the peak was last decayed */
    this.sampledAt = null;
    /** The dial's full-scale value. */
    this.scale = MIN_SCALE;
  }

  /**
   * Output streamed for request `id`: `chars` of text at `at`, from `model`.
   * The first call starts the stream's generating time.
   * @param {unknown} id @param {number} chars @param {number} at @param {string|null} [model]
   */
  progress(id, chars, at, model = null) {
    const t = time(at);
    if (t === null) return;
    const n = typeof chars === 'number' && Number.isFinite(chars) && chars > 0 ? chars : 0;
    let s = this.streams.get(id);
    if (!s) {
      if (this.streams.size >= MAX_STREAMS) this.streams.delete(this.streams.keys().next().value);
      s = { chars: 0, firstAt: t, lastAt: t, model: null };
      this.streams.set(id, s);
    }
    s.chars += n;
    if (t > s.lastAt) s.lastAt = t;
    if (model) s.model = model;
  }

  /**
   * Request `id` has ended. With an exact count, that count is booked over its
   * generation, first output event to last, and the turn teaches its model's
   * pace. A buffered response streamed nothing, so its count is booked from
   * the dispatch of the attempt that answered to the end.
   *
   * With no count (a client that left, a stream that died), a stream books the
   * part of its estimate it can vouch for, its visible text, and not the part
   * that was a guess from its model's pace.
   *
   * @param {unknown} id
   * @param {{ outputTokens?: number|null, firstAt?: number|null, lastAt?: number|null, dispatchedAt?: number|null, endedAt?: number|null, model?: string|null }} [r]
   */
  finish(id, { outputTokens = null, firstAt = null, lastAt = null, dispatchedAt = null, endedAt = null, model = null } = {}) {
    const s = this.streams.get(id);
    this.streams.delete(id);
    const end = time(endedAt);
    if (end !== null) this._observe(end);
    const n = tokens(outputTokens);
    const first = time(firstAt) ?? s?.firstAt ?? null;
    const last = time(lastAt) ?? s?.lastAt ?? first;
    if (n === null) {
      if (s && first !== null && last !== null) this._spread(s.chars / CHARS_PER_TOKEN, first, last);
      return;
    }
    if (first !== null && last !== null) {
      this._spread(n, first, last);
      const pace = requestRate({ outputTokens: n, firstAt: first, lastAt: last });
      const name = model || s?.model;
      if (pace !== null && name) this._learn(name, Math.min(pace, MAX_STREAM_RATE));
      return;
    }
    const from = time(dispatchedAt);
    if (end !== null) this._spread(n, from ?? end, end);
  }

  /** The measured pace of `model`, tok/s, or null before any of its turns has
   *  finished with a count. @param {string|null|undefined} model */
  modelRate(model) {
    return model ? this.paces.get(model) ?? null : null;
  }

  /** Tokens a stream in flight has generated by `at`, by estimate, and for how
   *  long it has been generating.
   *  @param {Stream} s @param {number} at */
  _estimate(s, at) {
    const genMs = Math.max(0, at - s.firstAt);
    const pace = this.modelRate(s.model) ?? 0;
    const est = Math.min(Math.max(s.chars / CHARS_PER_TOKEN, (genMs / 1000) * pace), MAX_REQUEST_TOKENS);
    return { est, genMs };
  }

  /** The estimated rate of request `id` while it streams, or null before it has
   *  been generating for LIVE_AFTER_MS or while there is nothing to estimate
   *  from. The same estimate the fleet reading uses, over its generating time.
   *  @param {unknown} id @param {number} [at] */
  liveRate(id, at = this.now()) {
    const s = this.streams.get(id);
    if (!s) return null;
    const { est, genMs } = this._estimate(s, at);
    return genMs >= LIVE_AFTER_MS && est > 0 ? est / (genMs / 1000) : null;
  }

  /** Fleet tok/s over the window ending at `at`.
   *  @param {number} [at] */
  rate(at = this.now()) {
    const t = this._observe(at);
    const sec = Math.floor(t / 1000);
    const n = this.ring.length;
    const w = this.windowSec;
    // The current second is partly elapsed, so the window takes the same
    // fraction LESS of the second it reaches back into: exactly `w` seconds
    // either way, and the needle slides between buckets instead of stepping.
    const into = Math.min(1, Math.max(0, (t - sec * 1000) / 1000));
    let sum = 0;
    for (let k = 0; k < w; k++) sum += this.ring[mod(sec - k, n)];
    sum += this.ring[mod(sec - w, n)] * (1 - into);
    const from = t - w * 1000;
    for (const s of this.streams.values()) {
      const { est, genMs } = this._estimate(s, t);
      if (!est) continue;
      sum += genMs > 0 ? est * (Math.min(genMs, t - from) / genMs) : est;
    }
    const r = sum / w;
    return Number.isFinite(r) && r > 0 ? r : 0;
  }

  /** Whether the reading is anything but a settled zero: a stream in flight, or
   *  tokens still in the window. The TUI keeps its fast tick for exactly as long.
   *  @param {number} [at] */
  recent(at = this.now()) {
    return this.streams.size > 0 || this.rate(at) > 0;
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
    const t = time(at) ?? 0;
    const dt = this.sampledAt === null ? 0 : Math.max(0, t - this.sampledAt);
    this.sampledAt = t;
    const decayed = this.peak * 0.5 ** (dt / PEAK_HALF_LIFE_MS);
    this.peak = Number.isFinite(decayed) ? Math.max(rate, decayed) : rate;
    if (rate > this.scale) {
      this.scale = niceCeil(rate);
    } else {
      const fit = niceCeil(this.peak * SHRINK_HEADROOM);
      if (fit < this.scale) this.scale = fit;
    }
    return { rate, peak: this.peak, scale: this.scale };
  }

  /** Fold one finished turn's pace into its model's.
   *  @param {string} model @param {number} pace */
  _learn(model, pace) {
    const was = this.paces.get(model);
    this.paces.delete(model);
    this.paces.set(model, was === undefined ? pace : was + MODEL_RATE_WEIGHT * (pace - was));
    if (this.paces.size > MODEL_RATE_KEYS) {
      const oldest = this.paces.keys().next();
      if (!oldest.done) this.paces.delete(oldest.value);
    }
  }

  /**
   * Move the ring's head to the time `at`, emptying the seconds it passes, and
   * return the time to read at. A clock that stepped back by more than a second
   * would read slots that belong to other seconds through the ring's modulo, so
   * the ring starts over there; a smaller step back is jitter, and reads at the
   * head.
   * @param {number} at
   */
  _observe(at) {
    const t = time(at) ?? (this.headSec === null ? 0 : this.headSec * 1000);
    const sec = Math.floor(t / 1000);
    if (this.headSec === null) { this.headSec = sec; return t; }
    if (sec < this.headSec - 1) {
      this.ring.fill(0);
      this.headSec = sec;
      return t;
    }
    if (sec < this.headSec) return this.headSec * 1000;
    this._advance(sec);
    return t;
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

  /** Add `amount` to second `sec`, if it is still in the ring.
   *  @param {number} sec @param {number} amount */
  _bump(sec, amount) {
    this._advance(sec);
    const head = /** @type {number} */ (this.headSec);
    if (sec <= head - this.ring.length || sec > head) return;
    this.ring[mod(sec, this.ring.length)] += amount;
  }

  /** `amount` spread evenly over [from, to], the part inside the ring only.
   *  Never negative: the ring holds only what was generated.
   *  @param {number} amount @param {number} from @param {number} to */
  _spread(amount, from, to) {
    if (!Number.isFinite(amount) || !(amount > 0)) return;
    if (!(to > from)) { this._bump(Math.floor(to / 1000), amount); return; }
    const last = Math.floor(to / 1000);
    this._advance(last);
    const head = /** @type {number} */ (this.headSec);
    const first = Math.max(Math.floor(from / 1000), head - this.ring.length + 1);
    const perMs = amount / (to - from);
    for (let s = first; s <= last; s++) {
      const lo = Math.max(from, s * 1000);
      const hi = Math.min(to, (s + 1) * 1000);
      if (hi > lo) this._bump(s, perMs * (hi - lo));
    }
  }
}

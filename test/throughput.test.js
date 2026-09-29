import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentChars, OutputTracker, ThroughputMeter, requestRate, formatRate, niceCeil,
  CHARS_PER_TOKEN, WINDOW_SEC, MIN_INTERVAL_MS, LIVE_AFTER_MS, MIN_SCALE,
  MAX_REQUEST_TOKENS, MODEL_RATE_WEIGHT, MODEL_RATE_KEYS, MAX_STREAMS,
} from '../src/throughput.js';

// The throughput meter's arithmetic, on a clock the tests move by hand. The
// server and the TUI wiring are pinned in throughput-hooks.test.js and
// tui-speedo.test.js; this file is the numbers.

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const ringTotal = (m) => m.ring.reduce((s, v) => s + v, 0);

// ------------------------------------------------------------ what is output

test('an Anthropic content delta counts the text it carries, whichever kind', () => {
  assert.equal(contentChars({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }), 5);
  assert.equal(contentChars({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm…' } }), 4);
  assert.equal(contentChars({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":' } }), 5);
  // The thinking block's seal is output being generated, but not text.
  assert.equal(contentChars({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' } }), 0);
});

test('a Responses delta counts its text for every kind the ChatGPT backend streams', () => {
  for (const type of [
    'response.output_text.delta', 'response.refusal.delta',
    'response.reasoning_summary_text.delta', 'response.reasoning_text.delta',
    'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta',
  ]) {
    assert.equal(contentChars({ type, delta: 'abc' }), 3, type);
  }
  // Same field, but base64 audio rather than generated text.
  assert.equal(contentChars({ type: 'response.audio.delta', delta: 'AAAA' }), -1);
});

// A hidden reasoning block streams no text at all, so its start and end are
// the only evidence that output was being generated in between.
test('block boundaries mark generation without counting any text', () => {
  for (const type of ['content_block_start', 'content_block_stop', 'response.output_item.added', 'response.output_item.done']) {
    assert.equal(contentChars({ type }), 0, type);
  }
});

test('lifecycle, usage and junk events are not output', () => {
  for (const e of [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', usage: { output_tokens: 9 } },
    { type: 'message_stop' }, { type: 'ping' },
    { type: 'response.created' }, { type: 'response.completed' },
    null, undefined, {}, 'content_block_delta', 42,
  ]) {
    assert.equal(contentChars(e), -1, JSON.stringify(e));
  }
});

// ------------------------------------------------------------ one response

test('the tracker times the first and last output events and reports each increment', () => {
  let now = 1_000;
  const calls = [];
  const t = new OutputTracker(7, (id, p) => calls.push([id, p]), () => now);
  t.event({ type: 'message_start', message: { usage: {} } });   // not output
  now = 1_200;
  t.event({ type: 'content_block_start' });
  now = 1_300;
  t.event({ type: 'content_block_delta', delta: { text: 'four' } });
  now = 2_500;
  t.event({ type: 'content_block_delta', delta: { text: 'ab' } });
  assert.deepEqual(calls, [[7, { chars: 0, at: 1_200 }], [7, { chars: 4, at: 1_300 }], [7, { chars: 2, at: 2_500 }]]);
  assert.equal(t.chars, 6);
  assert.deepEqual(t.summary(), { outputTokens: null, firstTokenAt: 1_200, lastTokenAt: 2_500, dispatchedAt: null });
});

test('the settled count is the last finite one reported, and nothing else', () => {
  const t = new OutputTracker(1, () => {});
  for (const junk of [undefined, null, '12', NaN, -1, Infinity]) t.settle(junk);
  assert.equal(t.outputTokens, null);
  t.settle(10);
  t.settle(500);
  assert.equal(t.outputTokens, 500, 'both dialects report a cumulative figure, so the last one stands');
});

// ------------------------------------------------------------ the window

// Tokens as a finished stream books them: `n` spread over [from, to].
const settle = (m, id, n, from, to, model = null) => {
  m.progress(id, 0, from, model);
  m.finish(id, { outputTokens: n, firstAt: from, lastAt: to, endedAt: to, model });
};

test('the fleet rate is the settled tokens in the last WINDOW_SEC seconds over WINDOW_SEC', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 100, 95_000, 96_000);
  settle(m, 2, 200, 99_000, 100_000);
  close(m.rate(100_000), 300 / WINDOW_SEC);
});

// The window slides continuously: at half a second into second 105 it covers
// (95.5 s, 105.5 s], which is the second half of bucket 95.
test('the window takes a fraction of its oldest second, so the rate slides rather than steps', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 100, 95_000, 96_000);
  close(m.rate(105_000), 100 / WINDOW_SEC, 1e-9);
  close(m.rate(105_500), 50 / WINDOW_SEC, 1e-9);
  close(m.rate(106_000), 0, 1e-9);
});

test('a finished stream is booked evenly over the seconds it generated in', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 1_000, 90_000, 100_000);
  for (let s = 90; s <= 99; s++) close(m.ring[s % m.ring.length], 100);
  close(m.rate(100_000), 100);
});

test('a stream older than the ring lands only in the part the ring still holds', () => {
  const m = new ThroughputMeter({ now: () => 0, ringSec: 60 });
  // Two minutes of generation: the ring holds seconds 61..120, and second 120
  // starts where the stream ended, so 59 of them took 100 tokens each.
  settle(m, 1, 12_000, 0, 120_000);
  close(ringTotal(m), 5_900, 1e-6);
  close(m.rate(120_000), 100, 1e-6);   // spread evenly, so the rate is the stream's own pace
});

// What the buckets hold is exact whatever was estimated on the way: nothing
// is ever corrected, so nothing is ever clamped either. A 4,000-character
// burst (a thousand tokens of text) booking 400 tokens used to leave 940.
test('the ring holds exactly the settled count, over or under any estimate', () => {
  for (const [chars, exact] of [[4_000, 400], [40, 6_000], [0, 1_000], [2_000, 500]]) {
    const m = new ThroughputMeter({ now: () => 0 });
    m.progress('a', 0, 90_000, 'm');
    m.progress('a', chars, 99_500, 'm');
    m.finish('a', { outputTokens: exact, firstAt: 90_000, lastAt: 100_000, endedAt: 100_000, model: 'm' });
    close(ringTotal(m), exact, 1e-6);
    assert.ok([...m.ring].every(v => v >= 0));
    close(m.rate(100_000), exact / WINDOW_SEC, 1e-6);
  }
});

test('a buffered response is booked from the dispatch of the attempt that answered', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  // Held for 90 s, then answered in 5: the hold is not generation.
  m.finish('b', { outputTokens: 1_000, dispatchedAt: 95_000, endedAt: 100_000 });
  for (let s = 95; s <= 99; s++) close(m.ring[s % m.ring.length], 200);
  close(m.rate(100_000), 100);
});

test('an idle fleet reads zero once its last token leaves the window, and recent() agrees', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 400, 49_000, 50_000);   // second 49
  // The last bucket leaves the window a second after its own end plus the window.
  for (const [at, reading] of [[59_000, true], [59_500, true], [59_999, true], [60_000, false], [61_000, false]]) {
    assert.equal(m.rate(at) > 0, reading, `rate at ${at}`);
    assert.equal(m.recent(at), reading, `recent at ${at}`);
  }
  // A gap longer than the whole ring empties every bucket, not just the window.
  m.rate(500_000);
  assert.equal(ringTotal(m), 0);
});

// ------------------------------------------------------------ in flight

test('a stream in flight is never written to the ring, and counts while it runs', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress('a', 4_000, 95_000);
  m.progress('a', 4_000, 100_000);
  assert.equal(ringTotal(m), 0);
  // 2,000 tokens of text over five seconds of generating, all of it in the window.
  close(m.rate(100_000), 2_000 / WINDOW_SEC);
  assert.equal(m.recent(100_000), true);
});

test('a stream in flight is spread over its generating time, so the window takes its share', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress('a', 0, 80_000, 'm');
  m.progress('a', 8_000, 100_000, 'm');   // 2,000 tokens over twenty seconds
  close(m.rate(100_000), 1_000 / WINDOW_SEC);   // half of it inside the last ten
});

// Hidden thinking sends nothing while it thinks, so the stream's generating
// time runs to now, not to its latest event, and a learnt pace carries it.
test('once its model has a pace, a stream with hidden thinking reads at that pace', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 'earlier', 2_000, 0, 10_000, 'opus');   // 200 tok/s
  close(m.modelRate('opus'), 200);
  m.progress('now', 0, 100_000, 'opus');           // a thinking block starts
  close(m.liveRate('now', 115_000), 200);
  close(m.rate(115_000), 200);
  // Text is the floor: a stream showing more than its pace would make is read by its text.
  m.progress('now', 20_000, 115_000, 'opus');       // 5,000 tokens of text in fifteen seconds
  close(m.liveRate('now', 115_000), 5_000 / 15);
});

// Fable's two scenarios, which the character estimate read about 100× low.
test('a long hidden-reasoning turn reads near its true rate, and settles without a jump', () => {
  let t = 1e12;
  const m = new ThroughputMeter({ now: () => t });
  // One earlier 30 s turn of the same model: 6,000 tokens, 240 characters shown.
  m.progress('one', 0, t, 'gpt-5.6');
  for (let s = 1; s <= 30; s++) m.progress('one', 8, t + s * 1_000, 'gpt-5.6');
  m.finish('one', { outputTokens: 6_000, firstAt: t, lastAt: t + 30_000, endedAt: t + 30_000, model: 'gpt-5.6' });
  // The next, a minute later, with the first long out of the window.
  t += 90_000;
  const first = t;
  m.progress('two', 0, t, 'gpt-5.6');
  const during = [];
  for (let s = 1; s <= 30; s++) {
    t = first + s * 1_000;
    m.progress('two', 8, t, 'gpt-5.6');
    if (s >= 12) during.push(m.sample(t).rate);
  }
  for (const r of during) assert.ok(Math.abs(r - 200) / 200 <= 0.25, `the needle read ${r.toFixed(0)} against a true 200`);
  const before = m.sample(t);
  m.finish('two', { outputTokens: 6_000, firstAt: first, lastAt: t, endedAt: t, model: 'gpt-5.6' });
  const after = m.sample(t);
  assert.ok(Math.abs(after.rate - before.rate) / after.rate <= 0.1, `the needle jumped ${before.rate.toFixed(0)} → ${after.rate.toFixed(0)}`);
  assert.equal(after.scale, before.scale, 'the scale changed at completion');
});

test('an Anthropic thinking turn reads near its pace throughout, not its visible text', () => {
  let t = 1e12;
  const m = new ThroughputMeter({ now: () => t });
  // 3,000 tokens over 10 s, 300 characters shown: a pace of 300.
  const turn = (id) => {
    const first = t;
    m.progress(id, 0, t, 'claude-opus');
    const seen = [];
    for (let s = 1; s <= 10; s++) { t = first + s * 1_000; m.progress(id, 30, t, 'claude-opus'); seen.push(m.sample(t)); }
    m.finish(id, { outputTokens: 3_000, firstAt: first, lastAt: t, endedAt: t, model: 'claude-opus' });
    return { seen, after: m.sample(t) };
  };
  turn('one');
  t += 60_000;
  const { seen, after } = turn('two');
  // Ten seconds in, the whole turn is inside the window.
  assert.ok(Math.abs(seen[9].rate - 300) / 300 <= 0.25, `read ${seen[9].rate.toFixed(0)}`);
  assert.ok(Math.abs(after.rate - seen[9].rate) / after.rate <= 0.1, `jumped ${seen[9].rate.toFixed(0)} → ${after.rate.toFixed(0)}`);
});

test('a model\'s pace follows its finished turns by a weighted average, and only measurable ones', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 1_000, 0, 10_000, 'm');                   // 100
  settle(m, 2, 3_000, 20_000, 30_000, 'm');              // 300
  close(m.modelRate('m'), 100 + MODEL_RATE_WEIGHT * 200);
  settle(m, 3, 50, 40_000, 40_100, 'm');                 // too short to measure
  m.finish(4, { outputTokens: null, firstAt: 50_000, lastAt: 60_000, endedAt: 60_000, model: 'm' });
  m.finish(5, { outputTokens: 9_000, dispatchedAt: 60_000, endedAt: 61_000, model: 'm' });   // buffered: no generation time
  close(m.modelRate('m'), 100 + MODEL_RATE_WEIGHT * 200);
  assert.equal(m.modelRate('other'), null);
  assert.equal(m.modelRate(null), null);
});

test('the model paces kept are bounded, forgetting the one heard from least recently', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  for (let i = 0; i <= MODEL_RATE_KEYS; i++) settle(m, i, 1_000, i * 20_000, i * 20_000 + 10_000, `m${i}`);
  assert.equal(m.paces.size, MODEL_RATE_KEYS);
  assert.equal(m.modelRate('m0'), null);
  assert.ok(m.modelRate(`m${MODEL_RATE_KEYS}`) > 0);
});

// A client that leaves, or a stream that dies, ends with no count. What it
// showed was certainly generated; what its model's pace suggests was a guess.
test('a stream that ends with no count books its visible text, not its guessed pace', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 'teacher', 5_000, 0, 10_000, 'm');   // 500 tok/s, long out of the ring by the end
  m.progress('a', 0, 90_000, 'm');
  m.progress('a', 400, 99_000, 'm');
  close(m.liveRate('a', 99_000), 500, 1e-6);      // read at its pace while it ran
  m.finish('a', { outputTokens: null, endedAt: 100_000 });
  close(ringTotal(m), 100);   // 400 characters, not 500 tok/s × 9 s
  for (let s = 90; s <= 98; s++) close(m.ring[s % m.ring.length], 100 / 9);
  assert.equal(m.streams.size, 0);
});

// ------------------------------------------------------------ bad input

test('a clock that steps back more than a second starts the ring over', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 400, 59_000, 60_000);
  assert.ok(m.rate(60_000) > 0);
  // Back to second 1: the modulo index would read second 61's slot as second 1's.
  assert.equal(m.rate(1_000), 0);
  assert.equal(ringTotal(m), 0);
  assert.equal(m.rate(10_000), 0);
});

test('a clock that steps back by less than a second reads at the head', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  settle(m, 1, 400, 59_000, 60_000);
  const at = m.rate(60_900);
  close(m.rate(60_400), m.rate(60_000));
  assert.ok(at > 0);
  close(ringTotal(m), 400);
});

test('an absurd count or time cannot carry the reading or the scale to Infinity', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.finish('a', { outputTokens: Number.MAX_VALUE, firstAt: 0, lastAt: 1_000, endedAt: 1_000 });
  m.finish('b', { outputTokens: 1e300, dispatchedAt: 0, endedAt: 1_000 });
  m.progress('c', Number.MAX_VALUE, 1_000, 'x');
  m.progress('d', 5, Infinity);
  m.finish('e', { outputTokens: 5, firstAt: NaN, lastAt: Infinity, dispatchedAt: -Infinity, endedAt: NaN });
  const { rate, peak, scale } = m.sample(1_000);
  for (const v of [rate, peak, scale]) assert.ok(Number.isFinite(v), `${v}`);
  assert.ok(rate <= 3 * MAX_REQUEST_TOKENS / WINDOW_SEC);
  assert.ok(Number.isFinite(requestRate({ outputTokens: Number.MAX_VALUE, firstAt: 0, lastAt: 250 })));
});

test('the streams followed at once are bounded', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  for (let i = 0; i < MAX_STREAMS + 10; i++) m.progress(i, 1, 1_000);
  assert.equal(m.streams.size, MAX_STREAMS);
  assert.equal(m.streams.has(0), false, 'the oldest went first');
});

// ------------------------------------------------------------ the scale

test('the scale is a 1-2-5 step, never under MIN_SCALE', () => {
  assert.equal(niceCeil(0), MIN_SCALE);
  assert.equal(niceCeil(-5), MIN_SCALE);
  assert.equal(niceCeil(NaN), MIN_SCALE);
  assert.equal(niceCeil(100), 100);
  assert.equal(niceCeil(101), 200);
  assert.equal(niceCeil(1_000), 1_000);
  assert.equal(niceCeil(1_001), 2_000);
  assert.equal(niceCeil(2_500), 5_000);
  assert.equal(niceCeil(7_000), 10_000);
  assert.equal(niceCeil(1e6), 1e6);
});

/** A meter whose rate is whatever the test last set, sampled once a second. */
function scaleRig() {
  let now = 0;
  let rate = 0;
  const m = new ThroughputMeter({ now: () => now });
  m.rate = () => rate;
  return {
    m,
    at: (/** @type {number} */ r, /** @type {number} */ secs = 1) => {
      const seen = new Set();
      for (let i = 0; i < secs; i++) { now += 1_000; rate = r; seen.add(m.sample(now).scale); }
      return seen;
    },
  };
}

test('the scale grows the moment the rate passes it', () => {
  const { at } = scaleRig();
  assert.deepEqual(at(80), new Set([100]));
  assert.deepEqual(at(150), new Set([200]));
  assert.deepEqual(at(4_100), new Set([5_000]));
});

// A rate hovering on a step boundary is the case that would flap: 1,010 grows
// the scale to 2,000, and it must not fall back to 1,000 the moment the rate
// dips to 990.
test('a rate hovering on a step does not flip the scale back and forth', () => {
  const { at } = scaleRig();
  at(1_010);
  const seen = new Set();
  for (let i = 0; i < 300; i++) for (const s of at(i % 2 ? 990 : 1_010)) seen.add(s);
  assert.deepEqual(seen, new Set([2_000]));
});

test('after a burst the scale comes back down, a step at a time, and settles', () => {
  const { at } = scaleRig();
  at(4_000);
  const seen = [...at(0, 30 * 60)];
  assert.deepEqual(seen, [5_000, 2_000, 1_000, 500, 200, 100], 'the scale steps down through every size in turn');
});

// ------------------------------------------------------------ per request

test('a finished request is timed over its generation, first output event to last', () => {
  close(requestRate({ outputTokens: 840, firstAt: 1_000, lastAt: 11_000, startedAt: 0, endedAt: 11_100 }), 84);
});

test('a buffered request falls back to its whole duration', () => {
  close(requestRate({ outputTokens: 300, firstAt: null, lastAt: null, startedAt: 0, endedAt: 3_000 }), 100);
});

test('no rate for an unknown or zero count, or an interval too short to measure', () => {
  assert.equal(requestRate({ outputTokens: null, firstAt: 0, lastAt: 5_000 }), null);
  assert.equal(requestRate({ outputTokens: undefined, startedAt: 0, endedAt: 5_000 }), null);
  assert.equal(requestRate({ outputTokens: 0, firstAt: 0, lastAt: 5_000 }), null);
  assert.equal(requestRate({ outputTokens: 50, firstAt: 0, lastAt: MIN_INTERVAL_MS - 1 }), null);
  assert.ok(requestRate({ outputTokens: 50, firstAt: 0, lastAt: MIN_INTERVAL_MS }) > 0);
  assert.equal(requestRate({ outputTokens: 50 }), null, 'no interval of any kind');
});

test('a live estimate waits for a second of generating, and something to estimate from', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  assert.equal(m.liveRate('none', 5_000), null);
  m.progress('a', 0, 0);
  assert.equal(m.liveRate('a', 5_000), null, 'no text and no pace yet');
  m.progress('a', 400, 500);
  assert.equal(m.liveRate('a', LIVE_AFTER_MS - 1), null);
  close(m.liveRate('a', 2_000), 400 / CHARS_PER_TOKEN / 2);
});

test('rates print compactly', () => {
  assert.equal(formatRate(0), '0');
  assert.equal(formatRate(-3), '0');
  assert.equal(formatRate(NaN), '0');
  assert.equal(formatRate(84.4), '84');
  assert.equal(formatRate(950), '950');
  assert.equal(formatRate(999.4), '999');
  assert.equal(formatRate(999.6), '1.0k');
  assert.equal(formatRate(1_400), '1.4k');
  assert.equal(formatRate(9_949), '9.9k');
  assert.equal(formatRate(9_950), '10k');
  assert.equal(formatRate(12_345), '12k');
  assert.equal(formatRate(1_234_567), '1.2M');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentChars, OutputTracker, ThroughputMeter, requestRate, liveRate, formatRate, niceCeil,
  CHARS_PER_TOKEN, WINDOW_SEC, MIN_INTERVAL_MS, LIVE_AFTER_MS, MIN_SCALE,
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
  assert.deepEqual(t.summary(), { outputTokens: null, firstTokenAt: 1_200, lastTokenAt: 2_500 });
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

test('the fleet rate is the tokens in the last WINDOW_SEC seconds over WINDOW_SEC', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress(400, 95_500);   // 100 tokens, in second 95
  m.progress(800, 99_900);   // 200 tokens, in second 99
  close(m.rate(100_000), 300 / WINDOW_SEC);
});

// The window slides continuously: at half a second into second 105 it covers
// (95.5 s, 105.5 s], which is the second half of bucket 95.
test('the window takes a fraction of its oldest second, so the rate slides rather than steps', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress(400, 95_200);
  close(m.rate(105_000), 100 / WINDOW_SEC, 1e-9);
  close(m.rate(105_500), 50 / WINDOW_SEC, 1e-9);
  close(m.rate(106_000), 0, 1e-9);
});

test('an idle fleet reads zero once its last token leaves the window', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress(4_000, 50_000);
  assert.ok(m.rate(55_000) > 0);
  assert.equal(m.recent(55_000), true);
  assert.equal(m.rate(61_000), 0);
  assert.equal(m.recent(61_000), false);
  // A gap longer than the whole ring empties every bucket, not just the window.
  m.rate(500_000);
  assert.equal(ringTotal(m), 0);
});

test('a stream adds its estimate live, at chars / CHARS_PER_TOKEN', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress(CHARS_PER_TOKEN * 30, 10_100);
  close(ringTotal(m), 30);
});

// ------------------------------------------------------------ corrections

test('the exact count corrects the estimate across the seconds it was generated in', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  // 400 chars streamed at the end (a 100-token estimate), 1,100 tokens really
  // generated over ten seconds: the 1,000 the estimate missed go back over
  // those ten seconds, 100 each, not into the last one.
  m.progress(400, 99_500);
  m.complete({ outputTokens: 1_100, chars: 400, firstAt: 90_000, lastAt: 100_000 });
  close(ringTotal(m), 1_100);
  for (let s = 90; s <= 98; s++) close(m.ring[s % m.ring.length], 100);
  close(m.ring[99 % m.ring.length], 200);
  close(m.rate(100_000), 110);
});

test('a correction older than the ring lands only in the part the ring still holds', () => {
  const m = new ThroughputMeter({ now: () => 0, ringSec: 60 });
  // Two minutes of generation, all of it hidden: nothing streamed, and the
  // whole count arrives at the end. Only the last sixty seconds are kept.
  m.complete({ outputTokens: 12_000, chars: 0, firstAt: 0, lastAt: 120_000 });
  // The ring holds seconds 61..120, and second 120 starts where the stream
  // ended, so 59 of those seconds took 100 tokens each.
  close(ringTotal(m), 5_900, 1e-6);
  close(m.rate(120_000), 100, 1e-6);          // spread evenly, so the rate is the stream's own pace
});

test('an overestimate is taken back without driving any bucket below zero', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress(4_000, 99_900);                  // a 1,000-token estimate in one second
  m.complete({ outputTokens: 10, chars: 4_000, firstAt: 90_000, lastAt: 100_000 });
  assert.ok([...m.ring].every(v => v >= 0), 'a bucket went negative');
});

test('a buffered response spreads its count over the request, since it streamed nothing', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.complete({ outputTokens: 500, startedAt: 95_000, endedAt: 100_000 });
  for (let s = 95; s <= 99; s++) close(m.ring[s % m.ring.length], 100);
});

test('without an exact count the estimate stands', () => {
  const m = new ThroughputMeter({ now: () => 0 });
  m.progress(400, 99_000);
  m.complete({ outputTokens: null, chars: 400, firstAt: 98_000, lastAt: 99_000 });
  close(ringTotal(m), 100);
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

test('a live estimate waits for a second of streamed text', () => {
  assert.equal(liveRate({ chars: 400, firstAt: null, now: 5_000 }), null);
  assert.equal(liveRate({ chars: 0, firstAt: 0, now: 5_000 }), null, 'nothing visible yet to estimate from');
  assert.equal(liveRate({ chars: 400, firstAt: 0, now: LIVE_AFTER_MS - 1 }), null);
  close(liveRate({ chars: 400, firstAt: 0, now: 2_000 }), 400 / CHARS_PER_TOKEN / 2);
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

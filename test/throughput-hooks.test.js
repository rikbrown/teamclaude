import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The throughput meter's half in the proxy: with `throughputMeter` on, each
// output event of the response the client reads is reported to the progress
// hook as it streams, and so is the response's input side, once, for the spend
// reading, and the end hook carries the settled output count and
// when the output started and stopped. With it off, neither happens.
//
// Driven through real HTTP, because what these pin lives at the call sites:
// which responses reach the parser, how many times, and on which attempt.

// The Codex peek holds a stream's head while it decides; keep that short.
process.env.TEAMCLAUDE_STREAM_PEEK_HOLD_MS = '200';

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const frame = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

const claude = (name, port) => ({
  name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
  upstream: `http://127.0.0.1:${port}`,
});
const codex = (name, port) => ({
  name: `codex:${name}`, type: 'oauth', provider: 'codex', accountId: `acct-${name}`,
  accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
  upstream: `http://127.0.0.1:${port}`,
});

// One Anthropic turn with every kind of output: thinking, text and a tool
// call's arguments, then the cumulative count in message_delta.
const ANTHROPIC = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 12, cache_read_input_tokens: 3_000, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me see.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ', world' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu', name: 'x', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'ping' },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } },
  { type: 'message_stop' },
];
// 'Let me see.' + 'Hello' + ', world' + '{"a":1}'
const ANTHROPIC_CHARS = 11 + 5 + 7 + 7;

const RESPONSES = [
  { type: 'response.created', response: { object: 'response', status: 'in_progress', usage: null } },
  { type: 'response.output_item.added', item: { type: 'reasoning' } },
  { type: 'response.reasoning_summary_text.delta', delta: 'Thinking.' },
  { type: 'response.output_item.done', item: { type: 'reasoning' } },
  { type: 'response.output_item.added', item: { type: 'message' } },
  { type: 'response.output_text.delta', delta: 'hi' },
  { type: 'response.output_text.delta', delta: ' there' },
  { type: 'response.output_item.done', item: { type: 'message' } },
  { type: 'response.function_call_arguments.delta', delta: '{"q":2}' },
  { type: 'response.completed', response: { object: 'response', status: 'completed', usage: { input_tokens: 100, output_tokens: 132 } } },
];
const RESPONSES_CHARS = 9 + 2 + 6 + 7;

function sseUpstream(events, { gapMs = 2 } = {}) {
  return async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const e of events) {
      res.write(frame(e));
      await sleep(gapMs);
    }
    res.end();
  };
}

/** A proxy in front of one upstream, with every activity hook recorded. */
async function withProxy({ accounts, handler, config = {}, noProgressHook = false }, fn) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(String(req.headers['chatgpt-account-id'] || req.headers.authorization || ''));
    handler(req, res, seen);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(upstreamPort), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  // Usage reports are kept apart from output events: they carry no output.
  const calls = { progress: [], usage: [], end: [] };
  const hooks = {
    onRequestStart: () => {},
    onRequestEnd: (id, info) => calls.end.push({ id, info }),
  };
  if (!noProgressHook) hooks.onRequestProgress = (id, p) => (p.usage ? calls.usage : calls.progress).push({ id, ...p });
  const cfg = { proxy: {}, ...config };
  const proxy = createProxyServer(am, cfg, hooks);
  const port = await listen(proxy);
  try { await fn({ port, calls, cfg, seen }); } finally { proxy.close(); upstream.close(); }
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'session-id': 'sess-tps' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  // The end hook runs in the listener's finally, a tick after the last byte.
  await sleep(40);
  return { status: res.status, text };
}
const anthropicPost = (port) => post(port, '/v1/messages', { model: 'claude-opus-5', stream: true, messages: [] });
const codexPost = (port) => post(port, '/backend-api/codex/responses', { model: 'gpt-5.6', input: [], stream: true });
const sum = (progress) => progress.reduce((s, p) => s + p.chars, 0);

test('an Anthropic stream reports each output event with its characters, and the end carries the count', async () => {
  await withProxy({
    accounts: (p) => [claude('a', p)],
    handler: sseUpstream(ANTHROPIC),
    config: { throughputMeter: true },
  }, async ({ port, calls }) => {
    await anthropicPost(port);
    // Every block start, delta and stop is an output event; message_start,
    // ping, message_delta and message_stop are not.
    assert.deepEqual(calls.progress.map(p => p.chars), [0, 11, 0, 0, 0, 5, 7, 0, 0, 7, 0]);
    assert.equal(sum(calls.progress), ANTHROPIC_CHARS);
    assert.equal(new Set(calls.progress.map(p => p.id)).size, 1);
    assert.equal(calls.end.length, 1);
    const { id, info } = calls.end[0];
    assert.equal(id, calls.progress[0].id, 'progress and end name the same request');
    assert.equal(info.outputTokens, 500, 'the settled count, not message_start\'s placeholder');
    assert.equal(info.firstTokenAt, calls.progress[0].at);
    assert.equal(info.lastTokenAt, calls.progress[calls.progress.length - 1].at);
    assert.ok(info.lastTokenAt > info.firstTokenAt);
    assert.ok(info.dispatchedAt <= info.firstTokenAt, 'the attempt was sent before it answered');
    // message_start's input side, once, before any output, with the model
    // upstream says served it rather than the one the client asked for.
    assert.equal(calls.usage.length, 1);
    assert.equal(calls.usage[0].id, id);
    assert.equal(calls.usage[0].model, 'claude-opus-5-5');
    assert.equal(calls.usage[0].usage.cache_read_input_tokens, 3_000);
    assert.ok(calls.usage[0].at <= info.firstTokenAt);
  });
});

test('a Responses stream reports its text, reasoning and tool deltas, and the settled count', async () => {
  await withProxy({
    accounts: (p) => [codex('one', p)],
    handler: sseUpstream(RESPONSES),
    config: { throughputMeter: true },
  }, async ({ port, calls }) => {
    await codexPost(port);
    assert.deepEqual(calls.progress.map(p => p.chars), [0, 9, 0, 0, 2, 6, 0, 7]);
    assert.equal(sum(calls.progress), RESPONSES_CHARS);
    assert.equal(calls.end[0].info.outputTokens, 132);
    assert.equal(calls.end[0].info.firstTokenAt, calls.progress[0].at);
    assert.equal(calls.usage.length, 1, 'the terminal event\'s usage, once');
  });
});

test('a buffered response carries its count and no generation interval', async () => {
  await withProxy({
    accounts: (p) => [claude('a', p)],
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 42 } }));
    },
    config: { throughputMeter: true },
  }, async ({ port, calls }) => {
    await post(port, '/v1/messages', { model: 'claude-opus-5', messages: [] });
    assert.equal(calls.progress.length, 0);
    assert.deepEqual(calls.usage.map(u => u.usage.input_tokens), [5], 'the body\'s usage, once');
    const { info } = calls.end[0];
    assert.equal(info.outputTokens, 42);
    assert.equal(info.firstTokenAt, null);
    assert.equal(info.lastTokenAt, null);
  });
});

// Off is the default, and off must cost the proxy nothing it did not already
// do: no progress, and an end entry with exactly the fields it always had.
test('with the meter off nothing fires, and the end entry is what it always was', async () => {
  for (const config of [{}, { throughputMeter: false }, { throughputMeter: 'yes' }]) {
    await withProxy({
      accounts: (p) => [claude('a', p)],
      handler: sseUpstream(ANTHROPIC),
      config,
    }, async ({ port, calls }) => {
      await anthropicPost(port);
      assert.equal(calls.progress.length + calls.usage.length, 0, JSON.stringify(config));
      assert.deepEqual(Object.keys(calls.end[0].info).sort(),
        ['account', 'client', 'effort', 'method', 'model', 'path', 'pinned', 'sessionId', 'status']);
    });
  }
});

test('a consumer with no progress hook gets no tracking, even with the meter on', async () => {
  await withProxy({
    accounts: (p) => [claude('a', p)],
    handler: sseUpstream(ANTHROPIC),
    config: { throughputMeter: true },
    noProgressHook: true,
  }, async ({ port, calls }) => {
    await anthropicPost(port);
    assert.equal(calls.end[0].info.outputTokens, undefined);
  });
});

test('the setting is read per request, so a toggle lands on the next one', async () => {
  await withProxy({
    accounts: (p) => [claude('a', p)],
    handler: sseUpstream(ANTHROPIC),
  }, async ({ port, calls, cfg }) => {
    await anthropicPost(port);
    assert.equal(calls.progress.length, 0);
    cfg.throughputMeter = true;
    await anthropicPost(port);
    assert.equal(sum(calls.progress), ANTHROPIC_CHARS);
    assert.equal(calls.end[1].info.outputTokens, 500);
    cfg.throughputMeter = false;
    calls.progress.length = 0;
    await anthropicPost(port);
    assert.equal(calls.progress.length, 0);
  });
});

// ------------------------------------------------------------ failover

// Only the attempt whose body reaches the client may count. A refused attempt's
// body is cancelled unread; this one even carries output, to prove it.
test('a failed-over attempt counts nothing, and the attempt that served counts once', async () => {
  await withProxy({
    accounts: (p) => [claude('a', p), claude('b', p)],
    handler: (req, res, seen) => {
      if (seen.length === 1) {
        res.writeHead(429, { 'retry-after': '60', 'content-type': 'text/event-stream' });
        res.end(frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'NOT-THIS-ONE' } }));
        return;
      }
      sseUpstream(ANTHROPIC)(req, res);
    },
    config: { throughputMeter: true },
  }, async ({ port, calls, seen }) => {
    const { status } = await anthropicPost(port);
    assert.equal(status, 200);
    assert.equal(seen.length, 2, 'the request failed over');
    assert.equal(sum(calls.progress), ANTHROPIC_CHARS);
    assert.equal(calls.end[0].info.outputTokens, 500);
  });
});

// A buffered answer is timed from the attempt that answered, so the time spent
// on an attempt that was refused is not counted as generating it.
test('a buffered answer after a failover carries the dispatch of the attempt that answered', async () => {
  const t0 = Date.now();
  await withProxy({
    accounts: (p) => [claude('a', p), claude('b', p)],
    handler: async (req, res, seen) => {
      if (seen.length === 1) {
        await sleep(150);
        res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 5, output_tokens: 42 } }));
    },
    config: { throughputMeter: true },
  }, async ({ port, calls, seen }) => {
    await post(port, '/v1/messages', { model: 'claude-opus-5', messages: [] });
    assert.equal(seen.length, 2, 'the request failed over');
    const { info } = calls.end[0];
    assert.equal(info.outputTokens, 42);
    assert.ok(info.dispatchedAt >= t0 + 150, `dispatched ${info.dispatchedAt - t0} ms in, before the refusal came back`);
  });
});

// The Codex peek reads the head of a stream before committing to it. A peek
// that releases replays those bytes into the relay: they must be parsed once,
// by the relay, and not also by the peek.
test('a peeked stream that is released is counted once', async () => {
  await withProxy({
    accounts: (p) => [codex('one', p), codex('two', p)],
    handler: sseUpstream(RESPONSES),
    config: { throughputMeter: true },
  }, async ({ port, calls, seen }) => {
    await codexPost(port);
    assert.equal(seen.length, 1, 'no hop: the stream was good');
    assert.equal(sum(calls.progress), RESPONSES_CHARS);
    assert.equal(calls.progress.length, 8);
    assert.equal(calls.usage.length, 1);
  });
});

test('a stream refused in-band hops, and only the sibling\'s output counts', async () => {
  const OVERLOADED = { type: 'error', error: { code: 'server_is_overloaded', message: 'Selected model is at capacity.' } };
  await withProxy({
    accounts: (p) => [codex('one', p), codex('two', p)],
    handler: (req, res, seen) => {
      if (seen.length === 1) return sseUpstream([RESPONSES[0], OVERLOADED])(req, res);
      return sseUpstream(RESPONSES)(req, res);
    },
    config: { throughputMeter: true },
  }, async ({ port, calls, seen }) => {
    await codexPost(port);
    assert.equal(seen.length, 2, 'the refusal hopped');
    assert.equal(sum(calls.progress), RESPONSES_CHARS);
    assert.equal(calls.usage.length, 1, 'only the sibling\'s usage');
    assert.equal(calls.end[0].info.outputTokens, 132);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { normalizeResponsesUsage, responsesEventUsage, isResponsesBody } from '../src/responses-usage.js';
import { ClientUsageTracker } from '../src/client-usage.js';

// Codex traffic is a passthrough, so its usage arrives in OpenAI's vocabulary
// while every counter in this proxy speaks Anthropic's. Nothing read the
// Responses shape at all, so a pooled ChatGPT account served hundreds of
// requests and reported `N req · 0 tok` for its whole life: the stream's usage
// rides a terminal event none of the Anthropic branches matched.
//
// The trap is that the two vocabularies share field NAMES and disagree about
// what they mean. Responses `input_tokens` is the WHOLE prompt with the cached
// part named again underneath it; Anthropic's is the UNCACHED input with the
// cached part reported beside it. Readers here add the three Anthropic figures
// up, so a Responses object booked verbatim counts its cached prefix twice —
// and on Codex traffic that prefix is nearly the whole prompt.
//
// Magnitudes below are one real Codex turn, from the CLI's own per-turn record:
// input 54904 of which 46592 cached, output 132 of which 18 reasoning, and
// total_tokens 55036 = 54904 + 132. That arithmetic is the proof that cached is
// a SUBSET of the input side and reasoning a subset of the output side, which
// is why one is subtracted here and the other is not added.
const WIRE = {
  input_tokens: 54904,
  input_tokens_details: { cached_tokens: 46592 },
  output_tokens: 132,
  output_tokens_details: { reasoning_tokens: 18 },
  total_tokens: 55036,
};
const FRESH = WIRE.input_tokens - WIRE.input_tokens_details.cached_tokens;
const CACHED = WIRE.input_tokens_details.cached_tokens;
const MODEL = 'gpt-5.6-sol';
const BUCKET = 'unified7d';
const SID = 'sess-responses';

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// ---------------------------------------------------------------- normalising

test('the cached prefix moves out of the input side rather than being counted twice', () => {
  assert.deepEqual(normalizeResponsesUsage(WIRE), {
    input_tokens: FRESH,
    output_tokens: WIRE.output_tokens,
    cache_read_input_tokens: CACHED,
  });
  // The whole prompt has to survive the move, or a context reading shrinks.
  const u = normalizeResponsesUsage(WIRE);
  assert.equal(u.input_tokens + u.cache_read_input_tokens, WIRE.input_tokens);
});

// Reasoning tokens are a breakdown of the output side, not a second quantity
// beside it. Adding them would inflate every reasoning-heavy turn, which on
// this backend is all of them.
test('reasoning tokens are not added to the output side', () => {
  assert.equal(normalizeResponsesUsage(WIRE).output_tokens, WIRE.output_tokens);
});

// A backend that reports no cache breakdown is already reporting uncached
// input, so the numbers must pass through untouched rather than being guessed at.
test('a usage object with no cache breakdown passes its figures through', () => {
  assert.deepEqual(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 3 }), {
    input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0,
  });
});

// These are all the shapes a proxy sees when upstream changes, truncates, or
// simply answers something else. None may throw, and none may invent a figure:
// the counters they feed are cumulative and are never recomputed, so a single
// NaN or negative is permanent.
test('a malformed usage object records nothing instead of throwing', () => {
  for (const bad of [null, undefined, 0, '', 'usage', [], {}, { input_tokens: null }, { input_tokens: 'many' },
    { input_tokens: NaN }, { input_tokens: Infinity }, { input_tokens: -5, output_tokens: -5 }]) {
    assert.equal(normalizeResponsesUsage(bad), null, `${JSON.stringify(bad)} produced a record`);
  }
});

// Upstream cannot report more cached tokens than it read, but the uncached
// figure is a SUBTRACTION, so an unclamped one would go negative and quietly
// shrink a lifetime total that nothing ever recomputes.
test('a cached count larger than the input side cannot make the remainder negative', () => {
  assert.deepEqual(normalizeResponsesUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 900 }, output_tokens: 1 }), {
    input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 100,
  });
});

// A fractional count would reach a counter that is only ever added to, so the
// error would compound rather than round.
test('a fractional count is truncated to a whole one', () => {
  assert.equal(normalizeResponsesUsage({ input_tokens: 10.7, output_tokens: 0 }).input_tokens, 10);
});

// ---------------------------------------------------------------- stream events

test('a terminal stream event yields the turn\'s usage', () => {
  for (const type of ['response.completed', 'response.incomplete']) {
    const u = responsesEventUsage({ type, response: { usage: WIRE } });
    assert.ok(u, `${type} reported nothing`);
    assert.equal(u.cache_read_input_tokens, CACHED);
  }
});

// EVERY `response.*` event carries the whole response envelope, so the in-flight
// ones have a `usage` key too — null today. Matching on the key rather than on
// the terminal event name would make this accounting depend on that staying
// null for ever, and an upstream that began reporting progress figures would be
// counted once per event.
test('an in-flight event reports nothing even though it carries a usage key', () => {
  for (const type of ['response.created', 'response.in_progress', 'response.queued']) {
    assert.equal(responsesEventUsage({ type, response: { id: 'resp_1', usage: null } }), null, type);
  }
});

test('the events a stream is mostly made of report nothing', () => {
  for (const e of [
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
    { type: 'response.output_item.done' },
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    null, undefined, 'response.completed', {},
  ]) {
    assert.equal(responsesEventUsage(e), null, JSON.stringify(e));
  }
});

// A failure that got far enough to state figures spent them, so the event is in
// the terminal set — but it usually carries none, and then nothing is recorded
// rather than a report of zero.
test('a failed response records its figures when it has them and nothing when it does not', () => {
  assert.equal(responsesEventUsage({ type: 'response.failed', response: { usage: null } }), null);
  assert.equal(responsesEventUsage({ type: 'response.failed', response: { usage: WIRE } })?.output_tokens, WIRE.output_tokens);
});

// ---------------------------------------------------------------- buffered bodies

test('a buffered Responses body is recognised', () => {
  assert.equal(isResponsesBody({ object: 'response', status: 'completed', usage: WIRE }), true);
  // The cache breakdown alone is enough, for a backend that omits `object`.
  assert.equal(isResponsesBody({ usage: WIRE }), true);
  // Recognition is about the body, not about its figures: a Responses body that
  // reports nothing usable is still a Responses body, and the caller has to be
  // able to tell that apart from a body that is not one at all.
  assert.equal(isResponsesBody({ object: 'response' }), true);
});

// The discriminator has to be one an Anthropic body cannot produce: rewriting
// one would move its `input_tokens` into a cache field it already reports
// separately, which is the same double count in the other direction.
test('an Anthropic body is not mistaken for a Responses one', () => {
  const anthropic = { type: 'message', content: [], usage: { input_tokens: 2, cache_read_input_tokens: 377127, output_tokens: 714 } };
  assert.equal(isResponsesBody(anthropic), false);
  for (const bad of [null, undefined, 'response', 42, [], {}, { usage: 'many' }]) {
    assert.equal(isResponsesBody(bad), false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- end to end

const codexAccount = (upstreamPort, extra = {}) => ({
  name: 'codex:one', type: 'oauth', provider: 'codex', accountId: 'acct-one',
  accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  upstream: `http://127.0.0.1:${upstreamPort}`, ...extra,
});

// A Responses stream, in the order the ChatGPT backend sends it: a created
// event carrying a null usage, a run of deltas, then the settled figures on the
// terminal event. `event:` lines are written as well as `data:` ones because the
// wire has both and the scanner must keep ignoring the former.
function streamingUpstream(events) {
  return http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const e of events) {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      await new Promise(r => setTimeout(r, 2));
    }
    res.end();
  });
}

const CREATED = { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', usage: null } };
const DELTA = { type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' };
const COMPLETED = { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', status: 'completed', usage: WIRE } };

// Drives one request down the Codex path and hands back the account manager.
async function codexTurn(upstream, { accounts = null, stream = true } = {}) {
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts ? accounts(upstreamPort) : [codexAccount(upstreamPort)], 0.98);
  const proxy = createProxyServer(am, { proxy: {} });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
      method: 'POST',
      // `session_id` is the spelling a translating sidecar re-emits on our
      // behalf, and it is what makes the second hop attributable at all.
      headers: { 'content-type': 'application/json', 'session_id': SID },
      body: JSON.stringify({ model: MODEL, input: [], stream }),
    });
    await res.text();
    // The streaming record is written in streamResponse's finally, which can
    // land a tick after the client's last byte.
    await new Promise(r => setTimeout(r, 60));
    return am;
  } finally {
    proxy.close();
    upstream.close();
  }
}

const tokensOf = (am) => am.sessionTracker.sessions.get(SID)?.tokens?.get(BUCKET) ?? null;

test('a streaming Codex turn books its tokens against the account that served it', async () => {
  const am = await codexTurn(streamingUpstream([CREATED, DELTA, DELTA, COMPLETED]));
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, FRESH, 'the uncached input side was not booked');
  assert.equal(u.totalOutputTokens, WIRE.output_tokens);
  assert.equal(u.totalCacheReadTokens, CACHED, 'the cached prefix was not booked as a cache read');
  assert.equal(u.totalCacheCreationTokens, 0, 'a figure upstream never reported was invented');
});

test('a streaming Codex turn is attributed to the session that asked', async () => {
  const am = await codexTurn(streamingUpstream([CREATED, DELTA, COMPLETED]));
  const t = tokensOf(am);
  assert.ok(t, 'nothing was recorded for the session, so this proves nothing');
  assert.equal(t.input, FRESH);
  assert.equal(t.output, WIRE.output_tokens);
  assert.equal(t.cacheRead, CACHED);
  assert.equal(t.context, WIRE.input_tokens, 'the context must be the whole prompt, cached part included');
  assert.equal(t.reports, 1, 'one turn is one observation');
});

// The terminal event is the only one that settles, and a stream that never
// reaches it spent tokens nobody can count. Recording the in-flight envelope
// instead would report a turn of zero — indistinguishable, afterwards, from a
// turn that really cost nothing.
test('a stream that ends before its terminal event records nothing', async () => {
  const am = await codexTurn(streamingUpstream([CREATED, DELTA, DELTA]));
  assert.equal(am.accounts[0].usage.totalInputTokens, 0);
  assert.equal(tokensOf(am), null, 'an unfinished stream was recorded as a report of zero tokens');
});

// A `data:` line that is not JSON at all — a keep-alive comment, a truncated
// frame, a backend speaking something else entirely — must leave the relay
// alone rather than throw into it.
test('a stream carrying junk still delivers and records what it can', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': keep-alive\n\n');
    res.write('data: {"type":"response.completed","response":{"usage":\n\n');  // truncated JSON
    res.write('data: not json at all\n\n');
    res.write(`data: ${JSON.stringify(COMPLETED)}\n\n`);
    res.end();
  });
  const am = await codexTurn(upstream);
  assert.equal(am.accounts[0].usage.totalInputTokens, FRESH, 'the good event was lost with the bad ones');
  assert.equal(tokensOf(am).reports, 1);
});

// The terminal event names bound WHAT may report, not how often it may. Both
// counters the branch feeds are incremental, so a backend that re-sent
// `response.completed` — or a relay that replayed the tail of a stream — would
// add the whole turn a second time. The first terminal event settles the turn
// and the rest are ignored.
test('a repeated terminal event books the turn once', async () => {
  const am = await codexTurn(streamingUpstream([CREATED, DELTA, COMPLETED, COMPLETED]));
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, FRESH, 'the turn was booked more than once');
  assert.equal(u.totalOutputTokens, WIRE.output_tokens);
  assert.equal(u.totalCacheReadTokens, CACHED);
  assert.equal(tokensOf(am).reports, 1, 'one turn is one observation');
});

test('a buffered Codex response books its tokens too', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', output: [], usage: WIRE }));
  });
  const am = await codexTurn(upstream, { stream: false });
  assert.equal(am.accounts[0].usage.totalInputTokens, FRESH);
  assert.equal(am.accounts[0].usage.totalOutputTokens, WIRE.output_tokens);
  assert.equal(am.accounts[0].usage.totalCacheReadTokens, CACHED);
  assert.equal(tokensOf(am)?.context, WIRE.input_tokens);
});

// The discriminator decides WHICH reading applies, so a body it recognises must
// not fall back to the other one when its figures turn out to be unusable:
// falling back would book the whole prompt as fresh input, which is the thing
// this change exists to stop, and on the counters that are never recomputed a
// negative or an infinity is permanent. Written as raw JSON because
// `JSON.stringify` cannot express `Infinity`, and the wire can.
test('a Responses body with unusable figures books nothing at all', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":-5,"output_tokens":1e999}}');
  });
  const am = await codexTurn(upstream, { stream: false });
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, 0, 'a negative input count reached a cumulative total');
  assert.equal(u.totalOutputTokens, 0, 'a non-finite output count reached a cumulative total');
  assert.equal(u.totalCacheReadTokens, 0);
  assert.equal(tokensOf(am), null, 'a body that reported nothing usable was recorded as an observation');
});

// ---------------------------------------------------------------- the conduit

// A conduit hop is the SAME tokens twice. The sidecar rebuilds an Anthropic
// usage report out of the Responses figures the pool sent it, so booking both
// hops would double every number — and while the two ACCOUNT rows are distinct,
// a session is one row carrying the same id on both hops, so its context and
// spend would read twice the truth.
//
// So the accounting MOVES to the hop that really spent rather than being added
// to it. Same predicate as the quota guard in codex-conduit-quota.test.js, for
// the same reason: what a conduit reports belongs to whoever served.
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
const conduit = () => oauth('codex', { upstream: 'http://127.0.0.1:18765', priority: 100 });
const pooled = (name, extra = {}) => oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
const ANTHROPIC_USAGE = { input_tokens: 2, cache_read_input_tokens: 377127, cache_creation_input_tokens: 1092, output_tokens: 714 };

test('a conduit books no tokens, in either scope', () => {
  const am = new AccountManager([conduit(), pooled('one')], 0.98);
  am.updateUsage(0, ANTHROPIC_USAGE.input_tokens, ANTHROPIC_USAGE.output_tokens);
  am.beginSession(SID, {});
  am.recordTokenUsage(0, SID, MODEL, ANTHROPIC_USAGE);
  assert.equal(am.accounts[0].usage.totalInputTokens, 0);
  assert.equal(am.accounts[0].usage.totalOutputTokens, 0);
  assert.equal(am.accounts[0].usage.totalCacheReadTokens, 0);
  assert.equal(am.sessionTracker.sessions.get(SID)?.tokens?.get(BUCKET), undefined,
    'the inbound hop doubled the session, which is the one row both hops share');
});

test('the pooled account the conduit relays to books normally', () => {
  const am = new AccountManager([conduit(), pooled('one')], 0.98);
  am.updateUsage(1, 10, 3);
  am.beginSession(SID, {});
  am.recordTokenUsage(1, SID, MODEL, ANTHROPIC_USAGE);
  assert.equal(am.accounts[1].usage.totalInputTokens, 10);
  assert.equal(am.accounts[1].usage.totalCacheReadTokens, ANTHROPIC_USAGE.cache_read_input_tokens);
  assert.equal(am.sessionTracker.sessions.get(SID)?.tokens?.get(BUCKET)?.reports, 1);
});

// A STANDALONE sidecar holds its own ChatGPT login: there is no second hop
// through this proxy, so what it reports is the only report there will ever be.
// Dropping it would trade a doubled figure for a missing one.
test('a standalone sidecar keeps booking its own tokens', () => {
  const am = new AccountManager([oauth('claude-1'), conduit()], 0.98);
  am.updateUsage(1, 10, 3);
  am.beginSession(SID, {});
  am.recordTokenUsage(1, SID, 'claude-opus-5', ANTHROPIC_USAGE);
  assert.equal(am.accounts[1].usage.totalInputTokens, 10);
  assert.equal(am.accounts[1].usage.totalCacheReadTokens, ANTHROPIC_USAGE.cache_read_input_tokens);
});

// A pooled ChatGPT account reached through a local relay is loopback-addressed
// and sits beside other Codex accounts, so a conduit test made of those two
// facts alone swallows it — and then the account that really served books
// nothing, which is the bug this whole file exists to fix, reintroduced from
// the other end. What separates them is the wire: a conduit is reached on
// `/v1/messages` and carries no `provider`, because docs/openai.md says giving
// one breaks the setup outright.
test('a pooled ChatGPT account behind a local relay is not mistaken for a conduit', () => {
  const am = new AccountManager([conduit(), pooled('one', { upstream: 'http://127.0.0.1:9911' }), pooled('two')], 0.98);
  am.updateUsage(1, 10, 3);
  assert.equal(am.accounts[1].usage.totalInputTokens, 10);
});

// WHY THE GUARD LIVES IN THE ACCOUNT MANAGER AND NOT AT THE CALL SITE.
//
// The inbound hop is the ONLY one that can see who asked: the outbound one
// arrives from the sidecar on loopback with no key and no client identity, so
// per-client accounting has nowhere else to come from. Suppressing the conduit
// one layer higher — in the SSE parser, say — would look equivalent and would
// silently end `proxy.clientKeys` reporting for every gpt-* turn.
test('a conduit hop still attributes its tokens to the client that asked', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [], usage: ANTHROPIC_USAGE }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    oauth('codex', { upstream: `http://127.0.0.1:${upstreamPort}`, priority: 100 }),
    pooled('one'),
  ], 0.98);
  const tracker = new ClientUsageTracker();
  const proxy = createProxyServer(am, { proxy: { clientKeys: [{ name: 'claude-code', key: 'cc-key' }] } }, {}, null, tracker);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'cc-key' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200);
    const out = tracker.export();
    assert.equal(out['claude-code']?.inputTokens, ANTHROPIC_USAGE.input_tokens,
      'the only hop that knows the client stopped reporting its tokens');
    assert.equal(out['claude-code'].outputTokens, ANTHROPIC_USAGE.output_tokens);
    assert.equal(am.accounts[0].usage.totalInputTokens, 0,
      'the conduit booked the tokens as well, which is the double count');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A session with no live account behind it is still a real spend, so the
// session scope survives an index nothing matches. Pinned because the conduit
// guard reads the account by index and an over-eager one would swallow this.
test('a report against an unknown account still reaches the session', () => {
  const am = new AccountManager([conduit(), pooled('one')], 0.98);
  am.beginSession(SID, {});
  am.recordTokenUsage(99, SID, MODEL, ANTHROPIC_USAGE);
  assert.equal(am.sessionTracker.sessions.get(SID)?.tokens?.get(BUCKET)?.input, ANTHROPIC_USAGE.input_tokens);
});

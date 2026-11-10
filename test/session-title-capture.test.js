import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionTitles, isTitleRequest, TitleCapture } from '../src/session-titles.js';

// A session's title reaches a proxy on another machine two ways: Claude Code's
// own title request passes through the proxy, which reads the title out of the
// response, and an http hook pushes the session's /rename name to
// POST /teamclaude/session-title. Both are kept in a small file beside the state
// file, because the title request runs once per session.

const SESSION = '3f2a1b9c-0000-4000-8000-000000000001';
const OTHER = '9d0e4c11-0000-4000-8000-000000000002';
const DAY = 24 * 60 * 60 * 1000;
const PROMPT = 'You are naming a coding session so the user can pick it out of a long list of sessions. The title is a name for what the session is about.';
const SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };

/** The request Claude Code 2.1.322 sends, as captured from the wire (trimmed).
 * @param {Record<string, any>} [over] */
const titleRequest = (over = {}) => ({
  model: 'claude-haiku-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: '<session>\nRefactor the payment retry queue\n</session>' }] }],
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.322; cc_entrypoint=cli;' },
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: 'text', text: PROMPT },
  ],
  tools: [],
  max_tokens: 1024,
  output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
  stream: true,
  ...over,
});

/** @param {unknown} value */
const bytes = (value) => Buffer.from(JSON.stringify(value));

/** SSE for a streamed answer whose text arrives in `parts`.
 * @param {string[]} parts */
const sse = (parts) => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...parts.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

/** A buffered answer.
 * @param {string} text */
const message = (text) => ({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 8 } });

const emptyProjects = () => mkdtemp(join(tmpdir(), 'tc-title-projects-'));

/** Run `fn` with console output captured, so the server's lines stay out of the test output.
 * @param {() => Promise<void>} fn */
async function quietly(fn) {
  const original = { log: console.log, error: console.error };
  /** @type {string[]} */
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return lines;
}

// ── detection ──────────────────────────────────────────────────────────────

test('the title request is recognised from its system prompt and output schema', () => {
  assert.equal(isTitleRequest(bytes(titleRequest())), true);
});

test('a string system prompt is recognised as well as a block array', () => {
  assert.equal(isTitleRequest(bytes(titleRequest({ system: PROMPT }))), true);
  assert.equal(isTitleRequest(bytes(titleRequest({ system: `You are Claude Code.\n${PROMPT}` }))), true);
});

test('the older output_format field is recognised too', () => {
  const legacy = titleRequest({ output_format: { type: 'json_schema', schema: SCHEMA } });
  delete legacy.output_config;
  assert.equal(isTitleRequest(bytes(legacy)), true);
});

test('a conversation that quotes the prompt is not the title request', () => {
  const quoted = titleRequest({
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: 'user', content: PROMPT }],
  });
  assert.equal(isTitleRequest(bytes(quoted)), false);
  const inline = titleRequest({ system: [{ type: 'text', text: `Review this prompt: ${PROMPT}` }] });
  assert.equal(isTitleRequest(bytes(inline)), false);
});

test('the prompt without a title schema is not the title request', () => {
  assert.equal(isTitleRequest(bytes(titleRequest({ output_config: undefined }))), false);
  const other = { type: 'json_schema', schema: { type: 'object', properties: { name: { type: 'string' } } } };
  assert.equal(isTitleRequest(bytes(titleRequest({ output_config: { format: other } }))), false);
});

test('a body that is not JSON is not the title request', () => {
  assert.equal(isTitleRequest(Buffer.from(`{"system": "${PROMPT}`)), false);
});

// ── reading the answer ─────────────────────────────────────────────────────

test('a streamed answer is read from its text deltas', () => {
  const capture = new TitleCapture();
  for (const line of sse(['{"ti', 'tle":"Payment retry ', 'backoff"}']).split('\n')) capture.line(line);
  assert.equal(capture.title(), 'Payment retry backoff');
});

test('a buffered answer is read from its text block', () => {
  assert.equal(TitleCapture.fromBody(bytes(message('{"title":"Payment retry backoff"}'))), 'Payment retry backoff');
});

test('an answer in a code fence is still read', () => {
  assert.equal(TitleCapture.fromBody(bytes(message('```json\n{"title":"Fenced"}\n```'))), 'Fenced');
});

test('an answer that is not the title JSON is no title', () => {
  assert.equal(TitleCapture.fromBody(bytes(message('Payment retry backoff'))), null);
  assert.equal(TitleCapture.fromBody(bytes(message('{"name":"x"}'))), null);
  assert.equal(TitleCapture.fromBody('not json'), null);
  const capture = new TitleCapture();
  capture.line('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"title\\":"}}');
  assert.equal(capture.title(), null, 'a stream cut short');
});

test('control characters in a captured title are stripped', () => {
  assert.equal(TitleCapture.fromBody(bytes(message('{"title":"Pay\\u001b[2Jment\\nretry"}'))), 'Pay ment retry');
});

// ── through the proxy ──────────────────────────────────────────────────────

/** @param {any} server */
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * A proxy in front of an upstream that answers every request with `reply`.
 * @param {{ reply: (req: http.IncomingMessage, res: http.ServerResponse) => void, enabled?: boolean, proxy?: Record<string, any>, storePath?: string|null }} opts
 */
async function proxyWith({ reply, enabled = true, proxy = {}, storePath = null }) {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => reply(req, res)); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'key-a' }], 0.98);
  const titles = new SessionTitles({ enabled, projectsDir: await emptyProjects(), storePath });
  const server = createProxyServer(am, { proxy: { apiKey: 'k', ...proxy }, upstream: `http://127.0.0.1:${upstreamPort}` }, { sessionTitles: titles });
  const port = await listen(server);
  return { am, port, titles, close: () => { server.close(); upstream.close(); } };
}

/** @param {number} port @param {unknown} body @param {string|null} [sessionId] */
const send = async (port, body, sessionId = SESSION) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

/** @param {string} text */
const streamed = (text) => (/** @type {any} */ _req, /** @type {http.ServerResponse} */ res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(sse([text.slice(0, 5), text.slice(5)]));
};

/** @param {string} text */
const buffered = (text) => (/** @type {any} */ _req, /** @type {http.ServerResponse} */ res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message(text)));
};

test('a streamed title response names its session, and the client gets the stream unchanged', async () => {
  const ctx = await proxyWith({ reply: streamed('{"title":"Payment retry backoff"}') });
  try {
    const lines = await quietly(async () => {
      const res = await send(ctx.port, titleRequest());
      assert.equal(res.status, 200);
      assert.equal(res.text, sse(['{"tit', 'le":"Payment retry backoff"}']));
    });
    assert.equal(await ctx.titles.resolve(SESSION), 'Payment retry backoff');
    assert.ok(lines.some((l) => l.includes('Session 3f2a1b9c titled "Payment retry backoff"')), 'one line says the capture worked');
  } finally {
    ctx.close();
  }
});

test('a buffered title response names its session', async () => {
  const ctx = await proxyWith({ reply: buffered('{"title":"Payment retry backoff"}') });
  try {
    await quietly(async () => {
      assert.equal((await send(ctx.port, titleRequest({ stream: false }))).status, 200);
    });
    assert.equal(await ctx.titles.resolve(SESSION), 'Payment retry backoff');
  } finally {
    ctx.close();
  }
});

test('an ordinary request is not read for a title, even when its answer looks like one', async () => {
  const ctx = await proxyWith({ reply: buffered('{"title":"Not a session title"}') });
  try {
    await quietly(async () => {
      await send(ctx.port, { model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    });
    assert.equal(await ctx.titles.resolve(SESSION), null);
  } finally {
    ctx.close();
  }
});

test('with titles off, the title response is not read', async () => {
  const ctx = await proxyWith({ reply: buffered('{"title":"Payment retry backoff"}'), enabled: false });
  try {
    await quietly(async () => { await send(ctx.port, titleRequest({ stream: false })); });
    ctx.titles.configure({ enabled: true, projectsDir: ctx.titles.projectsDir });
    assert.equal(await ctx.titles.resolve(SESSION), null);
  } finally {
    ctx.close();
  }
});

test('a failed title request names nothing', async () => {
  const ctx = await proxyWith({
    reply: (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '{"title":"x"}' } }));
    },
  });
  try {
    await quietly(async () => { await send(ctx.port, titleRequest({ stream: false })); });
    assert.equal(await ctx.titles.resolve(SESSION), null);
  } finally {
    ctx.close();
  }
});

// ── the push endpoint ──────────────────────────────────────────────────────

/** The hook input Claude Code POSTs for UserPromptSubmit.
 * @param {Record<string, any>} [over] */
const hookInput = (over = {}) => ({
  session_id: SESSION,
  transcript_path: `/Users/someone/.claude/projects/-x/${SESSION}.jsonl`,
  cwd: '/x',
  prompt_id: 'p1',
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'hi',
  session_title: 'payments-refactor',
  ...over,
});

/** @param {number} port @param {unknown} body @param {string} [key] */
const pushTitle = async (port, body, key = 'k') => {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/session-title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, outcome: res.headers.get('x-teamclaude-session-title'), text: await res.text() };
};

const ok = buffered('{"x":1}');

test('a pushed title names a session the proxy knows, and the hook gets an empty object', async () => {
  const ctx = await proxyWith({ reply: ok });
  try {
    const lines = await quietly(async () => {
      await send(ctx.port, { model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      const res = await pushTitle(ctx.port, hookInput());
      assert.deepEqual(res, { status: 200, outcome: 'stored', text: '{}' });
      const again = await pushTitle(ctx.port, hookInput());
      assert.equal(again.outcome, 'unchanged');
    });
    assert.equal(ctx.titles.get(SESSION), 'payments-refactor');
    assert.equal(lines.filter((l) => l.includes('named "payments-refactor"')).length, 1, 'logged once, not once per prompt');
  } finally {
    ctx.close();
  }
});

test('a title for a session the proxy has not seen is not kept', async () => {
  const ctx = await proxyWith({ reply: ok });
  try {
    const res = await pushTitle(ctx.port, hookInput({ session_id: OTHER }));
    assert.deepEqual(res, { status: 200, outcome: 'unknown-session', text: '{}' });
    assert.equal(await ctx.titles.resolve(OTHER), null);
  } finally {
    ctx.close();
  }
});

test('a prompt with no session title is a no-op, not an error', async () => {
  const ctx = await proxyWith({ reply: ok });
  try {
    const untitled = hookInput();
    delete untitled.session_title;
    assert.deepEqual(await pushTitle(ctx.port, untitled), { status: 200, outcome: 'no-title', text: '{}' });
  } finally {
    ctx.close();
  }
});

test('a malformed session id or body is refused', async () => {
  const ctx = await proxyWith({ reply: ok });
  try {
    assert.equal((await pushTitle(ctx.port, hookInput({ session_id: '../../etc' }))).status, 400);
    assert.equal((await pushTitle(ctx.port, hookInput({ session_id: 42 }))).status, 400);
    assert.equal((await pushTitle(ctx.port, '{not json')).status, 400);
  } finally {
    ctx.close();
  }
});

test('with titles off the endpoint says so, without an error status', async () => {
  const ctx = await proxyWith({ reply: ok, enabled: false });
  try {
    assert.deepEqual(await pushTitle(ctx.port, hookInput()), { status: 200, outcome: 'disabled', text: '{}' });
  } finally {
    ctx.close();
  }
});

test('a client key may push a title; an inference-scoped key may not', async () => {
  const ctx = await proxyWith({
    reply: ok,
    proxy: { clientKeys: [{ name: 'laptop', key: 'laptop-key' }, { name: 'agent', key: 'agent-key', scope: 'inference' }] },
  });
  try {
    await quietly(async () => {
      await send(ctx.port, { model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal((await pushTitle(ctx.port, hookInput(), 'laptop-key')).outcome, 'stored');
    });
    assert.equal((await pushTitle(ctx.port, hookInput({ session_title: 'other' }), 'agent-key')).status, 403);
    assert.equal(ctx.titles.get(SESSION), 'payments-refactor');
  } finally {
    ctx.close();
  }
});

// ── priority ───────────────────────────────────────────────────────────────

/** A projects directory holding one transcript with an ai-title record.
 * @param {string} aiTitle */
async function projectsWith(aiTitle) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-title-projects-'));
  await mkdir(join(dir, '-x'), { recursive: true });
  await writeFile(join(dir, '-x', `${SESSION}.jsonl`), `${JSON.stringify({ type: 'ai-title', aiTitle, sessionId: SESSION })}\n`);
  return dir;
}

test('a pushed title wins over the disk, and the disk over a captured one', async () => {
  const titles = new SessionTitles({ enabled: true, projectsDir: await projectsWith('From disk') });
  titles.capture(SESSION, 'Captured');
  assert.equal(await titles.resolve(SESSION), 'From disk');
  titles.push(SESSION, 'pushed-name');
  assert.equal(await titles.resolve(SESSION), 'pushed-name');
  assert.equal(titles.get(SESSION), 'pushed-name');
});

test('a captured title names a session the disk knows nothing about', async () => {
  const titles = new SessionTitles({ enabled: true, projectsDir: await emptyProjects() });
  titles.capture(SESSION, 'Captured');
  assert.equal(await titles.resolve(SESSION), 'Captured');
  assert.equal(titles.get(SESSION), 'Captured');
});

// ── persistence ────────────────────────────────────────────────────────────

const storeIn = async () => join(await mkdtemp(join(tmpdir(), 'tc-title-store-')), 'teamclaude.session-titles.json');

test('kept titles survive a restart', async () => {
  const storePath = await storeIn();
  const projectsDir = await emptyProjects();
  const before = new SessionTitles({ enabled: true, projectsDir, storePath, saveDelayMs: 10 });
  before.push(SESSION, 'pushed-name');
  before.capture(OTHER, 'Captured');
  await before.flush();

  const after = new SessionTitles({ enabled: true, projectsDir, storePath });
  await after.load();
  assert.equal(await after.resolve(SESSION), 'pushed-name');
  assert.equal(await after.resolve(OTHER), 'Captured');
});

test('changes wait for the save delay, and flush writes them at once', async () => {
  const storePath = await storeIn();
  const titles = new SessionTitles({ enabled: true, projectsDir: await emptyProjects(), storePath, saveDelayMs: 60_000 });
  titles.push(SESSION, 'one');
  titles.push(SESSION, 'two');
  titles.capture(OTHER, 'three');
  await assert.rejects(readFile(storePath, 'utf8'), { code: 'ENOENT' }, 'nothing is written before the delay');
  await titles.flush();
  const doc = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(doc.sessions[SESSION].pushed, 'two');
  assert.equal(doc.sessions[OTHER].captured, 'three');
});

test('a title older than the age window is dropped on load', async () => {
  const storePath = await storeIn();
  const now = Date.now();
  await writeFile(storePath, JSON.stringify({
    version: 1,
    sessions: {
      [SESSION]: { pushed: 'recent', at: now - DAY },
      [OTHER]: { pushed: 'stale', at: now - 31 * DAY },
    },
  }));
  const titles = new SessionTitles({ enabled: true, projectsDir: await emptyProjects(), storePath });
  await titles.load(now);
  assert.equal(await titles.resolve(SESSION), 'recent');
  assert.equal(await titles.resolve(OTHER), null);
});

test('past the cap the oldest titles go first', async () => {
  const ids = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`);
  const titles = new SessionTitles({ enabled: true, projectsDir: await emptyProjects(), keptMax: 2 });
  ids.forEach((id, i) => titles.push(id, `title-${i}`, 1000 + i));
  assert.deepEqual([...titles.kept.keys()], ids.slice(1));
});

test('a file that is not a titles file reads as none', async () => {
  const storePath = await storeIn();
  await writeFile(storePath, JSON.stringify({ version: 99, sessions: { [SESSION]: { pushed: 'x', at: Date.now() } } }));
  const titles = new SessionTitles({ enabled: true, projectsDir: await emptyProjects(), storePath });
  await titles.load();
  assert.equal(await titles.resolve(SESSION), null);
});

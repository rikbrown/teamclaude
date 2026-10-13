import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, formatRateLimitDiagnostic } from '../src/server.js';

// Sessions hung for one to four minutes before the first byte, and the log
// could not say why: a 429's headers and body were thrown away, its retry-after
// could be a fallback the proxy made up, and nothing split the wait between
// upstream and the proxy's own queues and sleeps. These pin the two lines that
// now say so, and that the 429 handling around them is unchanged.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

function withEnv(name, value) {
  const prev = process.env[name];
  if (value == null) delete process.env[name]; else process.env[name] = String(value);
  return () => { if (prev == null) delete process.env[name]; else process.env[name] = prev; };
}

function captureLog() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

async function withProxy(names, handler, fn, configOverrides = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(tokenOf(req));
    const hit = seen.length;
    req.resume();
    req.on('end', () => handler(req, res, hit));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(names.map(account), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, ...configOverrides });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

async function post(port, model = 'claude-test') {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-abc' },
    body: JSON.stringify({ model, messages: [] }),
  });
  return { status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after'), headers: res.headers };
}

// The two methods the formatter reads off a fetch Headers object.
function headersOf(obj) {
  const m = new Map(Object.entries(obj));
  return { get: (k) => m.get(k) ?? null, entries: () => m.entries() };
}

const THROTTLE_HEADERS = {
  'content-type': 'application/json',
  'retry-after': '1',
  'request-id': 'req_011CTestThrottle',
  'cf-ray': '8f00aa11bb22cc33-LHR',
  'x-should-retry': 'true',
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
};
const THROTTLE_BODY = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } });

test('the 429 line carries what upstream said, on one line, with upstream text made safe', () => {
  const headers = headersOf({
    'request-id': 'req_abc\nforged',
    'cf-ray': 'ray-1',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-reset': '1760000000',
  });
  const body = Buffer.from(JSON.stringify({ error: { type: 'rate_limit_error', message: 'prompt=private\nauthorization: Bearer sk-ant-secret' } }));
  const line = formatRateLimitDiagnostic({ reqId: 42, sessionId: 'session-abc', account: 'acct', model: 'claude-x', attempt: 2, requestScoped: false, headers, body });
  assert.ok(line.startsWith('[TeamClaude] 429 from upstream request #42 session=session-abc on "acct"'), line);
  assert.match(line, /attempt 2, request-scoped no/);
  // No retry-after on a throttle: the 60 the branch then waits is ours, and the
  // line must say so rather than let it read as upstream's number.
  assert.match(line, /retry-after=none parsed=60s \(fallback used\)/);
  assert.match(line, /request-id=req_abc forged cf-ray=ray-1 x-should-retry=none/);
  assert.match(line, /"anthropic-ratelimit-unified-5h-status":"allowed"/);
  assert.match(line, /"anthropic-ratelimit-unified-reset":"1760000000"/);
  assert.match(line, /error\.type=rate_limit_error error\.message="\[redacted\]"/);
  assert.doesNotMatch(line, /[\n\r\x1b]|sk-ant-secret|prompt=private|authorization: Bearer/);
  const secretType = formatRateLimitDiagnostic({ account: 'acct', model: 'm', attempt: 0, requestScoped: false, headers, body: Buffer.from(JSON.stringify({ error: { type: 'sk-ant-secret', message: 'Bearer sk-ant-secret' } })) });
  assert.match(secretType, /error\.type=unknown error\.message="\[redacted\]"$/);
  assert.doesNotMatch(secretType, /sk-ant-secret/);
});

test('the 429 line says when the body was not read, and redacts a non-JSON body', () => {
  const headers = headersOf({ 'retry-after': '7' });
  const unread = formatRateLimitDiagnostic({ account: 'a', model: null, attempt: 0, requestScoped: false, headers, body: null });
  assert.match(unread, /retry-after=7 parsed=7s request-id=none/);
  assert.match(unread, /ratelimit=\{\} body unread$/);
  const html = formatRateLimitDiagnostic({ account: 'a', model: 'm', attempt: 0, requestScoped: true, headers: headersOf({}), body: Buffer.from('<html>Too many</html>') });
  // A request-scoped 429 never uses the fallback; an unknown body is private.
  assert.match(html, /request-scoped yes\): retry-after=none parsed=60s \(not applied\) request-id/);
  assert.match(html, /error\.type=unknown error\.message="\[redacted\]"$/);
});

// Upstream's #555 decides what a no-retry 429 does (relayed untouched, nothing
// paused; a spent quota window still rotates). These hold only the evidence
// line this fork writes for it.
test('a no-retry 429 logs one evidence line and leaves its body for the client', async () => {
  const responseBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required for fast mode.' } });
  const log = captureLog();
  try {
    await withProxy(['a', 'b'], (req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'x-should-retry': 'false',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
        'request-id': 'req_fast_mode',
      });
      res.end(responseBody);
    }, async ({ proxyPort, seen }) => {
      const result = await post(proxyPort, 'claude-fast');
      assert.equal(result.status, 429);
      assert.equal(result.body, responseBody, 'the diagnostic must not consume the body the client needs');
      assert.deepEqual(seen, ['t-a']);
    });
  } finally { log.restore(); }
  const diag = log.lines.filter(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.equal(diag.length, 1, log.lines.join('\n'));
  assert.match(diag[0], /retry-after=none parsed=not applied \(upstream says do not retry\) request-id=req_fast_mode/);
  assert.match(diag[0], /x-should-retry=false/);
});

test('a no-retry 429 names its own retry-after as not applied, and keeps the overage filter', async () => {
  const log = captureLog();
  try {
    await withProxy(['a', 'b'], (req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json', 'x-should-retry': 'false', 'retry-after': '30',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
      });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}');
    }, async ({ proxyPort }) => {
      const result = await post(proxyPort, 'claude-fast');
      assert.equal(result.status, 429);
      assert.equal(result.retryAfter, '30', 'an explicit upstream header remains unchanged');
      assert.equal(result.headers.get('anthropic-ratelimit-unified-overage-disabled-reason'), null,
        'the existing optional overage filter still applies');
    }, { stripOverageHeaders: true });
  } finally { log.restore(); }
  const diag = log.lines.find(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.match(diag, /retry-after=30 parsed=not applied \(upstream says do not retry\)/);
});

test('a no-retry 429 that spends a quota window is logged as a quota rejection, and rotates', async () => {
  const log = captureLog();
  try {
    await withProxy(['a', 'b'], (req, res, hit) => {
      if (hit === 1) {
        res.writeHead(429, {
          'content-type': 'application/json', 'x-should-retry': 'false', 'retry-after': '30',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1',
        });
        res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, async ({ proxyPort, seen }) => {
      assert.equal((await post(proxyPort, 'claude-fast')).status, 200);
      assert.deepEqual(seen, ['t-a', 't-b']);
    });
  } finally { log.restore(); }
  const diag = log.lines.find(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.match(diag, /retry-after=30 parsed=30s /);
});

test('a throttle 429 logs its evidence and is still paused and retried on the same account', async () => {
  const log = captureLog();
  try {
    await withProxy(['a', 'b'], (req, res, hit) => {
      if (hit === 1) { res.writeHead(429, THROTTLE_HEADERS); res.end(THROTTLE_BODY); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, async ({ am, proxyPort, seen }) => {
      // Occupy the hop target so the request stays where it is: the inline wait
      // on the same account is the behaviour this pins.
      am.pauseAccount(1, 30);
      const r = await post(proxyPort);
      assert.equal(r.status, 200);
      assert.deepEqual(seen, ['t-a', 't-a'], 'retried on the same account');
      assert.ok(am.accounts[0].pausedUntil != null, 'the throttled account was paused');
    });
  } finally { log.restore(); }
  const diag = log.lines.filter(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.equal(diag.length, 1, log.lines.join('\n'));
  assert.match(diag[0], /request #\d+ session=session-abc on "a" \(model claude-test, attempt 0, request-scoped no\)/);
  assert.match(diag[0], /retry-after=1 parsed=1s request-id=req_011CTestThrottle cf-ray=8f00aa11bb22cc33-LHR x-should-retry=true/);
  assert.match(diag[0], /"anthropic-ratelimit-unified-5h-utilization":"0\.42"/);
  assert.match(diag[0], /error\.type=rate_limit_error error\.message="Number of request tokens/);
  assert.ok(log.lines.some(l => l.includes('Rate-limit 429 on "a" — waiting 1s, retrying same account (no switch)')), log.lines.join('\n'));
});

test('a request-scoped 429 logs its evidence and still gets one short retry, then reaches the client unpaused', async () => {
  const restoreDelay = withEnv('TEAMCLAUDE_HEADERLESS_429_RETRY_DELAY_MS', 20);
  const log = captureLog();
  try {
    await withProxy(['a'], (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'request-id': 'req_scoped' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This model is not available.' } }));
    }, async ({ am, proxyPort, seen }) => {
      const r = await post(proxyPort);
      assert.equal(r.status, 429);
      assert.equal(r.retryAfter, null, 'no made-up retry-after');
      assert.match(r.body, /This model is not available\./);
      assert.deepEqual(seen, ['t-a', 't-a']);
      assert.equal(am.isPaused(0), false, 'a request-scoped 429 pauses nothing');
    });
  } finally { log.restore(); restoreDelay(); }
  const diag = log.lines.filter(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.equal(diag.length, 2, log.lines.join('\n'));
  assert.match(diag[0], /attempt 0, request-scoped yes\): retry-after=none parsed=60s \(not applied\) request-id=req_scoped/);
  assert.match(diag[1], /attempt 1, request-scoped yes/);
  assert.match(diag[0], /error\.message="This model is not available\."/);
});

test('an explicit long Retry-After is logged but still returned to the client', async () => {
  const log = captureLog();
  try {
    await withProxy(['a'], (req, res) => {
      res.writeHead(429, { ...THROTTLE_HEADERS, 'retry-after': '120' });
      res.end(THROTTLE_BODY);
    }, async ({ proxyPort, seen }) => {
      const result = await post(proxyPort);
      assert.equal(result.status, 429);
      assert.equal(result.retryAfter, '120');
      assert.deepEqual(seen, ['t-a']);
    });
  } finally { log.restore(); }
  const diag = log.lines.filter(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.equal(diag.length, 1, log.lines.join('\n'));
  assert.match(diag[0], /retry-after=120 parsed=120s request-id=/);
});

test('configured fallback is the parsed 429 delay, not a diagnostic-only default', async () => {
  const restoreFallback = withEnv('TEAMROUTER_RATE_LIMIT_FALLBACK_RETRY_AFTER_SECONDS', 120);
  const log = captureLog();
  try {
    await withProxy(['a'], (req, res) => {
      res.writeHead(429, { ...THROTTLE_HEADERS, 'retry-after': 'bogus' });
      res.end(THROTTLE_BODY);
    }, async ({ proxyPort }) => {
      const result = await post(proxyPort);
      assert.equal(result.status, 429);
      assert.equal(result.retryAfter, '120');
    });
  } finally { log.restore(); restoreFallback(); }
  const diag = log.lines.filter(l => l.startsWith('[TeamClaude] 429 from upstream'));
  assert.equal(diag.length, 1, log.lines.join('\n'));
  assert.match(diag[0], /retry-after=bogus parsed=120s \(fallback used\) request-id=/);
});

test('a stalled throttle body stops being read, without holding its response indefinitely', async () => {
  const log = captureLog();
  try {
    await withProxy(['a'], (req, res) => {
      res.writeHead(429, { ...THROTTLE_HEADERS, 'retry-after': '120' });
      res.write('{"error":'); // deliberately never ends; diagnostic body is optional
    }, async ({ proxyPort }) => {
      const start = performance.now();
      const result = await post(proxyPort);
      assert.equal(result.status, 429);
      assert.equal(result.retryAfter, '120');
      assert.ok(performance.now() - start < 8_000, 'a stalled upstream body must not hold the client');
    });
  } finally { log.restore(); }
  assert.match(log.lines.find(l => l.startsWith('[TeamClaude] 429 from upstream')) || '', /body unread$/);
});

test('a request slower than the threshold says where its time went', async () => {
  const restoreSlow = withEnv('TEAMCLAUDE_SLOW_REQUEST_LOG_MS', 300);
  const log = captureLog();
  try {
    await withProxy(['a', 'b'], (req, res, hit) => {
      if (hit === 1) { res.writeHead(429, THROTTLE_HEADERS); res.end(THROTTLE_BODY); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, async ({ am, proxyPort }) => {
      am.pauseAccount(1, 30);
      assert.equal((await post(proxyPort)).status, 200);
    });
  } finally { log.restore(); restoreSlow(); }
  const slow = log.lines.filter(l => l.startsWith('[TeamClaude] slow request'));
  assert.equal(slow.length, 1, log.lines.join('\n'));
  const m = slow[0].match(/^\[TeamClaude\] slow request #\d+ session=session-abc: (\d+)ms to response headers on "a" \(model claude-test, status 200, attempts 2\) — admit (\d+)ms, retry waits (\d+)ms, upstream (\d+)ms, other (\d+)ms$/);
  assert.ok(m, slow[0]);
  const [total, admit, waits, upstreamMs, other] = m.slice(1).map(Number);
  // The pause the 429 armed lapses with the inline 1s wait, so the retry's
  // admit() barely waits: the time is the proxy's own retry wait.
  assert.ok(waits >= 900, `retry waits ${waits}ms`);
  assert.ok(total >= waits, `total ${total}ms`);
  assert.ok(Math.abs(admit + waits + upstreamMs + other - total) <= 2, slow[0]);
});

test('a slow-request threshold of 0 turns the line off rather than logging everything', async () => {
  const slowLines = async (threshold) => {
    const restoreSlow = withEnv('TEAMCLAUDE_SLOW_REQUEST_LOG_MS', threshold);
    const log = captureLog();
    try {
      await withProxy(['a'], (req, res) => {
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 50);
      }, async ({ proxyPort }) => {
        assert.equal((await post(proxyPort)).status, 200);
      });
    } finally { log.restore(); restoreSlow(); }
    return log.lines.filter(l => l.startsWith('[TeamClaude] slow request'));
  };
  // The control: the same 50ms request is over a 1ms threshold.
  assert.equal((await slowLines(1)).length, 1);
  assert.equal((await slowLines(0)).length, 0);
});

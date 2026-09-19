import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A sidecar account whose back leg re-enters this proxy is a CONDUIT: what it
// forwards describes whichever pooled ChatGPT account served the second hop,
// not the conduit itself. That applies to both things a hop reports — the
// `x-codex-*` quota headers, and a quota-shaped 429.
//
// Filing the headers against the conduit made its bars a copy of the last
// account to answer. That is not just a wrong readout. The conduit is the only
// account its route can use on the way IN, so once a borrowed number crossed
// the switch threshold the conduit went unavailable and every gpt-* request
// failed — with a sibling subscription sitting at 0%.

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
const sidecar = (extra = {}) => oauth('codex', { upstream: 'http://127.0.0.1:18765', priority: 100, ...extra });
const chatgpt = (name) => oauth(name, { provider: 'codex', accountId: 'acct-' + name });

const spentWeek = {
  'x-codex-primary-used-percent': '99',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3 * 24 * 3600),
};

test('a conduit does not adopt a pooled account\'s codex quota', () => {
  const am = new AccountManager([sidecar(), chatgpt('one'), chatgpt('two')], 0.98, {
    routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['codex', 'one', 'two'] }],
  });
  am.updateQuota(0, spentWeek);
  assert.equal(am.accounts[0].quota.unified7d, null);
});

// The point of the guard: the conduit must stay selectable on the way in.
test('a spent pool does not take the conduit out of its own route', () => {
  const am = new AccountManager([sidecar(), chatgpt('one'), chatgpt('two')], 0.98, {
    routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['codex', 'one', 'two'] }],
  });
  am.updateQuota(0, spentWeek);
  const picked = am.getActiveAccount(null, 'gpt-6-astra', null, null, 'anthropic');
  assert.equal(picked?.name, 'codex');
});

// The pooled account it actually belongs to still records it, unchanged.
test('the pooled account still records its own codex quota', () => {
  const am = new AccountManager([sidecar(), chatgpt('one')], 0.98);
  am.updateQuota(1, spentWeek);
  assert.equal(am.accounts[1].quota.unified7d, 0.99);
});

// A STANDALONE sidecar holds its own ChatGPT login, so the numbers it forwards
// are genuinely its own and must keep landing — that is the documented setup in
// docs/openai.md#quota, and without it those bars read `unknown` for ever.
test('a standalone sidecar keeps its forwarded codex quota', () => {
  const am = new AccountManager([oauth('claude-1'), sidecar()], 0.98);
  am.updateQuota(1, spentWeek);
  assert.equal(am.accounts[1].quota.unified7d, 0.99);
});

// ── the hold a relayed 429 must never leave behind ──────────────────────────

// The same argument, applied to the other thing a hop reports. A quota-shaped
// 429 attributed to the conduit describes the window of whichever pooled
// account served its back leg — and that account has already recorded the spent
// window against itself. Holding the conduit for it files a copy of someone
// else's state, and copies go stale: the pool can recover inside the hold's
// term (a window rolls over, a free reset credit is redeemed) while the hold
// keeps every gpt-* request out, because the conduit is the only account its
// route can use on the way in. So server.js declines to throttle a conduit at
// all. Tracking the exhaustion once, where it is true, costs a loopback round
// trip per refused request and buys recovery the instant the pool has it.

// The predicate that gate asks, over every shape a fleet can hold. A REMOTE
// third-party backend (DeepSeek, GLM) keeps a public host, so nothing about it
// says it draws on this pool, and nothing about it stops being its own.
test('isCodexConduit: the sidecar in front of the pool, and nothing else', () => {
  const am = new AccountManager([
    sidecar(),
    chatgpt('one'),
    oauth('deepseek', { upstream: 'https://api.deepseek.com' }),
    oauth('claude-1'),
  ], 0.98);
  assert.equal(am.isCodexConduit(am.accounts[0]), true);
  assert.equal(am.isCodexConduit(am.accounts[1]), false, 'the pool is not in front of itself');
  assert.equal(am.isCodexConduit(am.accounts[2]), false);
  assert.equal(am.isCodexConduit(am.accounts[3]), false);
});

// Durable exhaustion — the 429 that rotates. A transient rate-limit 429 never
// reaches this branch at all: it pauses the account and retries it (#84).
const QUOTA_REJECTED = {
  'retry-after': '3600',
  'anthropic-ratelimit-unified-5h-status': 'rejected',
  'content-type': 'application/json',
};

/**
 * One `gpt-*` turn through a proxy whose upstream rejects every attempt on
 * quota. `makeAccounts` is handed the upstream's port so the conduit can be
 * pointed at something a request can really reach — loopback either way, which
 * is what makes it a conduit. Reports the credential each attempt carried, so
 * rotation is visible.
 *
 * @param {(port: number) => Record<string, any>[]} makeAccounts
 */
async function forwardOneQuotaRejection(makeAccounts) {
  /** @type {(string|undefined)[]} */
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(429, QUOTA_REJECTED);
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const am = new AccountManager(makeAccounts(port), 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` });
  const proxyPort = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [] }),
    });
    await res.text();
    return { status: res.status, seen, am };
  } finally {
    proxy.close();
    upstream.close();
  }
}

/**
 * The conduit, reachable. The 100 the helper carries is the operator's own
 * ordering; these tests put it back at the front of the queue so the relayed
 * refusal is the first thing the request meets rather than the second.
 */
const conduitAt = (/** @type {number} */ port) => sidecar({ upstream: `http://127.0.0.1:${port}`, priority: 0 });

test('a quota 429 the conduit relays leaves it exactly where it was', async () => {
  const r = await forwardOneQuotaRejection(port => [conduitAt(port), chatgpt('one')]);
  assert.equal(r.status, 429);
  assert.equal(r.am.accounts[0].status, 'active');
  assert.equal(r.am.accounts[0].rateLimitedUntil, null);
  // Which is the whole point: the next gpt-* request goes straight back out on
  // the conduit, rather than finding nothing selectable for the hour the
  // `retry-after` above asked for.
  assert.equal(r.am.getActiveAccount(null, 'gpt-6-astra', null, null, 'anthropic')?.name, 'codex');
});

// Declining the hold must not cost the rotation. The account is still marked
// tried, so one relayed refusal cannot become a loop against the same account —
// here the fleet has nowhere else to go, and the request ends after the single
// attempt instead of re-selecting the conduit it just left.
test('and the refusal still rotates away rather than looping on it', async () => {
  const r = await forwardOneQuotaRejection(port => [conduitAt(port), chatgpt('one')]);
  assert.deepEqual(r.seen, ['Bearer t-codex']);
});

// Only a conduit, and only because it has none of its own. An account holding a
// subscription owns the 429 it is sent, and is held for it as it always was.
test('an account with a subscription of its own is held exactly as before', async () => {
  const r = await forwardOneQuotaRejection(port => [conduitAt(port), oauth('claude-1'), chatgpt('one')]);
  assert.deepEqual(r.seen, ['Bearer t-codex', 'Bearer t-claude-1'], 'the rotation lands on the sibling');
  assert.equal(r.am.accounts[0].status, 'active');
  assert.equal(r.am.accounts[1].status, 'throttled');
});

// A standalone sidecar holds its OWN ChatGPT login: the window this 429 reports
// is its own, it is the only hop there is, and the hold means what it says.
test('a local sidecar with no Codex pool behind it is held like any other account', async () => {
  const r = await forwardOneQuotaRejection(port => [conduitAt(port), oauth('claude-1')]);
  assert.equal(r.am.accounts[0].status, 'throttled');
});

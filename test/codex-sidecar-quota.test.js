import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { collectRateLimitHeaders } from '../src/server.js';
import { codexSpentWindows } from '../src/codex-quota.js';

// Covers the codex-proxy feature's quota half: OpenAI/Codex rate-limit telemetry
// (`x-codex-primary/secondary-*` response headers, as forwarded by a translating
// sidecar) mapped into the existing 5h/weekly quota slots, and durable-429
// classification for a spent ChatGPT subscription window.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// ── updateQuota: codex windows → unified slots ───────────────────────────────

test('updateQuota maps codex primary/secondary used-percent into the 5h/7d slots', () => {
  const am = new AccountManager([oauth('codex')], 0.98);
  const reset = Math.floor((Date.now() + 3600_000) / 1000);
  am.updateQuota(0, {
    'x-codex-primary-used-percent': '62.5',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': String(reset),
    'x-codex-secondary-used-percent': '31',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-at': String(reset + 86_400),
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified5h, 0.625);                 // percent → 0-1 fraction
  assert.equal(q.unified5hReset, reset * 1000);     // seconds → ms
  assert.equal(q.unified7d, 0.31);
  assert.equal(q.unified7dReset, (reset + 86_400) * 1000);
});

test('updateQuota files a codex window by its length, not its position', () => {
  // A ChatGPT Pro subscription reports its weekly limit as the *primary* window
  // and has no secondary one at all.
  const am = new AccountManager([oauth('codex')], 0.98);
  const reset = Math.floor((Date.now() + 600_000_000) / 1000);
  am.updateQuota(0, {
    'x-codex-primary-used-percent': '1',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(reset),
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.01);
  assert.equal(q.unified7dReset, reset * 1000);
  assert.equal(q.unified5h, null);
});

test('updateQuota ignores a codex window the plan does not meter', () => {
  // Unmetered windows arrive as zeroes with no length — not as 0% used.
  const am = new AccountManager([oauth('codex')], 0.98);
  am.updateQuota(0, {
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-window-minutes': '0',
    'x-codex-secondary-reset-at': '',
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified5h, null);
  assert.equal(q.unified7d, null);
});

test('updateQuota accepts an ISO-8601 codex reset-at', () => {
  const am = new AccountManager([oauth('codex')], 0.98);
  const iso = new Date(Date.now() + 3600_000).toISOString();
  am.updateQuota(0, {
    'x-codex-primary-used-percent': '10',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': iso,
  });
  assert.equal(am.accounts[0].quota.unified5hReset, Date.parse(iso));
});

test('updateQuota ignores absent or garbage codex headers', () => {
  const am = new AccountManager([oauth('codex')], 0.98);
  am.updateQuota(0, {
    'x-codex-primary-used-percent': 'not-a-number',
    'x-codex-primary-reset-at': 'whenever',
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified5h, null);
  assert.equal(q.unified5hReset, null);
});

// ── header collection ────────────────────────────────────────────────────────

test('collectRateLimitHeaders keeps anthropic-ratelimit-* and x-codex-*, drops the rest', () => {
  const headers = new Map([
    ['anthropic-ratelimit-unified-5h-utilization', '0.5'],
    ['x-codex-primary-used-percent', '62.5'],
    ['content-type', 'application/json'],
    ['x-request-id', 'abc'],
  ]);
  assert.deepEqual(collectRateLimitHeaders(headers), {
    'anthropic-ratelimit-unified-5h-utilization': '0.5',
    'x-codex-primary-used-percent': '62.5',
  });
});

// ── durable 429 classification ───────────────────────────────────────────────

// Read through `parseCodexQuota` rather than off the raw header pair, so a
// window is classified by its own `window-minutes` and every family is covered.
// The flat reading could not see a spent SESSION window at all: a subscription
// states its only 5-hour one inside a named family.

test('an account-wide window at its limit is spent', () => {
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '10080',
  }), ['weekly']);
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '300',
  }), ['5h']);
  // Upstream keeps counting once a window is past its limit.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '104.2',
    'x-codex-primary-window-minutes': '10080',
  }), ['weekly']);
});

test('a named family at its limit is spent, account-wide headroom or not', () => {
  // The case the account-wide percentages cannot state: a subscription's only
  // 5-hour window sits in a named family, and the flat pair reads 42% / 0%.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-window-minutes': '0',
    'x-codex-gpt-5-limit-name': 'gpt-5',
    'x-codex-gpt-5-primary-used-percent': '100',
    'x-codex-gpt-5-primary-window-minutes': '300',
  }), ['5h']);
  // A model-scoped weekly bucket is spent on its own terms.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '50',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-gpt-5-limit-name': 'gpt-5',
    'x-codex-gpt-5-secondary-used-percent': '100',
    'x-codex-gpt-5-secondary-window-minutes': '10080',
  }), ['gpt-5 weekly']);
});

test('headroom, and headers that state nothing, are not spent', () => {
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '99.4',
    'x-codex-primary-window-minutes': '10080',
  }), []);
  // A 429 with no Codex headers at all — the throttle case, which must stay a
  // throttle: pausing and retrying the same account is the right answer to it.
  assert.deepEqual(codexSpentWindows({}), []);
  // Anthropic's own spelling is classified by the unified statuses, not here.
  assert.deepEqual(codexSpentWindows({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }), []);
  // A zeroed window is how this API says "not applicable"; a percentage beside
  // it means nothing, and reading it as spent would hold a healthy account.
  assert.deepEqual(codexSpentWindows({
    'x-codex-secondary-used-percent': '100',
    'x-codex-secondary-window-minutes': '0',
  }), []);
  // Unparseable or unstated readings are dropped rather than guessed at.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': 'n/a',
    'x-codex-primary-window-minutes': '10080',
  }), []);
  assert.deepEqual(codexSpentWindows({ 'x-codex-primary-used-percent': '100' }), []);
});

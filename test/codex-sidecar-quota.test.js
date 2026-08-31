import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { collectRateLimitHeaders, codexQuotaRejected } from '../src/server.js';

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

test('codexQuotaRejected is true when either codex window is spent', () => {
  assert.equal(codexQuotaRejected({ 'x-codex-primary-used-percent': '100' }), true);
  assert.equal(codexQuotaRejected({ 'x-codex-primary-used-percent': '104.2' }), true);
  assert.equal(codexQuotaRejected({ 'x-codex-secondary-used-percent': '100' }), true);
});

test('codexQuotaRejected is false below the limit or without codex headers', () => {
  assert.equal(codexQuotaRejected({ 'x-codex-primary-used-percent': '99.4' }), false);
  assert.equal(codexQuotaRejected({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }), false);
  assert.equal(codexQuotaRejected({}), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// A route that NAMES its accounts may legitimately span two providers. That is
// the shape of the Codex sidecar connection: `gpt-*` lists the local sidecar
// account (Anthropic wire, hop 1) alongside the ChatGPT subscriptions that the
// sidecar's own back leg re-enters this proxy to draw (Codex path, hop 2).
// Both hops are that route's traffic.
//
// The routing view used to filter its account list through the partition for
// ONE provider, so only the sidecar showed. The ChatGPT accounts were absent
// rather than merely idle — and a newly added subscription that nobody had put
// in the route's `accounts` list looked identical to one that was there and
// working. That is exactly the diagnosis this view exists to make cheap.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const codex = (name) => oauth(name, { provider: 'codex', accountId: 'acct-' + name });
const byName = (routes, name) => routes.find(r => r.name === name);

function fleet() {
  return new AccountManager([
    oauth('claude-1'),
    oauth('sidecar', { upstream: 'http://127.0.0.1:18765', priority: 100 }),
    codex('chatgpt-1'),
    codex('chatgpt-2'),
  ], 0.98, {
    routes: [
      { name: 'codex', match: ['gpt-*'], accounts: ['sidecar', 'chatgpt-1', 'chatgpt-2'] },
      { name: 'anthropic', match: ['*'], accounts: ['claude-1'] },
    ],
  });
}

test('a route that names accounts from two providers shows all of them', () => {
  const route = byName(fleet().getRoutes(), 'codex');
  assert.deepEqual(route.accounts.map(a => a.name), ['sidecar', 'chatgpt-1', 'chatgpt-2']);
});

test('each listed account reports the provider that will serve it', () => {
  const route = byName(fleet().getRoutes(), 'codex');
  assert.deepEqual(
    route.accounts.map(a => [a.name, a.provider]),
    [['sidecar', 'anthropic'], ['chatgpt-1', 'codex'], ['chatgpt-2', 'codex']],
  );
});

// Eligibility is what the row is FOR, so it has to keep answering per account
// once the list spans providers.
test('eligibility still tracks each account individually', () => {
  const am = fleet();
  assert.ok(byName(am.getRoutes(), 'codex').accounts.every(a => a.eligible));

  am.setDisabled(2, true); // chatgpt-1
  const after = byName(am.getRoutes(), 'codex').accounts;
  assert.equal(after.find(a => a.name === 'chatgpt-1').eligible, false);
  assert.equal(after.find(a => a.name === 'chatgpt-2').eligible, true);
  assert.equal(after.find(a => a.name === 'sidecar').eligible, true);
});

// The other half of the rule: a route that lists NOBODY constrains models, not
// accounts, so only the asking provider's own pool can serve it. Widening that
// one would have put ChatGPT subscriptions into every Claude route's view.
test('a route that lists no accounts keeps the provider partition', () => {
  const am = new AccountManager([
    oauth('claude-1'),
    codex('chatgpt-1'),
  ], 0.98, { routes: [{ name: 'bulk', match: ['*opus*'] }] });
  assert.deepEqual(byName(am.getRoutes(), 'bulk').accounts.map(a => a.name), ['claude-1']);
});

// The unchanged case, asserted so the common fleet cannot drift: a route whose
// accounts are all Anthropic renders exactly as it always did.
test('a single-provider route is unaffected', () => {
  const route = byName(fleet().getRoutes(), 'anthropic');
  assert.deepEqual(route.accounts.map(a => a.name), ['claude-1']);
  assert.equal(route.accounts[0].provider, 'anthropic');
});

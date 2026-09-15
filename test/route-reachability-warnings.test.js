import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeReachabilityWarnings, canServeProvider } from '../src/route-warnings.js';

// The outage, 2026-09-15: the `gpt-*` route lost the local sidecar account —
// the only one that served its INBOUND leg — leaving the two ChatGPT
// subscriptions its back leg draws on. Those are Codex accounts, so they serve
// `/backend-api/codex/*` and nothing else. Every GPT request failed instantly
// while `teamclaude status` showed two healthy accounts on the route, and
// nothing said why. Route membership is by name; eligibility is by provider.

const codex = (name) => ({ name, type: 'oauth', provider: 'codex' });
const claude = (name) => ({ name, type: 'oauth' });
const apikey = (name) => ({ name, type: 'apikey' });
const sidecar = (name) => ({ name, type: 'oauth', upstream: 'http://127.0.0.1:18765' });

test('the outage: a route left with only Codex subscriptions', () => {
  const [warning, ...rest] = routeReachabilityWarnings(
    [{ name: 'codex', match: ['gpt-*'], accounts: ['codex:a', 'codex:b'] }],
    [codex('codex:a'), codex('codex:b'), claude('rik@thumb.cat')],
  );
  assert.equal(rest.length, 0);
  assert.match(warning, /Route "codex" \(gpt-\*\)/);
  assert.match(warning, /no account that can serve \/v1\/messages/);
  assert.match(warning, /codex:a, codex:b/);
});

test('the same route with the sidecar back on it is silent', () => {
  assert.deepEqual(routeReachabilityWarnings(
    [{ name: 'codex', match: ['gpt-*'], accounts: ['codex', 'codex:a', 'codex:b'] }],
    [sidecar('codex'), codex('codex:a'), codex('codex:b')],
  ), []);
});

test('an API key is not fenced off by provider, so it keeps a route reachable', () => {
  // A third-party backend account carries no plan tie — it is metered capacity,
  // not a seat — so it serves whichever app is asking. Mirrors the partition
  // selection actually applies.
  assert.deepEqual(routeReachabilityWarnings(
    [{ name: 'bulk', match: ['gpt-*'], accounts: ['codex:a', 'deepseek'] }],
    [codex('codex:a'), apikey('deepseek')],
  ), []);
});

test('a route with no explicit list means the whole fleet, so it cannot have this problem', () => {
  for (const accounts of [undefined, []]) {
    assert.deepEqual(routeReachabilityWarnings(
      [{ name: 'all', match: ['*'], accounts }], [codex('codex:a')]), []);
  }
});

test('a list whose names resolve to nothing is left alone', () => {
  // A different fault — a name that names no account — and calling it "cannot
  // serve" would point the reader at the wrong repair.
  assert.deepEqual(routeReachabilityWarnings(
    [{ name: 'ghost', match: ['gpt-*'], accounts: ['typo'] }], [codex('codex:a')]), []);
});

test('accounts may be listed by index as well as by name', () => {
  const warnings = routeReachabilityWarnings(
    [{ name: 'codex', match: ['gpt-*'], accounts: ['0'] }],
    [{ ...codex('codex:a'), index: 0 }],
  );
  assert.equal(warnings.length, 1);
});

test('empty and malformed input is silent, never thrown', () => {
  assert.deepEqual(routeReachabilityWarnings(), []);
  assert.deepEqual(routeReachabilityWarnings(null, null), []);
  assert.deepEqual(routeReachabilityWarnings([null], [null]), []);
});

test('canServeProvider mirrors the subscription-only partition', () => {
  assert.equal(canServeProvider(claude('a'), 'anthropic'), true);
  assert.equal(canServeProvider(codex('b'), 'anthropic'), false);
  assert.equal(canServeProvider(codex('b'), 'codex'), true);
  assert.equal(canServeProvider(claude('a'), 'codex'), false);
  assert.equal(canServeProvider(apikey('k'), 'codex'), true);
  assert.equal(canServeProvider(apikey('k'), 'anthropic'), true);
});

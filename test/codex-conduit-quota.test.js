import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// A sidecar account whose back leg re-enters this proxy is a CONDUIT: the
// `x-codex-*` headers it forwards describe whichever pooled ChatGPT account
// served the second hop, not the conduit itself.
//
// Filing them against the conduit made its bars a copy of the last account to
// answer. That is not just a wrong readout. The conduit is the only account its
// route can use on the way IN, so once a borrowed number crossed the switch
// threshold the conduit went unavailable and every gpt-* request failed — with
// a sibling subscription sitting at 0%.

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
const sidecar = () => oauth('codex', { upstream: 'http://127.0.0.1:18765', priority: 100 });
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateAccountNames, duplicateNameWarnings, sameIdentity } from '../src/identity.js';

// `name` is the addressing key — routes, TC_ACCT, /tc-acct/, `teamclaude
// disable` and the TUI pickers all resolve accounts by it. Identity is
// deliberately provider-aware, so one person's email on Anthropic and on Codex
// is correctly two accounts. Together those give two rows with one name, and
// every name lookup becomes ambiguous — with the lookups disagreeing about
// which one they mean.
//
// Observed live: `teamclaude login --codex` defaulted to an email that already
// named a Claude Max account. Adding that name to the gpt-* route admitted the
// Anthropic account too, and at priority 0 against the sidecar's 100 it won —
// so every gpt-* request would have been sent to api.anthropic.com.

const acct = (name, extra = {}) => ({ name, type: 'oauth', ...extra });
const codex = (name) => acct(name, { provider: 'codex', accountId: 'a-' + name });

test('a name held on two providers is reported', () => {
  const dupes = duplicateAccountNames([acct('me@example.com'), codex('me@example.com'), acct('other')]);
  assert.deepEqual(dupes, [{ name: 'me@example.com', providers: ['anthropic', 'codex'] }]);
});

test('distinct names report nothing', () => {
  assert.deepEqual(duplicateAccountNames([acct('a'), codex('codex:a'), acct('b')]), []);
  assert.deepEqual(duplicateNameWarnings([acct('a'), codex('codex:a')]), []);
});

// Same provider, same name is a duplicate too — `resolveAccountPin` takes the
// first and the second is unaddressable.
test('a name repeated within one provider also counts', () => {
  assert.deepEqual(
    duplicateAccountNames([acct('dup'), acct('dup')]),
    [{ name: 'dup', providers: ['anthropic', 'anthropic'] }],
  );
});

test('accounts without a usable name are skipped, not crashed on', () => {
  assert.deepEqual(duplicateAccountNames([{}, { name: '' }, null, acct('ok')]), []);
  assert.deepEqual(duplicateAccountNames(), []);
});

test('the warning names the collision and suggests a fix', () => {
  const [line] = duplicateNameWarnings([acct('me@example.com'), codex('me@example.com')]);
  assert.match(line, /me@example\.com/);
  assert.match(line, /anthropic, codex/);
  assert.match(line, /codex:me@example\.com/);
});

// The guard exists precisely BECAUSE these two are, correctly, not one account.
test('the two accounts are still distinct identities', () => {
  assert.equal(sameIdentity(acct('me@example.com'), codex('me@example.com')), false);
});

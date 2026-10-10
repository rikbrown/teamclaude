import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, LONG_PROMPT, priceFor, inputCost, outputPrice, formatSpend } from '../src/pricing.js';

// What the throughput meter's spend reading prices a response at: API list
// prices, per million tokens.

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test('a dated snapshot and a context-window suffix are priced as the model they name', () => {
  assert.equal(priceFor('claude-haiku-4-5-20251001'), PRICES['claude-haiku-4-5']);
  assert.equal(priceFor('claude-opus-5-5[1m]'), PRICES['claude-opus-5-5']);
  assert.equal(priceFor('Claude-Opus-5-5'), PRICES['claude-opus-5-5']);
});

test('a model the table does not know costs nothing rather than a guess', () => {
  for (const model of ['gpt-6-astra', 'claude-opus-9', '', null, undefined, 42, 'toString', '__proto__']) {
    assert.equal(priceFor(/** @type {any} */ (model)), null, String(model));
    assert.equal(inputCost(/** @type {any} */ (model), { input_tokens: 1e6 }), 0);
    assert.equal(outputPrice(/** @type {any} */ (model)), 0);
  }
});

test('the input side prices fresh input, cache reads, and each TTL\'s cache writes', () => {
  // Opus 5.5: $4 in, reads $0.20, writes $5 (5m) and $8 (1h).
  close(inputCost('claude-opus-5-5', {
    input_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 3e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 2e6 },
  }), 4 + 0.2 + 5 + 16);
  // No split stated: every write at the 5-minute rate.
  close(inputCost('claude-opus-5-5', { cache_creation_input_tokens: 1e6 }), 5);
  // Fable 5.1 reads at a fortieth of its input.
  close(inputCost('claude-fable-5-1', { cache_read_input_tokens: 1e6 }), 0.25);
  // Junk counts are nothing, not NaN.
  close(inputCost('claude-opus-5-5', { input_tokens: -5, cache_read_input_tokens: NaN, cache_creation_input_tokens: 'x' }), 0);
  assert.equal(inputCost('claude-opus-5-5', null), 0);
});

test('Haiku 5.5 moves to its long-prompt rate card past LONG_PROMPT tokens of prompt', () => {
  const short = { input_tokens: 10, cache_read_input_tokens: LONG_PROMPT - 10 };
  const long = { input_tokens: 10, cache_read_input_tokens: LONG_PROMPT };
  close(inputCost('claude-haiku-5-5', short), (10 * 0.1 + (LONG_PROMPT - 10) * 0.01) / 1e6);
  close(inputCost('claude-haiku-5-5', long), (10 * 0.5 + LONG_PROMPT * 0.05) / 1e6);
  close(outputPrice('claude-haiku-5-5', short), 0.5 / 1e6);
  close(outputPrice('claude-haiku-5-5', long), 2.5 / 1e6);
  close(outputPrice('claude-haiku-5-5'), 0.5 / 1e6);
  // One rate card everywhere else, however long the prompt.
  close(outputPrice('claude-opus-5-5', long), 20 / 1e6);
});

test('an hour\'s spend prints to the cent, a tenth of one below a cent, and thousands as k', () => {
  assert.equal(formatSpend(0), '$0.00/h');
  assert.equal(formatSpend(-1), '$0.00/h');
  assert.equal(formatSpend(NaN), '$0.00/h');
  assert.equal(formatSpend(0.004), '$0.004/h');
  assert.equal(formatSpend(0.0099), '$0.010/h');
  assert.equal(formatSpend(36), '$36.00/h');
  assert.equal(formatSpend(99.999), '$100/h');
  assert.equal(formatSpend(972.4), '$972/h');
  assert.equal(formatSpend(9_720), '$9720/h');
  assert.equal(formatSpend(12_330), '$12.3k/h');
  assert.equal(formatSpend(108_000), '$108k/h');
});

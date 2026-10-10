// What a request would have cost at Anthropic's pay-as-you-go API prices: the
// throughput meter's second reading, the fleet's spend over the last hour next
// to its tokens per second. The fleet runs on subscriptions, so nobody is billed this; it is
// the answer to "what would this be costing me on the API".
//
// List prices only, first-party Claude API, per million tokens. Not modelled:
// fast mode (a 2x premium), Batches, web search and other server tools, and
// partner platforms. A model this table does not know (a newer Claude, the
// Codex sidecar's gpt-*) costs nothing rather than a guess.
//
// Pure: usage in, dollars out.

/** @typedef {{ input: number, output: number, cacheRead: number, longInput?: number, longOutput?: number }} Price */

/** $/MTok by model id, as published (2026-10). Cache writes are not listed:
 *  every model writes at 1.25x input for the 5-minute TTL and 2x for 1 hour. */
/** @type {Record<string, Price>} */
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Haiku 5.5 has a second rate card for prompts over LONG_PROMPT tokens.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, longInput: 0.5, longOutput: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** Prompt tokens (input, cache reads and cache writes together) past which a
 *  model with a long-prompt rate card is priced on it. */
export const LONG_PROMPT = 100_000;

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

const count = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The price of `model`, or null when this table does not know it. A dated
 * snapshot (`claude-haiku-4-5-20251001`) and a context-window suffix
 * (`claude-opus-5-5[1m]`) are priced as the model they name.
 * @param {string|null|undefined} model
 * @returns {Price|null}
 */
export function priceFor(model) {
  if (typeof model !== 'string' || !model) return null;
  const id = model.toLowerCase().replace(/\[.*$/, '').replace(/-\d{8}$/, '');
  return Object.hasOwn(PRICES, id) ? PRICES[id] : null;
}

/** The prompt's size, for picking a long-prompt rate card. @param {Record<string, any>} usage */
const promptTokens = (usage) =>
  count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);

/**
 * Dollars for the input side of one response: fresh input, cache reads, and
 * cache writes at their TTL's rate. A usage block with no 5m/1h split books
 * every write at the 5-minute rate.
 * @param {string|null|undefined} model
 * @param {Record<string, any>|null|undefined} usage Anthropic-shaped
 */
export function inputCost(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return 0;
  const long = p.longInput !== undefined && promptTokens(usage) > LONG_PROMPT;
  const rate = long ? /** @type {number} */ (p.longInput) : p.input;
  const read = long ? rate * (p.cacheRead / p.input) : p.cacheRead;
  const split = usage.cache_creation;
  const w1h = count(split?.ephemeral_1h_input_tokens);
  const w5m = split && split.ephemeral_5m_input_tokens !== undefined
    ? count(split.ephemeral_5m_input_tokens)
    : Math.max(0, count(usage.cache_creation_input_tokens) - w1h);
  return (count(usage.input_tokens) * rate
    + count(usage.cache_read_input_tokens) * read
    + w5m * rate * CACHE_WRITE_5M
    + w1h * rate * CACHE_WRITE_1H) / 1e6;
}

/**
 * Dollars per output token of `model`, or 0 when it is not priced. `usage` is
 * the input side, when known, for a model with a long-prompt rate card.
 * @param {string|null|undefined} model
 * @param {Record<string, any>|null} [usage]
 */
export function outputPrice(model, usage = null) {
  const p = priceFor(model);
  if (!p) return 0;
  const long = p.longOutput !== undefined && usage && promptTokens(usage) > LONG_PROMPT;
  return (long ? /** @type {number} */ (p.longOutput) : p.output) / 1e6;
}

/**
 * An hour's spend as the TUI prints it: `$0.00/h`, `$0.004/h`, `$36.00/h`,
 * `$972/h`, `$12.3k/h`. Three places below a cent, so a trickle does not read
 * as nothing.
 * @param {number} dollars spent over the last hour
 */
export function formatSpend(dollars) {
  const v = Number.isFinite(dollars) && dollars > 0 ? dollars : 0;
  if (v === 0) return '$0.00/h';
  if (v < 0.00995) return `$${v.toFixed(3)}/h`;
  if (v < 99.995) return `$${v.toFixed(2)}/h`;
  if (v < 9_999.5) return `$${Math.round(v)}/h`;
  if (v < 99_950) return `$${(v / 1_000).toFixed(1)}k/h`;
  return `$${Math.round(v / 1_000)}k/h`;
}

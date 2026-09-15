// Config coherence a route cannot check for itself.
//
// Route membership is by NAME, but eligibility is by PROVIDER — and the two
// disagree silently. A route may name three accounts, every one of them healthy
// in `teamclaude status`, and still be unable to answer the request that
// actually arrives, because the arriving path decides which of them are even
// candidates.

import { providerOf, isSubscriptionAccount, DEFAULT_PROVIDER } from './provider.js';

/**
 * Whether `account` is a candidate for a request on `provider`'s path.
 *
 * Mirrors the partition selection applies (`_excludeOtherProviders`): only
 * SUBSCRIPTION accounts are fenced off by provider, because a Claude Max token
 * is issued to Claude and a ChatGPT token to Codex. An API key is metered
 * capacity rather than a seat, so it stays eligible for whichever app is asking.
 */
export function canServeProvider(account, provider) {
  return providerOf(account) === provider || !isSubscriptionAccount(account);
}

/**
 * Warn about a route that no inbound Claude Code request can be served by.
 *
 * The failure this exists for, observed live on 2026-09-15: a `gpt-*` route lost
 * the one account that served its inbound leg — the local translating sidecar —
 * leaving only the ChatGPT subscriptions its back leg draws on. Those are Codex
 * accounts, so they serve `/backend-api/codex/*` and nothing else. Every GPT
 * request died instantly while `teamclaude status` showed two healthy accounts
 * sitting on the route, and nothing anywhere said why.
 *
 * Only routes with an explicit `accounts` list are checked. An empty list means
 * "the whole fleet", which cannot have this problem — and the explicit list is
 * where the trap lives, because it is edited by hand and silently load-bearing.
 */
export function routeReachabilityWarnings(routes = [], accounts = []) {
  const warnings = [];
  for (const route of routes || []) {
    const listed = route?.accounts;
    if (!Array.isArray(listed) || listed.length === 0) continue;
    const members = (accounts || []).filter(a =>
      listed.includes(a?.name) || (a?.index != null && listed.includes(String(a.index))));
    // No member resolves at all: a different fault (a name that names nothing),
    // and reporting it as "cannot serve" would point at the wrong repair.
    if (members.length === 0) continue;
    if (members.some(a => canServeProvider(a, DEFAULT_PROVIDER))) continue;

    const names = members.map(a => a.name).join(', ');
    const providers = [...new Set(members.map(a => providerOf(a)))].join('/');
    const globs = (route.match || []).join(', ');
    warnings.push(
      `[TeamClaude] Route "${route.name}"${globs ? ` (${globs})` : ''} has no account that can serve `
      + `/v1/messages — every account it lists (${names}) is a ${providers} subscription, which serves `
      + 'only its own path. Claude Code requests matching this route will find no account, while '
      + '`teamclaude status` shows the route healthy. Add back the account that serves the inbound '
      + 'leg (for a sidecar setup, the local one).');
  }
  return warnings;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerFor,
  hasBackendQuota,
  fetchBackendQuota,
  accountQuotaProvider,
  bestAntigravityAccount,
} from '../src/backend-quota.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// Antigravity local proxy (`antigravity-claude-proxy`): runs on loopback so it
// opts in via `accounts[].quotaProvider: "antigravity"`. One endpoint returns
// every pooled Google account with Gemini and 3p (Claude+GPT) windows; top-level
// windows reflect the best usable Google account while `accounts` carries all
// of them for the TUI's Gemini panel.

const UPSTREAM = 'http://127.0.0.1:18080';
const H = 3600_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SES_RESET = now + 3 * H + 22 * 60_000 + 30_000;
const WK_RESET = now + 6 * 24 * H + 22 * H + 30_000;
const P3_SES_RESET = now + 4 * H + 43 * 60_000 + 30_000;
const P3_WK_RESET = now + 6 * 24 * H + 23 * H + 30_000;

const okFetch = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function googleAccount(email, windows, over = {}) {
  return { email, enabled: true, status: 'ok', groups: [{ id: 'gemini', windows }], ...over };
}

const remaining = (remainingFraction, resetAt) => ({
  remainingFraction,
  ...(resetAt == null ? {} : { resetTime: iso(resetAt) }),
});
const parse = (accounts) => providerFor(UPSTREAM, 'antigravity').parse({ accounts });

function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { return { result: fn(), logs }; } finally { console.log = orig; }
}

test('quotaProvider matches antigravity regardless of host; host matching stays untouched', () => {
  assert.equal(providerFor(UPSTREAM), null, 'loopback host alone does not match any provider');
  assert.equal(hasBackendQuota({ upstream: UPSTREAM }), false);

  const p = providerFor(UPSTREAM, 'antigravity');
  assert.ok(p);
  assert.equal(p.path, '/v1/account-quotas');
  assert.ok(providerFor('https://proxy.internal:9999', 'antigravity'), 'any host matches when quotaProvider is set');
  assert.ok(providerFor(UPSTREAM, ' Antigravity '), 'case and surrounding whitespace normalize');
  assert.equal(providerFor(UPSTREAM, 'unknown-vendor'), null);

  assert.equal(hasBackendQuota({ upstream: UPSTREAM, quotaProvider: 'antigravity' }), true);
  assert.equal(hasBackendQuota({ upstream: null, quotaProvider: 'antigravity' }), false, 'upstream is still required');
  assert.equal(hasBackendQuota({ upstream: 'not a url', quotaProvider: 'antigravity' }), false);

  // Existing host-matched providers keep working without quotaProvider.
  assert.ok(providerFor('https://api.deepseek.com/anthropic'));
  assert.equal(hasBackendQuota({ upstream: 'https://api.deepseek.com/anthropic' }), true);
});

test('accountQuotaProvider validates config values and logs once for invalid ones', () => {
  assert.equal(accountQuotaProvider({ name: 'g', upstream: UPSTREAM }), null);
  assert.equal(accountQuotaProvider({ name: 'g', upstream: UPSTREAM, quotaProvider: '' }), null);
  assert.equal(accountQuotaProvider({ name: 'g', upstream: UPSTREAM, quotaProvider: 'antigravity' }), 'antigravity');
  assert.equal(accountQuotaProvider({ name: 'g', upstream: UPSTREAM, quotaProvider: ' AntiGravity ' }), 'antigravity');

  const badType = captureLogs(() => accountQuotaProvider({ name: 'g', upstream: UPSTREAM, quotaProvider: 42 }));
  assert.equal(badType.result, null);
  assert.ok(badType.logs.some(l => /ignoring quotaProvider.*must be a string/.test(l)));

  const unknown = captureLogs(() => accountQuotaProvider({ name: 'g', upstream: UPSTREAM, quotaProvider: 'bogus' }));
  assert.equal(unknown.result, null);
  assert.ok(unknown.logs.some(l => /ignoring quotaProvider.*unknown provider "bogus"/.test(l)));

  const noUpstream = captureLogs(() => accountQuotaProvider({ name: 'g', quotaProvider: 'antigravity' }));
  assert.equal(noUpstream.result, null);
  assert.ok(noUpstream.logs.some(l => /ignoring quotaProvider.*requires an `upstream`/.test(l)));
});

test('AccountManager and syncAccountsFromDisk load, validate, and live-sync quotaProvider', async () => {
  const disk = {
    accounts: [{ name: 'gemini', type: 'apikey', apiKey: 'ak', upstream: UPSTREAM, quotaProvider: 'antigravity' }],
  };
  const mem = { accounts: [{ ...disk.accounts[0] }] };
  const am = new AccountManager(disk.accounts);
  assert.equal(am.accounts[0].quotaProvider, 'antigravity');
  assert.equal(am.getStatus().accounts[0].quotaProvider, 'antigravity');

  // Removing quotaProvider on disk clears it on reload and deletes the mirror key.
  await syncAccountsFromDisk(
    { accounts: [{ name: 'gemini', type: 'apikey', apiKey: 'ak', upstream: UPSTREAM }] },
    mem,
    am,
  );
  assert.equal(am.accounts[0].quotaProvider, null);
  assert.equal('quotaProvider' in mem.accounts[0], false);

  // Re-adding it on disk brings it back live.
  await syncAccountsFromDisk(disk, mem, am);
  assert.equal(am.accounts[0].quotaProvider, 'antigravity');
  assert.equal(mem.accounts[0].quotaProvider, 'antigravity');
});

for (const [field, value] of [['upstream', 'http://127.0.0.1:18081'], ['quotaProvider', null]]) {
  test(`reloading ${field} clears the reading and discards an in-flight probe`, async () => {
    const config = { name: 'gemini', type: 'apikey', apiKey: 'ak', upstream: UPSTREAM, quotaProvider: 'antigravity' };
    const mem = { accounts: [{ ...config }] };
    const am = new AccountManager([config]);
    const reading = { ...parse([googleAccount('a@gmail.com', { weekly: remaining(0.8) })]), at: now };
    am.applyBackendQuota(0, reading);
    await syncAccountsFromDisk({ accounts: [{ ...config }] }, mem, am);
    assert.equal(am.accounts[0].quota.backend, reading, 'an unchanged binding keeps the reading');

    let finishProbe;
    const prober = new Prober(am, { backendFn: () => new Promise(resolve => { finishProbe = resolve; }) });
    const probe = prober.probeAll();
    assert.equal(prober.getStatus().accounts[0].status, 'running');
    await syncAccountsFromDisk({ accounts: [{ ...config, [field]: value }] }, mem, am);
    assert.equal(am.accounts[0].quota.backend, null, 'reload clears the old reading before the probe returns');

    finishProbe(reading);
    await probe;
    assert.equal(am.accounts[0].quota.backend, null, 'the old probe must not restore the reading');
    assert.equal(prober.getStatus().accounts[0].status, field === 'upstream' ? 'never' : 'not-applicable');
  });
}

test('endpoint is called at {upstream}/v1/account-quotas with Bearer credential', async () => {
  let seen = null;
  const body = {
    fetchedAt: iso(now),
    accounts: [{
      email: 'a@gmail.com',
      enabled: true,
      status: 'ok',
      tier: 'ultra',
      groups: [{
        id: 'gemini',
        name: 'Gemini Models',
        windows: {
          fiveHour: { remainingFraction: 0.84, resetTime: iso(SES_RESET) },
          weekly: { remainingFraction: 0.96, resetTime: iso(WK_RESET) },
        },
      }],
    }],
  };
  await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'proxy-secret' },
    { fetchImpl: async (url, opts) => { seen = { url: String(url), headers: opts.headers }; return okFetch(body)(); } },
  );
  assert.equal(seen.url, 'http://127.0.0.1:18080/v1/account-quotas');
  assert.equal(seen.headers.Authorization, 'Bearer proxy-secret');
  assert.equal(seen.headers.Accept, 'application/json');
});

test('single account parses Gemini and 3p pools and sets top-level windows and utilization', async () => {
  const body = {
    fetchedAt: iso(now),
    accounts: [{
      email: 'a@gmail.com',
      enabled: true,
      status: 'ok',
      tier: 'ultra',
      groups: [
        {
          id: 'gemini',
          name: 'Gemini Models',
          windows: {
            fiveHour: { remainingFraction: 0.84, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 0.96, resetTime: iso(WK_RESET) },
          },
        },
        {
          id: '3p',
          name: 'Claude and GPT models',
          windows: {
            fiveHour: { remainingFraction: 0.94, resetTime: iso(P3_SES_RESET) },
            weekly: { remainingFraction: 0.97, resetTime: iso(P3_WK_RESET) },
          },
        },
      ],
    }],
  };
  const r = await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' },
    { fetchImpl: okFetch(body) },
  );
  assert.equal(r.label, 'Plan');
  assert.equal(r.utilization, 0.16);
  assert.equal(r.text, '5h 16% (resets 3h22m) · week 4% (resets 6d22h)');
  assert.deepEqual(r.windows, {
    fiveHour: { utilization: 0.16, resetAt: SES_RESET },
    weekly: { utilization: 0.04, resetAt: WK_RESET },
  });
  assert.equal(r.accounts.length, 1);
  assert.deepEqual(r.accounts[0], {
    email: 'a@gmail.com',
    enabled: true,
    tier: 'ultra',
    status: 'ok',
    pools: {
      gemini: {
        fiveHour: { utilization: 0.16, resetAt: SES_RESET },
        weekly: { utilization: 0.04, resetAt: WK_RESET },
      },
      '3p': {
        fiveHour: { utilization: 0.06, resetAt: P3_SES_RESET },
        weekly: { utilization: 0.03, resetAt: P3_WK_RESET },
      },
    },
  });
  assert.ok(r.at > 0);
});

test('two usable accounts pick the best by lowest weekly, then lowest 5-hour', async () => {
  // Lower weekly wins even if 5-hour is slightly higher.
  const body1 = {
    fetchedAt: iso(now),
    accounts: [
      {
        email: 'busier-week@gmail.com',
        enabled: true,
        status: 'ok',
        tier: 'ultra',
        groups: [{
          id: 'gemini',
          windows: {
            fiveHour: { remainingFraction: 0.95, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 0.60, resetTime: iso(WK_RESET) },
          },
        }],
      },
      {
        email: 'fresher-week@gmail.com',
        enabled: true,
        status: 'ok',
        tier: 'ultra',
        groups: [{
          id: 'gemini',
          windows: {
            fiveHour: { remainingFraction: 0.70, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 0.90, resetTime: iso(WK_RESET) },
          },
        }],
      },
    ],
  };
  const r1 = await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' },
    { fetchImpl: okFetch(body1) },
  );
  assert.equal(r1.windows.weekly.utilization, 0.1);
  assert.equal(r1.windows.fiveHour.utilization, 0.3);
  assert.equal(r1.utilization, 0.3);

  // Tie on weekly breaks by lowest 5-hour.
  const body2 = {
    fetchedAt: iso(now),
    accounts: [
      {
        email: 'a@gmail.com',
        enabled: true,
        status: 'ok',
        tier: 'pro',
        groups: [{
          id: 'gemini',
          windows: {
            fiveHour: { remainingFraction: 0.50, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 0.80, resetTime: iso(WK_RESET) },
          },
        }],
      },
      {
        email: 'b@gmail.com',
        enabled: true,
        status: 'ok',
        tier: 'pro',
        groups: [{
          id: 'gemini',
          windows: {
            fiveHour: { remainingFraction: 0.90, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 0.80, resetTime: iso(WK_RESET) },
          },
        }],
      },
    ],
  };
  const r2 = await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' },
    { fetchImpl: okFetch(body2) },
  );
  assert.equal(r2.windows.weekly.utilization, 0.2);
  assert.equal(r2.windows.fiveHour.utilization, 0.1);
  assert.equal(r2.utilization, 0.2);
});

test('an account that can serve beats a lower weekly reading with exhausted five-hour quota', () => {
  const reading = parse([
    googleAccount('exhausted@gmail.com', { weekly: remaining(0.99), fiveHour: remaining(0) }),
    googleAccount('healthy@gmail.com', { weekly: remaining(0.7), fiveHour: remaining(0.6) }),
  ]);
  assert.deepEqual(reading.windows, reading.accounts[1].pools.gemini);
  assert.equal(reading.utilization, 0.4);
  assert.equal(reading.text, '5h 40% · week 30%');
});

test('a missing weekly window compares as the five-hour reading', () => {
  const reading = parse([
    googleAccount('exhausted@gmail.com', { weekly: remaining(0), fiveHour: remaining(0.95) }),
    googleAccount('higher-week@gmail.com', { weekly: remaining(0.7), fiveHour: remaining(0.98) }),
    googleAccount('no-week@gmail.com', { fiveHour: remaining(0.75) }),
  ]);
  assert.deepEqual(reading.windows, { fiveHour: { utilization: 0.25, resetAt: null } });
  assert.equal(reading.text, '5h 25%');
});

test('expired windows do not rank or appear in the top-level reading', () => {
  const reading = parse([
    googleAccount('expired@gmail.com', { weekly: remaining(0.99, now) }),
    googleAccount('live@gmail.com', { weekly: remaining(1, now), fiveHour: remaining(0) }),
  ]);
  const best = bestAntigravityAccount(reading.accounts, now);
  assert.equal(best.account.email, 'live@gmail.com');
  assert.deepEqual(best.windows, { fiveHour: { utilization: 1, resetAt: null } });
  assert.deepEqual(reading.windows, best.windows);
  assert.equal(reading.accounts[1].pools.gemini.weekly.resetAt, now, 'keep the original per-account window');
});

test('a weekly tie with no five-hour windows keeps the first account', () => {
  const reading = parse([
    googleAccount('first@gmail.com', { weekly: remaining(0.8, WK_RESET) }),
    googleAccount('second@gmail.com', { weekly: remaining(0.8) }),
  ]);
  assert.equal(bestAntigravityAccount(reading.accounts, now).account.email, 'first@gmail.com');
  assert.deepEqual(reading.windows, { weekly: { utilization: 0.2, resetAt: WK_RESET } });
});

test('disabled, invalid, and error accounts never win as best, but stay in accounts[] for the panel', async () => {
  const body = {
    fetchedAt: iso(now),
    accounts: [
      {
        email: 'off@gmail.com',
        enabled: false,
        status: 'disabled',
        tier: null,
        groups: [{
          id: 'gemini',
          windows: {
            fiveHour: { remainingFraction: 1, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 1, resetTime: iso(WK_RESET) },
          },
        }],
      },
      {
        email: 'bad@gmail.com',
        enabled: true,
        status: 'invalid',
        tier: 'pro',
        error: 'token revoked',
        groups: [],
      },
      {
        email: 'err@gmail.com',
        enabled: true,
        status: 'error',
        tier: 'ultra',
        error: 'HTTP 503',
        groups: [],
      },
      {
        email: 'live@gmail.com',
        enabled: true,
        status: 'ok',
        tier: 'ultra',
        groups: [{
          id: 'gemini',
          windows: {
            fiveHour: { remainingFraction: 0.4, resetTime: iso(SES_RESET) },
            weekly: { remainingFraction: 0.75, resetTime: iso(WK_RESET) },
          },
        }],
      },
    ],
  };
  const r = await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' },
    { fetchImpl: okFetch(body) },
  );
  assert.equal(r.windows.fiveHour.utilization, 0.6);
  assert.equal(r.windows.weekly.utilization, 0.25);
  assert.equal(r.utilization, 0.6);
  assert.equal(r.accounts.length, 4);
  assert.equal(r.accounts[0].status, 'disabled');
  assert.equal(r.accounts[0].enabled, false);
  assert.equal(r.accounts[1].status, 'invalid');
  assert.equal(r.accounts[1].error, 'token revoked');
  assert.equal(r.accounts[2].status, 'error');
  assert.equal(r.accounts[2].error, 'HTTP 503');
});

test('when all accounts are unusable, reading still populates accounts[] with null utilization and no windows', async () => {
  const body = {
    fetchedAt: iso(now),
    accounts: [
      { email: 'c@gmail.com', enabled: true, status: 'error', tier: 'ultra', error: 'HTTP 503', groups: [] },
      { email: 'b@gmail.com', enabled: false, status: 'disabled', tier: null, groups: [] },
    ],
  };
  const r = await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' },
    { fetchImpl: okFetch(body) },
  );
  assert.equal(r.label, 'Plan');
  assert.equal(r.utilization, null);
  assert.equal(r.windows, undefined);
  assert.equal(r.text, 'no usable accounts');
  assert.equal(r.accounts.length, 2);
});

test('missing windows, missing reset times, clamping, and safeLine scrubbing', async () => {
  const body = {
    fetchedAt: iso(now),
    accounts: [{
      email: 'evil\x1b[31m@gmail.com\nnewline',
      enabled: true,
      status: 'ok',
      tier: 'ultra\x1b[2J',
      error: 'err\r\n\x1b[32mboom',
      groups: [{
        id: 'gemini',
        windows: {
          fiveHour: { remainingFraction: null },
          weekly: { remainingFraction: 1.4, resetTime: null },
        },
      }],
    }],
  };
  const r = await fetchBackendQuota(
    { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' },
    { fetchImpl: okFetch(body) },
  );
  assert.equal(r.accounts[0].email.includes('\x1b'), false);
  assert.equal(r.accounts[0].email.includes('\n'), false);
  assert.equal(r.accounts[0].tier, 'ultra');
  assert.equal(r.accounts[0].error.includes('\x1b'), false);
  // Null remainingFraction is skipped rather than turning into 100% used; >1 remaining clamps to 0% used.
  assert.deepEqual(r.windows, { weekly: { utilization: 0, resetAt: null } });
  assert.equal(r.utilization, 0);
  assert.equal(r.text, 'week 0%');
});

test('only finite numbers and non-blank numeric strings make quota windows', () => {
  const badFractions = ['', '   ', [], [0.7], {}, true, Infinity, 'Infinity'];
  const reading = parse(badFractions.map((fraction, i) => googleAccount(`a${i}@gmail.com`, {
    fiveHour: remaining(fraction),
    weekly: remaining(' 0.75 '),
  })));
  for (const account of reading.accounts) {
    assert.deepEqual(account.pools.gemini, { weekly: { utilization: 0.25, resetAt: null } }, account.email);
  }
});

test('escape-only status and tier fall back to error and null after scrubbing', () => {
  const reading = parse([
    googleAccount('a@gmail.com', { weekly: remaining(1) }, { status: '\x1b[31m\x1b[2J', tier: '\x1b[1m' }),
  ]);
  assert.equal(reading.accounts[0].status, 'error');
  assert.equal(reading.accounts[0].tier, null);
  assert.equal(reading.text, 'no usable accounts');
});

test('unrecognized bodies and HTTP errors fail cleanly', async () => {
  const acct = { upstream: UPSTREAM, quotaProvider: 'antigravity', credential: 'k' };
  assert.deepEqual(await fetchBackendQuota(acct, { fetchImpl: okFetch({}) }), { error: 'unrecognized response' });
  assert.deepEqual(await fetchBackendQuota(acct, { fetchImpl: okFetch({ accounts: 'nope' }) }), { error: 'unrecognized response' });
  assert.deepEqual(await fetchBackendQuota(acct, { fetchImpl: okFetch({ accounts: [{ nope: 1 }] }) }), { error: 'unrecognized response' });
  assert.deepEqual(await fetchBackendQuota(acct, { fetchImpl: okFetch({ accounts: [] }) }), { error: 'unrecognized response' });
  assert.deepEqual(await fetchBackendQuota(acct, { fetchImpl: okFetch({}, 503) }), { error: 'HTTP 503' });
});

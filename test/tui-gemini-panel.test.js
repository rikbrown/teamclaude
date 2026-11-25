import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { fleetAggregate, routeHeadroom } from '../src/quota-summary.js';
import { TUI } from '../src/tui.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const UPSTREAM = 'http://127.0.0.1:18080';

function oauth(name, over = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, ...over };
}

function geminiAccount(over = {}) {
  return {
    name: 'gemini',
    type: 'apikey',
    apiKey: 'gk',
    upstream: UPSTREAM,
    quotaProvider: 'antigravity',
    ...over,
  };
}

function sampleReading(now = Date.now()) {
  const sesReset = now + 3 * HOUR + 22 * 60_000;
  const wkReset = now + 6 * DAY + 22 * HOUR;
  const p3SesReset = now + 4 * HOUR + 43 * 60_000;
  const p3WkReset = now + 6 * DAY + 23 * HOUR;
  return {
    label: 'Plan',
    text: '5h 16% (resets 3h22m) · week 4% (resets 6d22h)',
    utilization: 0.16,
    at: now,
    windows: {
      fiveHour: { utilization: 0.16, resetAt: sesReset },
      weekly: { utilization: 0.04, resetAt: wkReset },
    },
    accounts: [
      {
        email: 'a@gmail.com',
        enabled: true,
        tier: 'ultra',
        status: 'ok',
        pools: {
          gemini: {
            fiveHour: { utilization: 0.16, resetAt: sesReset },
            weekly: { utilization: 0.04, resetAt: wkReset },
          },
          '3p': {
            fiveHour: { utilization: 0.06, resetAt: p3SesReset },
            weekly: { utilization: 0.03, resetAt: p3WkReset },
          },
        },
      },
      {
        email: 'b@gmail.com',
        enabled: true,
        tier: 'ultra',
        status: 'ok',
        pools: {
          gemini: {
            fiveHour: { utilization: 0, resetAt: null },
            weekly: { utilization: 0, resetAt: null },
          },
        },
      },
      {
        email: 'c@gmail.com',
        enabled: true,
        tier: 'ultra',
        status: 'error',
        error: 'HTTP 503',
        pools: {},
      },
    ],
  };
}

function tuiFor(am, routes = []) {
  const origGetRoutes = am.getRoutes?.bind(am);
  if (routes.length) {
    am.getRoutes = () => routes;
  } else if (!origGetRoutes) {
    am.getRoutes = () => [];
  }
  return new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: [] },
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
    probeQuota: () => {},
  });
}

function makeRoute(name, accountNames, color = 'cyan') {
  return {
    name,
    match: [`*${name}*`],
    color,
    accounts: accountNames.map(n => ({ name: n })),
  };
}

test('before the first reading, or without quotaProvider, display is unchanged (conduit + no counted seat)', () => {
  const now = Date.now();
  const routes = [makeRoute('gemini', ['gemini'])];

  // With quotaProvider but before first reading: no Gemini panel, conduit ok, route uncounted.
  const am1 = new AccountManager([
    oauth('claude@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    geminiAccount(),
  ]);
  const tui1 = tuiFor(am1, routes);
  const acctLines1 = tui1._accountLines(160).map(strip);
  assert.ok(!acctLines1.some(l => l.includes('Gemini')), 'no Gemini panel before first reading');
  const conduit1 = tui1._conduitLines().map(strip).join('\n');
  assert.match(conduit1, /⚙ gemini → 127\.0\.0\.1:18080\s+ok/);
  const routeLines1 = tui1._routeLines(50, routes, () => 0.98, now).map(strip);
  assert.ok(routeLines1.some(l => l.includes('gemini') && l.includes('no counted seat')));

  // Without quotaProvider even if quota.backend happens to exist: stays unchanged.
  const am2 = new AccountManager([
    oauth('claude@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    geminiAccount({ quotaProvider: undefined }),
  ]);
  am2.applyBackendQuota(1, sampleReading(now));
  const tui2 = tuiFor(am2, routes);
  assert.ok(!tui2._accountLines(160).map(strip).some(l => l.includes('Gemini')));
  const routeLines2 = tui2._routeLines(50, routes, () => 0.98, now).map(strip);
  assert.ok(routeLines2.some(l => l.includes('gemini') && l.includes('no counted seat')));
});

test('Gemini panel renders each Google account, dimmed 3p pool, dash for missing reset, and errors', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('claude@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    geminiAccount(),
  ]);
  am.accounts[0].quota.unified5h = 0.25;
  am.accounts[0].quota.unified5hReset = now + 2 * HOUR;
  am.accounts[0].quota.unified7d = 0.4;
  am.accounts[0].quota.unified7dReset = now + 4 * DAY;
  am.applyBackendQuota(1, sampleReading(now));

  const tui = tuiFor(am);
  const rawLines = tui._accountLines(160);
  const plain = rawLines.map(strip);
  const joined = plain.join('\n');

  // Anthropic and Gemini sit side-by-side behind the pane gutter.
  assert.match(plain[0], /Anthropic.*│\s+Gemini/);
  assert.match(joined, /│\s+► a@gmail\.com\s+ultra\s+Ses\s+16% · 3h22m\s+Wk\s+4% · 6d22h/);
  assert.match(joined, /│\s+Claude\+GPT pool\s+Ses\s+6% · 4h43m\s+Wk\s+3% · 6d23h/);
  assert.match(joined, /│\s+► b@gmail\.com\s+ultra\s+Ses\s+0% · –\s+Wk\s+0% · –/);
  assert.match(joined, /│\s+c@gmail\.com\s+error\s+HTTP 503/);

  // The Claude+GPT pool line is dimmed, and error status is painted red.
  const line3p = rawLines.find(l => strip(l).includes('Claude+GPT pool'));
  assert.ok(line3p.includes('\x1b[2m'), 'Claude+GPT pool row should be dimmed');
  const errLine = rawLines.find(l => strip(l).includes('c@gmail.com'));
  assert.ok(errLine.includes('\x1b[31merror'), 'error status should be red');
});

test('Gemini panel never overflows column budget across Anthropic+Codex+Gemini and narrow widths', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('claude@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('gpt@example.com', { provider: 'codex', accountId: 'acct-1' }),
    geminiAccount(),
  ]);
  am.applyBackendQuota(2, sampleReading(now));
  const tui = tuiFor(am);

  for (const width of [60, 100, 140, 190, 260]) {
    const lines = tui._accountLines(width).map(strip);
    assert.ok(lines.some(l => l.includes('Gemini')), `Gemini heading present at width ${width}`);
    assert.ok(lines.some(l => l.includes('a@gmail.com')), `account row present at width ${width}`);
    for (const l of lines) {
      assert.ok(l.length <= width, `width ${width}: line exceeded budget (${l.length}): ${l}`);
    }
  }

  // Mid-width stacks Gemini under Codex in the right pane; ultrawide puts all three side by side.
  const mid = tui._accountLines(170).map(strip);
  assert.match(mid[0], /Anthropic.*│\s+Codex/);
  assert.ok(mid.slice(1).some(l => /│\s+Gemini/.test(l)), 'mid-width stacks Gemini under Codex behind the gutter');

  const wide = tui._accountLines(260).map(strip);
  assert.match(wide[0], /Anthropic.*│\s+Codex.*│\s+Gemini/, 'ultrawide renders all three panes side by side');
});

test('routeHeadroom and Routes panel count usable Google accounts and report binding window without entering fleetAggregate', () => {
  const now = Date.now();
  const wkReset = now + 6 * DAY + 22 * HOUR;
  const sesReset = now + 3 * HOUR + 22 * 60_000;
  const routes = [makeRoute('gemini', ['gemini'])];

  // One usable Google account where weekly (4%) binds over 5h (0%).
  const am1 = new AccountManager([geminiAccount()]);
  am1.applyBackendQuota(0, {
    label: 'Plan',
    text: '5h 0% · week 4% (resets 6d22h)',
    utilization: 0.04,
    at: now,
    windows: {
      fiveHour: { utilization: 0, resetAt: null },
      weekly: { utilization: 0.04, resetAt: wkReset },
    },
    accounts: [{
      email: 'a@gmail.com',
      enabled: true,
      tier: 'ultra',
      status: 'ok',
      pools: { gemini: { fiveHour: { utilization: 0, resetAt: null }, weekly: { utilization: 0.04, resetAt: wkReset } } },
    }],
  });

  // Never enters fleetAggregate (local backend stays out of Anthropic pool).
  assert.deepEqual(fleetAggregate(am1.accounts, { now }), []);

  const [entry1] = routeHeadroom(am1.accounts, routes, { thresholdFor: () => 0.98, now });
  assert.equal(entry1.counted, 1);
  assert.equal(entry1.bucket, 'unified7d');
  assert.equal(entry1.value.utilization, 0.04);
  assert.equal(entry1.value.nextResetAt, wkReset);

  const tui1 = tuiFor(am1, routes);
  const routeLine1 = tui1._routeLines(50, routes, () => 0.98, now).map(strip).find(l => l.includes('gemini'));
  assert.match(routeLine1, /gemini\s+Wk\s+4%\s+6d22h\s+1 seat/);

  // Two usable Google accounts + one error account -> 2 seats, binding 5h (16% > 4%).
  am1.applyBackendQuota(0, sampleReading(now));
  const [entry2] = routeHeadroom(am1.accounts, routes, { thresholdFor: () => 0.98, now });
  assert.equal(entry2.counted, 2);
  assert.equal(entry2.bucket, 'unified5h');
  assert.equal(entry2.value.utilization, 0.16);
  const routeLine2 = tui1._routeLines(50, routes, () => 0.98, now).map(strip).find(l => l.includes('gemini'));
  assert.match(routeLine2, /gemini\s+Ses\s+16%\s+3h22m\s+2 seats/);

  // Zero usable Google accounts (all disabled/error) -> no counted seat.
  am1.applyBackendQuota(0, {
    label: 'Plan',
    text: 'no usable accounts',
    utilization: null,
    at: now,
    accounts: [
      { email: 'c@gmail.com', enabled: true, tier: 'ultra', status: 'error', error: 'HTTP 503', pools: {} },
    ],
  });
  const [entry0] = routeHeadroom(am1.accounts, routes, { thresholdFor: () => 0.98, now });
  assert.equal(entry0.counted, 0);
  assert.equal(entry0.value, null);
  const routeLine0 = tui1._routeLines(50, routes, () => 0.98, now).map(strip).find(l => l.includes('gemini'));
  assert.match(routeLine0, /gemini\s+no counted seat/);

  // Expired window is ignored rather than reporting stale utilization.
  am1.applyBackendQuota(0, {
    label: 'Plan',
    text: '5h 80%',
    utilization: 0.8,
    at: now - 6 * HOUR,
    windows: { fiveHour: { utilization: 0.8, resetAt: now - 1000 } },
    accounts: [{
      email: 'a@gmail.com',
      enabled: true,
      tier: 'ultra',
      status: 'ok',
      pools: { gemini: { fiveHour: { utilization: 0.8, resetAt: now - 1000 } } },
    }],
  });
  const [entryExpired] = routeHeadroom(am1.accounts, routes, { thresholdFor: () => 0.98, now });
  assert.equal(entryExpired.counted, 1);
  assert.equal(entryExpired.value, null);
  const routeLineExpired = tui1._routeLines(50, routes, () => 0.98, now).map(strip).find(l => l.includes('gemini'));
  assert.match(routeLineExpired, /gemini\s+no quota yet/);
  assert.ok(sesReset > now);
});

test('attach mode carries quotaProvider and scrubs quota.backend.accounts off the wire', () => {
  const now = Date.now();
  const am = new AccountManager([geminiAccount()]);
  am.applyBackendQuota(0, sampleReading(now));
  const status = am.getStatus();
  // Inject a hostile escape sequence on the wire to verify RemoteAccountManager scrubs it.
  status.accounts[0].quota.backend.accounts[2].error = 'HTTP 503\x1b[31m\nbad';

  const remote = new RemoteAccountManager();
  remote.applyStatus(status);
  assert.equal(remote.accounts[0].quotaProvider, 'antigravity');
  assert.equal(remote.accounts[0].quota.backend.accounts[2].error.includes('\x1b'), false);

  const tui = tuiFor(remote, [makeRoute('gemini', ['gemini'])]);
  const panel = tui._accountLines(80).map(strip).join('\n');
  assert.match(panel, /Gemini/);
  assert.match(panel, /a@gmail\.com/);
  assert.match(panel, /Claude\+GPT pool/);
});

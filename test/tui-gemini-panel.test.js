import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { providerFor } from '../src/backend-quota.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { fleetAggregate, routeHeadroom } from '../src/quota-summary.js';
import { allocatePaneWidths, TUI } from '../src/tui.js';

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

function googleAccount(email, windows, over = {}) {
  return { email, enabled: true, tier: 'ultra', status: 'ok', groups: [{ id: 'gemini', windows }], ...over };
}

function wireWindow(utilization, resetAt = null) {
  return { remainingFraction: 1 - utilization, resetTime: resetAt == null ? null : new Date(resetAt).toISOString() };
}

function parseReading(now, accounts) {
  const reading = providerFor(UPSTREAM, 'antigravity').parse({ accounts });
  assert.ok(reading);
  return { ...reading, at: now };
}

function sampleReading(now = Date.now()) {
  return parseReading(now, [
    googleAccount('a@gmail.com', null, {
      groups: [
        { id: 'gemini', windows: {
          fiveHour: wireWindow(0.16, now + 3 * HOUR + 22 * 60_000),
          weekly: wireWindow(0.04, now + 6 * DAY + 22 * HOUR),
        } },
        { id: '3p', windows: {
          fiveHour: wireWindow(0.06, now + 4 * HOUR + 43 * 60_000),
          weekly: wireWindow(0.03, now + 6 * DAY + 23 * HOUR),
        } },
      ],
    }),
    googleAccount('b@gmail.com', { fiveHour: wireWindow(0), weekly: wireWindow(0) }),
    googleAccount('c@gmail.com', null, { status: 'error', error: 'HTTP 503' }),
  ]);
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
  assert.match(line3p, /\x1b\[2mClaude\+GPT pool *\x1b\[0m/);
  assert.match(line3p, /\x1b\[2mSes +6% · 4h43m *\x1b\[0m +\x1b\[2mWk +3% · 6d23h\x1b\[0m/);
  const errLine = rawLines.find(l => strip(l).includes('c@gmail.com'));
  assert.ok(errLine.includes('\x1b[31merror'), 'error status should be red');
});

test('Gemini shows both disabled and invalid status tags in full', () => {
  const am = new AccountManager([geminiAccount()]);
  am.applyBackendQuota(0, parseReading(Date.now(), [
    googleAccount('good@gmail.com', { weekly: wireWindow(0.04) }, { tier: 'pro' }),
    googleAccount('off@gmail.com', null, { status: 'disabled', enabled: true }),
    googleAccount('bad@gmail.com', null, { status: 'invalid', error: 'token revoked' }),
  ]));
  const lines = tuiFor(am)._accountLines(80).map(strip).join('\n');
  assert.match(lines, /off@gmail\.com +disabled\b/);
  assert.match(lines, /bad@gmail\.com +invalid +token revoked/);
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

test('pane widths stay within their stage limits from 150 to 260 columns', () => {
  const stages = [[60, 67, 95], [55, 62, 95], [50, 50, 55]];
  // One spare column, tied between the first two panes; the third cannot grow yet.
  assert.deepEqual(allocatePaneWidths(stages, 166), [61, 55, 50]);
  // More room starts the next stage. The pane with the largest remainder wins it.
  assert.deepEqual(allocatePaneWidths(stages, 180), [67, 63, 50]);
  for (let width = 150; width <= 260; width++) {
    const widths = allocatePaneWidths(stages, width);
    if (width < 165) {
      assert.equal(widths, null);
      continue;
    }
    assert.equal(widths.reduce((sum, w) => sum + w, 0), Math.min(width, 245));
    const stage = width < 179 ? 1 : 2;
    for (let i = 0; i < stages.length; i++) {
      const [floor, ceiling] = [stages[i][stage - 1], stages[i][stage]];
      assert.ok(widths[i] >= floor && widths[i] <= ceiling, `pane ${i} at ${width}: ${widths[i]} not in [${floor}, ${ceiling}]`);
    }
  }
});

test('routeHeadroom and Routes panel count usable Google accounts and report their binding window', () => {
  const now = Date.now();
  const wkReset = now + 6 * DAY + 22 * HOUR;
  const sesReset = now + 3 * HOUR + 22 * 60_000;
  const routes = [makeRoute('gemini', ['gemini'])];
  const am = new AccountManager([geminiAccount()]);
  const tui = tuiFor(am, routes);
  const readRoute = () => routeHeadroom(am.accounts, routes, { thresholdFor: () => 0.98, now })[0];
  const renderRoute = () => tui._routeLines(50, routes, () => 0.98, now).map(strip).find(l => l.includes('gemini'));
  const notUsable = googleAccount('c@gmail.com', null, { status: 'error', error: 'HTTP 503' });

  am.applyBackendQuota(0, parseReading(now, [
    googleAccount('a@gmail.com', { fiveHour: wireWindow(0), weekly: wireWindow(0.04, wkReset) }),
  ]));
  assert.deepEqual(fleetAggregate(am.accounts, { now }), []);
  const weekly = readRoute();
  assert.equal(weekly.counted, 1);
  assert.equal(weekly.bucket, 'unified7d');
  assert.equal(weekly.value.utilization, 0.04);
  assert.equal(weekly.value.nextResetAt, wkReset);
  assert.match(renderRoute(), /gemini\s+Wk\s+4%\s+6d22h\s+1 seat/);

  am.applyBackendQuota(0, parseReading(now, [
    googleAccount('a@gmail.com', { fiveHour: wireWindow(0.16, sesReset), weekly: wireWindow(0.04, wkReset) }),
    googleAccount('b@gmail.com', { fiveHour: wireWindow(0.1), weekly: wireWindow(0.12) }),
    notUsable,
  ]));
  const session = readRoute();
  assert.equal(session.counted, 2);
  assert.equal(session.total, 3);
  assert.equal(session.bucket, 'unified5h');
  assert.equal(session.value.utilization, 0.16);
  assert.match(renderRoute(), /gemini\s+Ses\s+16%\s+3h22m\s+2 seats/);

  am.applyBackendQuota(0, parseReading(now, [notUsable]));
  const empty = readRoute();
  assert.equal(empty.counted, 0);
  assert.equal(empty.value, null);
  assert.match(renderRoute(), /gemini\s+no counted seat/);
});

test('Routes takes both windows from the same Google account across two proxies', () => {
  const now = Date.now();
  const reset = now + HOUR;
  const am = new AccountManager([geminiAccount(), geminiAccount({ name: 'gemini-b' })]);
  const routes = [makeRoute('gemini', ['gemini', 'gemini-b'])];
  am.applyBackendQuota(0, parseReading(now, [
    googleAccount('a@gmail.com', { fiveHour: wireWindow(0.8, reset), weekly: wireWindow(0.1) }),
  ]));
  am.applyBackendQuota(1, parseReading(now, [
    googleAccount('b@gmail.com', { fiveHour: wireWindow(0.05), weekly: wireWindow(0.25) }),
  ]));

  const [route] = routeHeadroom(am.accounts, routes, { now });
  assert.equal(route.counted, 2);
  assert.equal(route.bucket, 'unified5h');
  assert.equal(route.value.utilization, 0.8);
  assert.equal(route.value.nextResetAt, reset);
});

test('Routes reselects a seat when the best stored window expires', () => {
  const now = Date.now();
  const expires = now + HOUR;
  const liveReset = now + DAY;
  const am = new AccountManager([geminiAccount()]);
  const routes = [makeRoute('gemini', ['gemini'])];
  const first = googleAccount('a@gmail.com', { fiveHour: wireWindow(0.1, expires) });
  const second = googleAccount('b@gmail.com', { weekly: wireWindow(0.4, liveReset) });
  const reading = parseReading(now, [first, second]);
  assert.equal(reading.windows.fiveHour.resetAt, expires);
  am.applyBackendQuota(0, reading);

  const [route] = routeHeadroom(am.accounts, routes, { now: expires });
  assert.equal(route.counted, 2);
  assert.equal(route.bucket, 'unified7d');
  assert.equal(route.value.utilization, 0.4);
  assert.equal(route.value.nextResetAt, liveReset);

  am.applyBackendQuota(0, parseReading(now, [first]));
  const expiredLine = tuiFor(am, routes)._routeLines(50, routes, () => 0.98, expires).map(strip).find(l => l.includes('gemini'));
  assert.match(expiredLine, /gemini\s+no quota yet/);
});

test('disabled TeamClaude proxies do not display their Google accounts', () => {
  const am = new AccountManager([geminiAccount(), geminiAccount({ name: 'gemini-off', disabled: true })]);
  const now = Date.now();
  am.applyBackendQuota(0, parseReading(now, [googleAccount('live@gmail.com', { weekly: wireWindow(0.2) })]));
  am.applyBackendQuota(1, parseReading(now, [googleAccount('off@gmail.com', { weekly: wireWindow(0) })]));
  const lines = tuiFor(am)._accountLines(80).map(strip).join('\n');
  assert.match(lines, /live@gmail\.com/);
  assert.doesNotMatch(lines, /off@gmail\.com/);
});

test('remote antigravity proxies show Google quota, not an Anthropic row or seat', () => {
  const am = new AccountManager([
    oauth('claude@example.com', { rateLimitTier: 'default_claude_max_20x' }),
    geminiAccount({ name: 'remote-proxy', upstream: 'https://proxy.example.test' }),
  ]);
  const now = Date.now();
  am.applyBackendQuota(1, parseReading(now, [googleAccount('a@gmail.com', { weekly: wireWindow(0.2) })]));
  const lines = tuiFor(am)._accountLines(160).map(strip).join('\n');
  assert.match(lines, /Anthropic.*│\s+Gemini/);
  assert.match(lines, /claude@example\.com.*│\s+► a@gmail\.com/);
  assert.doesNotMatch(lines, /remote-proxy/);
  assert.deepEqual(fleetAggregate(am.accounts, { now }).map(a => [a.provider, a.total, a.counted]), [['anthropic', 1, 1]]);
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

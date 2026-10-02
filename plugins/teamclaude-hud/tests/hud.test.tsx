import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const HOUR = 60 * 60 * 1000
const TIER = { rateLimitTier: 'default_claude_max_20x', seatTier: null, weight: 20 }
const NO_TIER = { rateLimitTier: null, seatTier: null, weight: null }

const weekly = (utilization: number | null, hours: number | null) => ({
  utilization,
  resetAt: hours === null ? null : NOW + hours * HOUR,
  source: 'unified7d',
})

// In the proxy's own order, which is not the order the pane draws.
const QUOTA = {
  accounts: [
    {
      name: 'claude@example.com',
      disabled: false,
      status: 'active',
      tier: TIER,
      buckets: {
        fiveHour: { utilization: 0.28, resetAt: NOW + 2 * HOUR, source: 'unified5h' },
        weeklyShared: weekly(0.94, 50),
        weeklyFable: { utilization: 0.74, resetAt: NOW + 50 * HOUR, source: 'unified7dFable' },
      },
    },
    {
      name: 'codex:rik@example.com',
      disabled: false,
      status: 'throttled',
      tier: NO_TIER,
      buckets: {
        fiveHour: { utilization: null, resetAt: null, source: 'unified5h' },
        weeklyShared: weekly(0.04, 3),
        weeklyFable: { utilization: 0.04, resetAt: NOW + 3 * HOUR, source: 'unified7d' },
      },
    },
    {
      name: 'spent@example.com',
      disabled: false,
      status: 'active',
      tier: TIER,
      buckets: { fiveHour: { utilization: 0, resetAt: null }, weeklyShared: weekly(1, 17) },
    },
    {
      name: 'fresh@example.com',
      disabled: false,
      status: 'active',
      tier: TIER,
      buckets: { fiveHour: { utilization: 0.1, resetAt: null }, weeklyShared: weekly(0.21, 145) },
    },
    {
      // Its week reset an hour ago and has not been read since: it goes last.
      name: 'lapsed@example.com',
      disabled: false,
      status: 'active',
      tier: TIER,
      buckets: { fiveHour: { utilization: 0, resetAt: null }, weeklyShared: weekly(0.5, -1) },
    },
    // A local backend: no readings, so no row.
    { name: 'codex', disabled: false, status: 'active', tier: NO_TIER, buckets: { fiveHour: null } },
  ],
  aggregate: {
    fiveHour: { utilization: 0.129, nextResetAt: NOW + HOUR, knownAccounts: 10 },
    weeklyShared: { utilization: 0.739, nextResetAt: NOW + 30 * HOUR, knownAccounts: 10 },
    weeklyFable: { utilization: 0.5, nextResetAt: NOW + 30 * HOUR, knownAccounts: 10 },
  },
}

const footer = (columns: number, modes: string[] = []) =>
  ({
    plugin: 'teamclaude-hud',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes },
    viewport: { columns, rows: 40 },
  }) as const

const pane = (bodyColumns: number) =>
  ({
    plugin: 'teamclaude-hud',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'teamclaude',
    props: { bodyColumns },
  }) as never

type Fetched = { url: string; headers: Record<string, string> }
type Drawing = {
  findAll: (q: { type: string; in?: string }) => Promise<{ text: string; props: Record<string, unknown> }[]>
}

// Each Text's own text holds its nested Text's too, so the drawing's top-level
// Texts are the ones no earlier Text already holds. `scope` reads what the
// readout Client drew instead of the plugin's own tree.
async function shown(ui: Drawing, scope?: string): Promise<string[]> {
  const top: string[] = []
  for (const { text } of await ui.findAll({ type: 'Text', ...(scope ? { in: scope } : {}) })) {
    if (!top.some(outer => outer.includes(text))) {
      top.push(text)
    }
  }

  return top
}

const BASE_URL_ENV = {
  ANTHROPIC_BASE_URL: 'http://proxy:3456/',
  ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: tc-secret',
}

// The engine beneath the mod: a proxy answering `reply`, and every other call
// the mod makes on the way.
function world(
  on: On,
  reply: { status: number; text: string },
  env: Record<string, string> = BASE_URL_ENV,
) {
  const fetched: Fetched[] = []
  const panes = new Set<string>()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, env)
  on('http.fetch', (_$, e) => {
    fetched.push({ url: e.url, headers: { ...(e.init?.headers ?? {}) } })

    return { value: { ...reply, ok: reply.status >= 200 && reply.status < 300, headers: {} } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  // The engine's own mode labels, as the footer draws them.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return e.props.modes.length ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : <></>
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return { fetched, clock, panes }
}

const start = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

// Starts the session and lets the first poll land: it runs beside session
// start, never holding it up.
async function started(
  $: { session: { start: (e: typeof start) => Promise<unknown> } },
  clock: { advance: (ms: number) => Promise<void> },
) {
  await $.session.start(start)
  await clock.advance(0)
}

const run = (args: string) =>
  ({
    command: 'teamclaude',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as const

const READOUT = ' 5h ▰▱▱▱▱ 13%  7d ▰▰▰▰▱ 74%  F7 ▰▰▰▱▱ 50%'

test('the footer reads out the fleet from the proxy, with the proxy key', async ($, on) => {
  const { fetched, clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  expect(fetched).toEqual([
    { url: 'http://proxy:3456/teamclaude/quota', headers: { 'x-api-key': 'tc-secret' } },
  ])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...footer(140), surface })
    expect(await shown(ui, 'readout')).toEqual([READOUT])
    expect((await ui.find({ type: 'Button', key: 'pane' }))?.props).toMatchObject({
      label: '◧ TC',
      action: 'app:cycleDiffBase',
    })
    await ui.unmount()
  }
})

test("a pinned session's base URL reaches the control plane at its origin", async ($, on) => {
  const { fetched, clock } = world(
    on,
    { status: 200, text: JSON.stringify(QUOTA) },
    { ANTHROPIC_BASE_URL: 'http://localhost:3456/tc-acct/rik%40example.com' },
  )
  await started($, clock)

  expect(fetched).toEqual([{ url: 'http://localhost:3456/teamclaude/quota', headers: {} }])
})

test('MITM mode finds the proxy through a loopback HTTPS_PROXY', async ($, on) => {
  const { fetched, clock } = world(
    on,
    { status: 200, text: JSON.stringify(QUOTA) },
    { HTTPS_PROXY: 'http://rik%40example.com:tc-key@127.0.0.1:3456' },
  )
  await started($, clock)

  expect(fetched.map(one => one.url)).toEqual(['http://127.0.0.1:3456/teamclaude/quota'])
  const ui = await $.ui.mount(footer(140))
  expect(await shown(ui, 'readout')).toEqual([READOUT])
})

test('an HTTPS_PROXY on another machine is never asked', async ($, on) => {
  const { fetched, clock } = world(
    on,
    { status: 200, text: JSON.stringify(QUOTA) },
    { HTTPS_PROXY: 'http://proxy.corp.example:8080', ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: tc-secret' },
  )
  await started($, clock)

  expect(fetched).toEqual([])
  const ui = await $.ui.mount(footer(140, ['focus']))
  expect(await shown(ui)).toEqual(['focus'])
})

test('a narrow footer drops the bars and keeps the figures', async ($, on) => {
  const { clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  const ui = await $.ui.mount(footer(80))
  expect(await shown(ui, 'readout')).toEqual([' 5h 13%  7d 74%  F7 50%'])
})

test("the footer keeps the engine's mode labels in front", async ($, on) => {
  const { clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  const ui = await $.ui.mount(footer(140, ['focus', 'memory paused']))
  expect(await shown(ui)).toEqual(['focus & memory paused'])
  expect(await shown(ui, 'readout')).toEqual([READOUT])
})

test('the footer polls again each period', async ($, on) => {
  const { fetched, clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)
  await clock.advance(5000)
  await clock.advance(5000)

  expect(fetched).toHaveLength(3)
})

test('a base URL that is not TeamClaude draws nothing and stops the poll', async ($, on) => {
  const { fetched, clock } = world(on, { status: 404, text: 'not found' })
  await started($, clock)
  await clock.advance(15000)

  expect(fetched).toHaveLength(1)
  const ui = await $.ui.mount(footer(140, ['focus']))
  expect(await shown(ui)).toEqual(['focus'])
  expect(await ui.find({ type: 'Button', key: 'pane' })).toBeUndefined()
})

test('a refused key reads offline and keeps polling', async ($, on) => {
  const { fetched, clock } = world(on, { status: 401, text: '{}' })
  await started($, clock)
  await clock.advance(5000)

  expect(fetched).toHaveLength(2)
  const footerUi = await $.ui.mount(footer(140))
  expect(await shown(footerUi, 'readout')).toEqual([' offline'])
  await footerUi.unmount()

  await $.command.run(run(''))
  const paneUi = await $.ui.mount(pane(100))
  expect(await paneUi.find({ type: 'Text', text: /refused the key/ })).toBeDefined()
})

test('/teamclaude toggle hides the readout, and again shows it', async ($, on) => {
  const { clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  expect((await $.command.run(run('toggle'))).text).toBe('TeamClaude readout hidden.')
  const hidden = await $.ui.mount(footer(140, ['focus']))
  expect(await shown(hidden)).toEqual(['focus'])
  expect(await hidden.find({ type: 'Button', key: 'pane' })).toBeUndefined()
  await hidden.unmount()

  expect((await $.command.run(run('toggle'))).text).toBe('TeamClaude readout shown.')
  const visible = await $.ui.mount(footer(140, ['focus']))
  expect(await shown(visible, 'readout')).toEqual([READOUT])
})

test('the footer button opens the pane, and again closes it', async ($, on) => {
  const { clock, panes } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)
  const ui = await $.ui.mount(footer(140))

  await ui.press({ key: 'pane' })
  expect([...panes]).toEqual(['teamclaude'])
  await ui.press({ key: 'pane' })
  expect([...panes]).toEqual([])
})

test('a click anywhere on the readout opens the pane, and again closes it', async ($, on) => {
  const { clock, panes } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)
  const ui = await $.ui.mount(footer(140))

  await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 'readout' })
  expect([...panes]).toEqual(['teamclaude'])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'readout' })
  expect([...panes]).toEqual([])
})

test('the readout underlines under the pointer', async ($, on) => {
  const { clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)
  const ui = await $.ui.mount(footer(140))
  const underlined = async () =>
    (await ui.findAll({ type: 'Text', in: 'readout' })).filter(found => found.props.underline === true)

  expect(await underlined()).toHaveLength(0)
  await ui.pointer({ type: 'enter', x: 4, y: 0, in: 'readout' })
  expect((await underlined()).length).toBeGreaterThan(0)
  await ui.pointer({ type: 'leave', x: 4, y: 0, in: 'readout' })
  expect(await underlined()).toHaveLength(0)
})

test('/teamclaude opens the pane, and again closes it', async ($, on) => {
  const { clock, panes } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  expect((await $.command.run(run(''))).text).toBe('TeamClaude pane opened.')
  expect([...panes]).toEqual(['teamclaude'])
  expect((await $.command.run(run(''))).text).toBe('TeamClaude pane closed.')
  expect([...panes]).toEqual([])
})

test('the pane sorts the seats as TeamClaude does by weekly reset, Codex after', async ($, on) => {
  const { clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  const ui = await $.ui.mount(pane(120))
  const names = (await shown(ui)).map(row => row.split(' ')[0] ?? '').filter(name => name.includes('@'))
  expect(names).toEqual([
    'spent@example.com',
    'claude@example.com',
    'fresh@example.com',
    'lapsed@example.com',
    'codex:rik@example.com',
  ])
})

test('the pane draws a row a seat, padded, and leaves out a backend with no readings', async ($, on) => {
  const { clock } = world(on, { status: 200, text: JSON.stringify(QUOTA) })
  await started($, clock)

  for (const bodyColumns of [120, 44]) {
    const ui = await $.ui.mount(pane(bodyColumns))
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { paddingX: 2, paddingY: 1 } })
    expect(await ui.find({ type: 'Text', text: /claude@example\.com/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /throttled/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^codex$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Updated 0s ago/ })).toBeDefined()
    await ui.unmount()
  }
})

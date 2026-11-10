import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunResult, HttpInit, On } from 'claude-code'

const SESSION_ID = '8be0cb76-7b43-4d69-bb4b-d37b35a49715'
const ENV = {
  ANTHROPIC_BASE_URL: 'https://proxy.example.test:3456/tc-acct/seat',
  ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: tc-secret\r\nX-Client: laptop',
}
const RESULT: CommandRunResult = {
  text: 'Session renamed to foo',
  context: ['The command left this note.'],
  ref: 12,
}

const rename = (args: string) => ({
  command: 'rename',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
}) as const

function world(on: On, env: Record<string, string> = ENV) {
  const fetched: { url: string; init?: HttpInit }[] = []
  const clock = mock.clock(on)
  mock.env(on, env)
  on('session.id', () => ({ value: SESSION_ID }))

  return { fetched, clock }
}

test('/rename sends the trimmed name after the command, using the HUD proxy and key', async ($, on) => {
  const { fetched, clock } = world(on)
  const order: string[] = []
  on('command.run', { command: 'rename' }, (_$, e) => {
    expect(e.args).toBe('  foo  ')
    order.push('rename')

    return RESULT
  })
  on('http.fetch', (_$, e) => {
    order.push('POST')
    fetched.push(e)

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })

  expect(await $.command.run(rename('  foo  '))).toEqual(RESULT)
  await clock.advance(0)

  expect(order).toEqual(['rename', 'POST'])
  expect(fetched).toEqual([{
    url: 'https://proxy.example.test:3456/teamclaude/session-title',
    init: {
      method: 'POST',
      headers: {
        'x-api-key': 'tc-secret',
        'X-Client': 'laptop',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: SESSION_ID, session_title: 'foo' }),
    },
  }])
})

test('/rename also finds a loopback MITM proxy through lowercase https_proxy', async ($, on) => {
  const { fetched, clock } = world(on, { https_proxy: 'http://127.0.0.1:3456' })
  on('command.run', { command: 'rename' }, () => RESULT)
  on('http.fetch', (_$, e) => {
    fetched.push(e)

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })

  expect(await $.command.run(rename('foo'))).toEqual(RESULT)
  await clock.advance(0)

  expect(fetched).toHaveLength(1)
  expect(fetched[0]).toMatchObject({
    url: 'http://127.0.0.1:3456/teamclaude/session-title',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  })
})

for (const [setup, env] of [
  ['no proxy configured', {}],
  ['a corporate HTTPS_PROXY', { HTTPS_PROXY: 'http://proxy.corp.example:8080' }],
] as const) {
  test(`/rename keeps its result without a POST with ${setup}`, async ($, on) => {
    const { fetched, clock } = world(on, env)
    on('command.run', { command: 'rename' }, () => RESULT)
    on('http.fetch', (_$, e) => {
      fetched.push(e)

      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })

    expect(await $.command.run(rename('foo'))).toEqual(RESULT)
    await clock.advance(0)

    expect(fetched).toEqual([])
  })
}

test('/rename with no name keeps the generated command result without guessing a title', async ($, on) => {
  const { fetched, clock } = world(on)
  on('command.run', { command: 'rename' }, () => RESULT)
  on('http.fetch', (_$, e) => {
    fetched.push(e)

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })

  expect(await $.command.run(rename('   '))).toEqual(RESULT)
  await clock.advance(0)

  expect(fetched).toEqual([])
})

test('/rename returns its whole result while the title POST still waits', async ($, on) => {
  const { fetched, clock } = world(on)
  on('command.run', { command: 'rename' }, () => RESULT)
  on('http.fetch', async ($, e) => {
    fetched.push(e)
    await $.clock.sleep(2000)

    return { value: { status: 503, ok: false, headers: {}, text: 'offline' } }
  })

  expect(await $.command.run(rename('foo'))).toEqual(RESULT)
  await clock.advance(0)
  expect(fetched).toHaveLength(1)
  await clock.advance(2000)
})

test('/rename keeps its result when the proxy refuses the title POST', async ($, on) => {
  const { fetched, clock } = world(on)
  on('command.run', { command: 'rename' }, () => RESULT)
  on('http.fetch', (_$, e) => {
    fetched.push(e)

    return { deny: 'the proxy refused the key' }
  })

  expect(await $.command.run(rename('foo'))).toEqual(RESULT)
  await clock.advance(0)

  expect(fetched).toHaveLength(1)
})

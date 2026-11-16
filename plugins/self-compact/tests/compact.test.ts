import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__self-compact__compact'

const summary = [{ role: 'user' as const, text: 'Summary of the conversation.', toolUses: [] }]
const compactNow = ($: { session: { compact: (input: never) => Promise<unknown> } }, instructions = '') =>
  $.session.compact({ trigger: 'manual', instructions, messages: summary } as never)
const notify = ($: { prompt: { submit: (input: never) => Promise<unknown> } }, text: string) =>
  $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false } as never)

test('the tool queues /compact with its instructions, then sends the resume prompt', async ($, on) => {
  const clock = mock.clock(on)
  const order: string[] = []
  on('session.compact', () => ({ messages: summary }))
  on('command.run', async (_, e) => {
    order.push(`/${e.command} ${e.args}`)
    await compactNow($, e.args)
    return { text: 'compacted' }
  })
  on('prompt.submit', (_, e) => {
    order.push(`prompt ${e.text}`)
    return { text: e.text, context: e.context }
  })

  const queued = await $.tool.call({ tool: TOOL, instructions: 'keep the plan', resume: 'Continue with step 3.' })
  expect(queued.deny).toBeUndefined()
  expect(order).toEqual([])

  await clock.advance(0)
  expect(order).toEqual(['/compact keep the plan', 'prompt Continue with step 3.'])
})

test('a prompt that starts first after the compaction carries the resume, and no resume prompt follows', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: { text: string; context: readonly string[] | undefined }[] = []
  on('session.compact', () => ({ messages: summary }))
  on('prompt.submit', (_, e) => {
    prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('command.run', async () => {
    await compactNow($)
    await notify($, 'Monitor event: PR checks passed.')
    return { text: 'compacted' }
  })

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)

  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.text).toBe('Monitor event: PR checks passed.')
  expect(prompts[0]?.context?.at(-1)).toMatch(/Continue with step 3\.$/)
})

test('a resume prompt that starts after another prompt took the resume is dropped', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: { text: string; context: readonly string[] | undefined }[] = []
  const dropped: string[] = []
  on('session.compact', () => ({ messages: summary }))
  on('command.run', async () => {
    await compactNow($)
    return { text: 'compacted' }
  })
  // The engine runs the plugin's hooks on its resume prompt when the prompt starts, not when the timer queues it,
  // and a prompt that queued during the compaction starts first. The replay stands for that start.
  let isQueueAhead = true
  on('prompt.submit', async (_, e) => {
    if (e.origin.kind === 'plugin' && isQueueAhead) {
      isQueueAhead = false
      await notify($, 'Monitor event: PR checks passed.')
      const replay = await $.prompt.submit({ text: e.text, origin: e.origin, wait: false } as never)
      if (replay.drop !== undefined) dropped.push(replay.drop)
      return replay
    }
    prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)

  expect(prompts.map(p => p.text)).toEqual(['Monitor event: PR checks passed.'])
  expect(prompts[0]?.context?.at(-1)).toMatch(/Continue with step 3\.$/)
  expect(dropped).toHaveLength(1)
})

test('the tool takes a new call while the resume prompt waits for the session to go idle', async ($, on) => {
  const clock = mock.clock(on)
  let release: (() => void) | undefined
  on('session.compact', () => ({ messages: summary }))
  on('command.run', async () => {
    await compactNow($)
    return { text: 'compacted' }
  })
  on('prompt.submit', async (_, e) => {
    await new Promise<void>(resolve => (release = resolve))
    return { text: e.text }
  })

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)
  expect(release).toBeDefined()
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
  release?.()
})

test('a prompt before the compaction ends gets no resume', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: { text: string; context: readonly string[] | undefined }[] = []
  on('session.compact', () => ({ messages: summary }))
  on('prompt.submit', (_, e) => {
    prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('command.run', async () => {
    await notify($, 'early')
    await compactNow($)
    return { text: 'compacted' }
  })

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)

  expect(prompts.map(p => p.text)).toEqual(['early', 'Continue with step 3.'])
  expect(prompts[0]?.context).toBeUndefined()
})

test('a skipped compaction sends no resume prompt', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('session.compact', () => ({ skip: 'vetoed' }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('command.run', async () => {
    await compactNow($)
    return { text: 'not compacted' }
  })

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)

  expect(prompts).toEqual([])
})

test('a second call before the first runs is refused', async ($, on) => {
  const clock = mock.clock(on)
  on('command.run', () => ({ text: 'compacted' }))

  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: TOOL })).deny).toMatch(/already queued/)

  await clock.advance(0)
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
})

test('a subagent cannot compact the main conversation', async $ => {
  expect((await $.tool.call({ tool: TOOL, agentId: 'a1' })).deny).toMatch(/main conversation/)
})

const ECHO = 'mcp__fixture__echo'
const NUDGE = /^From the self-compact plugin: context is about \d+k tokens\. Auto-compaction runs at 300k\. .*`compact` tool/

// Stands for the engine's status-line figures: `tokens` is what the last response of the main conversation read.
const contextOf = (on: (event: 'session.usage', hook: () => unknown) => unknown) => {
  const context = { tokens: 0 }
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: context.tokens, window: 1_000_000 }, rateLimits: [] },
  }))
  return context
}
const echo = async (
  $: { tool: { call: (input: never) => Promise<{ context?: readonly string[] }> } },
  agentId?: string,
) => {
  const result = await $.tool.call({ tool: ECHO, text: 'hi', ...(agentId === undefined ? {} : { agentId }) } as never)
  return result.context ?? []
}

test('a tool result gets no nudge below 250k tokens', async ($, on) => {
  const context = contextOf(on as never)
  on('tool.call', () => ({ result: 'hi' }))
  context.tokens = 249_999
  expect(await echo($ as never)).toEqual([])
})

test('the first tool result at 250k tokens gets one nudge, and the next 20k tokens get none', async ($, on) => {
  const context = contextOf(on as never)
  on('tool.call', () => ({ result: 'hi' }))

  context.tokens = 250_400
  const first = await echo($ as never)
  expect(first).toHaveLength(1)
  expect(first[0]).toMatch(NUDGE)
  expect(first[0]).toMatch(/context is about 250k tokens\./)

  context.tokens = 270_399
  expect(await echo($ as never)).toEqual([])

  context.tokens = 270_400
  expect((await echo($ as never))[0]).toMatch(/context is about 270k tokens\./)
})

test('a prompt at 250k tokens carries the nudge', async ($, on) => {
  const context = contextOf(on as never)
  const prompts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.context)
    return { text: e.text, context: e.context }
  })

  context.tokens = 260_000
  await notify($, 'Monitor event: PR checks passed.')
  await notify($, 'Monitor event: PR merged.')

  expect(prompts[0]?.at(-1)).toMatch(NUDGE)
  expect(prompts[1]).toBeUndefined()
})

test('a compaction resets the nudge', async ($, on) => {
  const context = contextOf(on as never)
  on('tool.call', () => ({ result: 'hi' }))
  on('session.compact', () => ({ messages: summary }))

  context.tokens = 260_000
  expect(await echo($ as never)).toHaveLength(1)
  await compactNow($)
  context.tokens = 261_000
  expect(await echo($ as never)).toHaveLength(1)
})

test('a subagent tool result gets no nudge', async ($, on) => {
  const context = contextOf(on as never)
  on('tool.call', () => ({ result: 'hi' }))

  context.tokens = 280_000
  expect(await echo($ as never, 'a1')).toEqual([])
  expect(await echo($ as never)).toHaveLength(1)
})

test('no nudge while a compaction is queued', async ($, on) => {
  const clock = mock.clock(on)
  const context = contextOf(on as never)
  on('tool.call', () => ({ result: 'hi' }))
  on('command.run', () => ({ text: 'compacted' }))

  context.tokens = 280_000
  const queued = await $.tool.call({ tool: TOOL })
  expect(queued.context).toBeUndefined()
  expect(await echo($ as never)).toEqual([])

  await clock.advance(0)
  expect(await echo($ as never)).toHaveLength(1)
})

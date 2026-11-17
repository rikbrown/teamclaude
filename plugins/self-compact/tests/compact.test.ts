import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__self-compact__compact'

const summary = [{ role: 'user' as const, text: 'Summary of the conversation.', toolUses: [] }]
const compactNow = ($: { session: { compact: (input: never) => Promise<unknown> } }, instructions = '') =>
  $.session.compact({ trigger: 'manual', instructions, messages: summary } as never)
const notify = ($: { prompt: { submit: (input: never) => Promise<unknown> } }, text: string) =>
  $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false } as never)

type Origin = { kind: string; name?: string }
type Started = { text: string; origin: string; context: readonly string[] | undefined }

// Stands for the engine's prompt queue, as measured on Claude Code 2.1.326: a queued prompt's `prompt.submit` hooks
// run when it starts, and a plugin's prompt starts only when no other prompt waits.
const engineQueue = ($: { prompt: { submit: (input: never) => Promise<{ drop?: string }> } }, on: never) => {
  const waiting: { text: string; origin: Origin; isMeta?: true }[] = []
  const started: Started[] = []
  const dropped: string[] = []
  let isStarting = false
  ;(on as (event: 'prompt.submit', hook: (_: unknown, e: never) => unknown) => void)(
    'prompt.submit',
    (_, e: { text: string; origin: Origin; context?: readonly string[]; isMeta?: true }) => {
      if (!isStarting) {
        waiting.push({ text: e.text, origin: e.origin, ...(e.isMeta ? { isMeta: e.isMeta } : {}) })
        return { text: e.text }
      }
      started.push({ text: e.text, origin: e.origin.kind, context: e.context })
      return { text: e.text, context: e.context }
    },
  )
  const start = async (prompt: { text: string; origin: Origin; isMeta?: true }) => {
    isStarting = true
    try {
      const result = await $.prompt.submit({ ...prompt, wait: false } as never)
      if (result.drop !== undefined) dropped.push(result.drop)
    } finally {
      isStarting = false
    }
  }
  return {
    started,
    dropped,
    // A prompt that queues with no hook run, as a task notification does during a compaction.
    enqueue: (text: string, extra: { isMeta?: true } = {}) =>
      waiting.push({ text, origin: { kind: 'task-notification' }, ...extra }),
    start,
    // The session goes idle: the waiting prompts start, a plugin's last.
    drain: async () => {
      const isPlugin = (prompt: { origin: Origin }) => prompt.origin.kind === 'plugin'
      const order = [...waiting.filter(prompt => !isPlugin(prompt)), ...waiting.filter(isPlugin)]
      waiting.length = 0
      for (const prompt of order) await start(prompt)
    },
  }
}

const compactOnCommand = ($: Parameters<typeof compactNow>[0], on: never, during?: () => void) =>
  (on as (event: 'command.run', hook: (_: unknown, e: { command: string; args: string }) => unknown) => void)(
    'command.run',
    async (_, e) => {
      await compactNow($, e.args)
      during?.()
      return { text: 'compacted' }
    },
  )

const RESUME_CONTEXT = /^The self-compact plugin compacted this conversation\b.*\n\nContinue with step 3\.$/s

test('the tool queues /compact, and the resume prompt starts its own turn when nothing else waits', async ($, on) => {
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  const commands: string[] = []
  on('session.compact', () => ({ messages: summary }))
  on('command.run', async (_, e) => {
    commands.push(`/${e.command} ${e.args}`)
    await compactNow($, e.args)
    return { text: 'compacted' }
  })

  const queued = await $.tool.call({ tool: TOOL, instructions: 'keep the plan', resume: 'Continue with step 3.' })
  expect(queued.deny).toBeUndefined()
  expect(commands).toEqual([])

  await clock.advance(0)
  await queue.drain()
  expect(commands).toEqual(['/compact keep the plan'])
  expect(queue.started).toEqual([{ text: 'Continue with step 3.', origin: 'plugin', context: undefined }])
  expect(queue.dropped).toEqual([])
})

test('a notification queued in the compaction takes the resume, and the resume prompt is dropped', async ($, on) => {
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never, () => queue.enqueue('Monitor event: PR checks passed.'))

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => p.text)).toEqual(['Monitor event: PR checks passed.'])
  expect(queue.started[0]?.context?.at(-1)).toMatch(RESUME_CONTEXT)
  expect(queue.dropped).toEqual(['self-compact: an earlier prompt took the resume.'])
})

test('a meta prompt that starts first gets no resume, and the resume prompt starts after it', async ($, on) => {
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never, () => queue.enqueue('An idle notice.', { isMeta: true }))

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => [p.text, p.context])).toEqual([
    ['An idle notice.', undefined],
    ['Continue with step 3.', undefined],
  ])
})

test('a prompt that starts before the compaction gets no resume', async ($, on) => {
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await queue.start({ text: 'early', origin: { kind: 'task-notification' } })
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => [p.text, p.context])).toEqual([
    ['early', undefined],
    ['Continue with step 3.', undefined],
  ])
})

test('a skipped compaction drops the resume prompt', async ($, on) => {
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ skip: 'vetoed' }))
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)
  await queue.drain()

  expect(queue.started).toEqual([])
  expect(queue.dropped).toEqual(['self-compact: the compaction did not run.'])
})

test('the tool takes a new call while the resume prompt waits', async ($, on) => {
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await clock.advance(0)
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
  await queue.drain()
  expect(queue.started.map(p => p.text)).toEqual(['Continue with step 3.'])
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

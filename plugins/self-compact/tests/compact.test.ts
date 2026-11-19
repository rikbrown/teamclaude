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

// Stands for the engine's summariser: records each compaction that it summarises.
const summarise = (on: never) => {
  const compactions: string[] = []
  ;(on as (event: 'session.compact', hook: (_: unknown, e: { trigger: string }) => unknown) => void)(
    'session.compact',
    (_, e) => {
      compactions.push(e.trigger)
      return { messages: summary }
    },
  )
  return compactions
}

const endTurn = ($: { turn: { complete: (input: never) => Promise<unknown> } }, extra: { agentId?: string } = {}) =>
  $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as never)
// Stands for the engine's end of a turn.
const answerTurns = (on: never) =>
  (on as (event: 'turn.complete', hook: (_: unknown, e: { answer: string }) => unknown) => void)(
    'turn.complete',
    (_, e) => ({ text: e.answer }),
  )
const stopTurn = ($: Parameters<typeof endTurn>[0]) =>
  $.turn.complete({ answer: '', durationMs: 0, isAborted: true, turnId: 't1', reason: 'aborted' } as never)

const SUMMARY_LIMIT =
  'Keep the summary under 5,000 words. Drop finished work and the history of earlier summaries; keep open tasks, ' +
  'decisions, identifiers and paths that the open work needs.'

const RESUME_CONTEXT = /^The self-compact plugin compacted this conversation\b.*\n\nContinue with step 3\.$/s

test('the tool queues /compact for the turn end, and the resume prompt starts its own turn', async ($, on) => {
  answerTurns(on as never)
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
  await clock.advance(0)
  expect(commands).toEqual([])

  await endTurn($)
  await clock.advance(0)
  await queue.drain()
  expect(commands).toEqual([`/compact keep the plan\n\n${SUMMARY_LIMIT}`])
  expect(queue.started).toEqual([{ text: 'Continue with step 3.', origin: 'plugin', context: undefined }])
  expect(queue.dropped).toEqual([])
})

test('a notification queued in the compaction takes the resume, and the resume prompt is dropped', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never, () => queue.enqueue('Monitor event: PR checks passed.'))

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => p.text)).toEqual(['Monitor event: PR checks passed.'])
  expect(queue.started[0]?.context?.at(-1)).toMatch(RESUME_CONTEXT)
  expect(queue.dropped).toEqual(['self-compact: an earlier prompt took the resume.'])
})

test('a meta prompt that starts first gets no resume, and the resume prompt starts after it', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never, () => queue.enqueue('An idle notice.', { isMeta: true }))

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => [p.text, p.context])).toEqual([
    ['An idle notice.', undefined],
    ['Continue with step 3.', undefined],
  ])
})

test('a prompt that starts before the compaction gets no resume', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await queue.start({ text: 'early', origin: { kind: 'task-notification' } })
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => [p.text, p.context])).toEqual([
    ['early', undefined],
    ['Continue with step 3.', undefined],
  ])
})

test('a skipped compaction drops the resume prompt', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ skip: 'vetoed' }))
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(queue.started).toEqual([])
  expect(queue.dropped).toEqual(['self-compact: the compaction did not run.'])
})

test('the tool takes a new call while the resume prompt waits', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  on('session.compact', () => ({ messages: summary }))
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await endTurn($)
  await clock.advance(0)
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
  await queue.drain()
  expect(queue.started.map(p => p.text)).toEqual(['Continue with step 3.'])
})

test('a second call before the first runs is refused', async ($, on) => {
  answerTurns(on as never)
  on('command.run', () => ({ text: 'compacted' }))

  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: TOOL })).deny).toMatch(/already queued/)

  await endTurn($)
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
})

test('a subagent cannot compact the main conversation', async $ => {
  expect((await $.tool.call({ tool: TOOL, agentId: 'a1' })).deny).toMatch(/main conversation/)
})

test("a subagent's turn end does not start /compact, and a stopped turn drops it", async ($, on) => {
  answerTurns(on as never)
  const commands: string[] = []
  on('command.run', (_, e) => {
    commands.push(e.command)
    return { text: 'compacted' }
  })

  await $.tool.call({ tool: TOOL })
  await endTurn($, { agentId: 'a1' })
  expect(commands).toEqual([])
  await stopTurn($)
  await endTurn($)
  expect(commands).toEqual([])
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
})

test('without instructions, /compact gets the summary limit alone', async ($, on) => {
  answerTurns(on as never)
  const args: string[] = []
  on('command.run', (_, e) => {
    args.push(e.args)
    return { text: 'compacted' }
  })

  await $.tool.call({ tool: TOOL })
  await endTurn($)
  expect(args).toEqual([SUMMARY_LIMIT])
})

const ENGINE_NOTE = /^The self-compact plugin did not compact this conversation: the engine compacted it first\b/
const engineCompact = ($: Parameters<typeof compactNow>[0], extra: { trigger?: string; agentId?: string } = {}) =>
  $.session.compact({ trigger: 'auto', messages: summary, ...extra } as never)

test('an engine compaction after the call skips the own compaction, and the resume carries a note', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  const compactions = summarise(on as never)
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, instructions: 'keep the plan', resume: 'Continue with step 3.' })
  await engineCompact($)
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(compactions).toEqual(['auto'])
  expect(queue.started).toHaveLength(1)
  expect(queue.started[0]?.text).toBe('Continue with step 3.')
  expect(queue.started[0]?.context).toHaveLength(1)
  expect(queue.started[0]?.context?.[0]).toMatch(ENGINE_NOTE)
  expect(queue.started[0]?.context?.[0]).toMatch(/`instructions` were not applied/)
  expect(queue.dropped).toEqual([])
  expect((await $.tool.call({ tool: TOOL })).deny).toBeUndefined()
})

test('after an engine compaction, a prompt that starts first takes the resume with the note', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  summarise(on as never)
  compactOnCommand($, on as never, () => queue.enqueue('Monitor event: PR checks passed.'))

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await engineCompact($)
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(queue.started.map(p => p.text)).toEqual(['Monitor event: PR checks passed.'])
  expect(queue.started[0]?.context?.at(-1)).toMatch(ENGINE_NOTE)
  expect(queue.started[0]?.context?.at(-1)).toMatch(/\n\nContinue with step 3\.$/)
  expect(queue.dropped).toEqual(['self-compact: an earlier prompt took the resume.'])
})

test('a precompute, a subagent or a skipped engine compaction does not skip the own one', async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  const compactions: string[] = []
  on('session.compact', (_, e) => {
    if (e.trigger === 'auto' && e.agentId === undefined) return { skip: 'vetoed' }
    compactions.push(e.agentId === undefined ? e.trigger : `${e.trigger}:${e.agentId}`)
    return { messages: summary }
  })
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await engineCompact($, { trigger: 'precompute' })
  await engineCompact($, { agentId: 'a1' })
  await engineCompact($)
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(compactions).toEqual(['precompute', 'auto:a1', 'manual'])
  expect(queue.started).toEqual([{ text: 'Continue with step 3.', origin: 'plugin', context: undefined }])
})

test("the plugin's own compaction runs once, and is not counted as another one", async ($, on) => {
  answerTurns(on as never)
  const clock = mock.clock(on)
  const queue = engineQueue($ as never, on as never)
  const compactions = summarise(on as never)
  compactOnCommand($, on as never)

  await $.tool.call({ tool: TOOL, resume: 'Continue with step 3.' })
  await endTurn($)
  await clock.advance(0)
  await queue.drain()

  expect(compactions).toEqual(['manual'])
  expect(queue.started).toEqual([{ text: 'Continue with step 3.', origin: 'plugin', context: undefined }])
  expect(queue.dropped).toEqual([])
})

const ECHO = 'mcp__fixture__echo'
const NUDGE = /^From the self-compact plugin: context is about \d+k tokens\. Auto-compaction runs at about \d+k\. .*`compact` tool/

// Stands for the engine's figures: `tokens` is what the last response of the main conversation read, and `threshold`
// the breakdown's `autoCompactThreshold`, absent when the engine gives none.
const contextOf = (on: (event: 'session.usage', hook: () => unknown) => unknown, threshold?: number) => {
  const context: { tokens: number; threshold: number | undefined } = { tokens: 0, threshold }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: context.tokens,
        window: 1_000_000,
        ...(context.threshold === undefined ? {} : { breakdown: { autoCompactThreshold: context.threshold } }),
      },
      rateLimits: [],
    },
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

test('the nudge starts 45k tokens below the threshold, names it, and repeats each 15k tokens', async ($, on) => {
  const context = contextOf(on as never, 267_400)
  on('tool.call', () => ({ result: 'hi' }))

  context.tokens = 222_399
  expect(await echo($ as never)).toEqual([])

  context.tokens = 222_400
  const first = await echo($ as never)
  expect(first).toHaveLength(1)
  expect(first[0]).toMatch(NUDGE)
  expect(first[0]).toMatch(/context is about 222k tokens\. Auto-compaction runs at about 267k\./)

  context.tokens = 237_399
  expect(await echo($ as never)).toEqual([])

  context.tokens = 237_400
  expect((await echo($ as never))[0]).toMatch(/context is about 237k tokens\./)
})

test('the nudge reads the threshold each time', async ($, on) => {
  const context = contextOf(on as never, 267_000)
  on('tool.call', () => ({ result: 'hi' }))

  context.tokens = 130_000
  expect(await echo($ as never)).toEqual([])
  context.threshold = 167_000
  expect((await echo($ as never))[0]).toMatch(/Auto-compaction runs at about 167k\./)
})

test('without a threshold, the nudge starts at 220k tokens and names about 265k', async ($, on) => {
  const context = contextOf(on as never)
  on('tool.call', () => ({ result: 'hi' }))

  context.tokens = 219_999
  expect(await echo($ as never)).toEqual([])
  context.tokens = 220_000
  expect((await echo($ as never))[0]).toMatch(/context is about 220k tokens\. Auto-compaction runs at about 265k\./)
})

test('a prompt past the nudge point carries the nudge', async ($, on) => {
  const context = contextOf(on as never, 267_000)
  const prompts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.context)
    return { text: e.text, context: e.context }
  })

  context.tokens = 230_000
  await notify($, 'Monitor event: PR checks passed.')
  await notify($, 'Monitor event: PR merged.')

  expect(prompts[0]?.at(-1)).toMatch(NUDGE)
  expect(prompts[1]).toBeUndefined()
})

test('a compaction resets the nudge', async ($, on) => {
  const context = contextOf(on as never, 267_000)
  on('tool.call', () => ({ result: 'hi' }))
  on('session.compact', () => ({ messages: summary }))

  context.tokens = 230_000
  expect(await echo($ as never)).toHaveLength(1)
  await compactNow($)
  context.tokens = 231_000
  expect(await echo($ as never)).toHaveLength(1)
})

test('a subagent tool result gets no nudge', async ($, on) => {
  const context = contextOf(on as never, 267_000)
  on('tool.call', () => ({ result: 'hi' }))

  context.tokens = 240_000
  expect(await echo($ as never, 'a1')).toEqual([])
  expect(await echo($ as never)).toHaveLength(1)
})

test('no nudge while a compaction is queued', async ($, on) => {
  answerTurns(on as never)
  const context = contextOf(on as never, 267_000)
  on('tool.call', () => ({ result: 'hi' }))
  on('command.run', () => ({ text: 'compacted' }))

  context.tokens = 240_000
  const queued = await $.tool.call({ tool: TOOL })
  expect(queued.context).toBeUndefined()
  expect(await echo($ as never)).toEqual([])

  await endTurn($)
  expect(await echo($ as never)).toHaveLength(1)
})

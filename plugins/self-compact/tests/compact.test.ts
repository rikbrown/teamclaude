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

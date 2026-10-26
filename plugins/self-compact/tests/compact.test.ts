import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__self-compact__compact'

test('the tool queues /compact with its instructions, then sends the resume prompt', async ($, on) => {
  const clock = mock.clock(on)
  const order: string[] = []
  on('command.run', (_, e) => {
    order.push(`/${e.command} ${e.args}`)
    return { text: 'compacted' }
  })
  on('prompt.submit', (_, e) => {
    order.push(`prompt ${e.text}`)
    return { text: e.text }
  })

  const queued = await $.tool.call({ tool: TOOL, instructions: 'keep the plan', resume: 'Continue with step 3.' })
  expect(queued.deny).toBeUndefined()
  expect(order).toEqual([])

  await clock.advance(0)
  expect(order).toEqual(['/compact keep the plan', 'prompt Continue with step 3.'])
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

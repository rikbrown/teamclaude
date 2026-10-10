import { expect, mock, test } from 'claude-code/testing'

import { backoffMs } from '../hooks/register'

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.'

test('backoff doubles from 5s and stops at 5m', async () => {
  expect(backoffMs(0, 1)).toBe(5_000)
  expect(backoffMs(1, 1)).toBe(10_000)
  expect(backoffMs(2, 0)).toBe(10_000)
  expect(backoffMs(20, 1)).toBe(300_000)
})

test('a lost connection queues a continue after the backoff', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', async (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('classic.StopFailure', async () => ({}))

  await $.classic.StopFailure({ error: 'unknown', error_details: LOST })
  await clock.advance(2_000)
  expect(sent).toEqual([])

  await clock.advance(3_100)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Continue from where it stopped')
})

test('other API errors and subagents are left alone', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', async (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('classic.StopFailure', async () => ({}))

  await $.classic.StopFailure({ error: 'rate_limit', error_details: 'API Error: 429' })
  await $.classic.StopFailure({ error: 'unknown', error_details: LOST, agent_id: 'sub-1' })
  await clock.advance(600_000)
  expect(sent).toEqual([])
})

test('a prompt the person types cancels the waiting retry', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', async (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('classic.StopFailure', async () => ({}))

  await $.classic.StopFailure({ error: 'unknown', error_details: LOST })
  await $.prompt.submit({ text: 'never mind', wait: false, origin: { kind: 'composer' } })
  await clock.advance(600_000)
  expect(sent).toEqual(['never mind'])
})

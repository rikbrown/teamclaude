import { expect, mock, test } from 'claude-code/testing'

import {
  EMPTY_LEDGER,
  CLOSED_TTL_MS,
  apply,
  decisionText,
  listText,
  normaliseId,
  parseRequest,
  prune,
} from '../hooks/ledger'
import type { ListQuery } from '../hooks/ledger'
import type { Ledger } from '../types'

const TOOL = 'mcp__decisions__decisions'
const ROOT = '/tmp/worktree'

const raise = (titles: string[]) => ({
  action: 'raise' as const,
  items: titles.map(title => ({
    title,
    body: `Why ${title} matters.`,
    options: [
      { key: 'a', label: 'Yes' },
      { key: 'b', label: 'No' },
    ],
    recommendation: 'a',
  })),
})

const applied = (ledger: Ledger, request: Parameters<typeof apply>[1], mention: string | null = 'call', now = 0) => {
  const result = apply(ledger, request, mention, now)
  if ('error' in result) throw new Error(result.error)

  return result
}

test('raise gives consecutive IDs and keeps the raising call', async () => {
  const first = applied(EMPTY_LEDGER, raise(['One', 'Two']), 'call-1')
  expect(first.touched.map(decision => decision.id)).toEqual(['D1', 'D2'])
  expect(first.touched[0]?.mentions).toEqual(['call-1'])

  const second = applied(first.ledger, raise(['Three']), null)
  expect(second.touched[0]?.id).toBe('D3')
  expect(second.touched[0]?.mentions).toEqual([])
})

test('update, rule and withdraw change the named decision and add their call', async () => {
  const { ledger } = applied(EMPTY_LEDGER, raise(['One', 'Two']), 'call-1')
  const updated = applied(ledger, { action: 'update', items: [{ id: 'd1', title: 'One, refined' }] }, 'call-2')
  expect(updated.touched[0]).toEqual(expect.objectContaining({ title: 'One, refined', mentions: ['call-1', 'call-2'] }))

  const ruled = applied(updated.ledger, { action: 'rule', items: [{ id: 'D1', ruling: 'D1b' }] }, 'call-3')
  expect(ruled.touched[0]).toEqual(expect.objectContaining({ status: 'ruled', ruling: 'D1b' }))

  const withdrawn = applied(ruled.ledger, { action: 'withdraw', items: [{ id: 'D2', ruling: 'No longer needed' }] })
  expect(withdrawn.touched[0]?.status).toBe('withdrawn')
})

test('refuses an unknown ID, a ruling with no text and an ID on raise', async () => {
  const { ledger } = applied(EMPTY_LEDGER, raise(['One']))
  expect(apply(ledger, { action: 'update', items: [{ id: 'D9', body: 'x' }] }, null, 0)).toEqual({
    error: expect.stringMatching(/^D9 is not in/),
  })
  expect(apply(ledger, { action: 'rule', items: [{ id: 'D1' }] }, null, 0)).toEqual({
    error: 'rule needs the ruling for D1.',
  })
  expect(apply(ledger, { action: 'raise', items: [{ id: 'D2', title: 't', body: 'b' }] }, null, 0)).toEqual({
    error: 'raise gives the IDs: leave id out.',
  })
})

test('prune drops old closed decisions and restarts the IDs when the ledger empties', async () => {
  const { ledger } = applied(EMPTY_LEDGER, raise(['One']))
  const ruled = applied(ledger, { action: 'rule', items: [{ id: 'D1', ruling: 'a' }] }).ledger
  expect(prune(ruled, CLOSED_TTL_MS - 1).decisions).toHaveLength(1)
  expect(prune(ruled, CLOSED_TTL_MS)).toEqual({ next: 1, decisions: [] })
})

test('list text names the options and the recommendation of an open decision', async () => {
  const { touched } = applied(EMPTY_LEDGER, raise(['One']))
  expect(decisionText(touched[0]!)).toBe('D1 [open] One\nWhy One matters.\n- D1a: Yes\n- D1b: No\nRecommendation: D1a (Yes)')
  expect(normaliseId(' d12 ')).toBe('D12')
  expect(normaliseId('D1a')).toBe(null)
})

// D1–D8 ruled with rulings `a1`–`a8`, D9 open.
const longLedger = () => {
  let { ledger } = applied(EMPTY_LEDGER, raise(['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']))
  for (let index = 1; index <= 8; index += 1) {
    ledger = applied(ledger, { action: 'rule', items: [{ id: `D${index}`, ruling: `a${index}` }] }).ledger
  }

  return ledger
}

const query = (input: Record<string, unknown>): ListQuery => {
  const request = parseRequest({ action: 'list', ...input })
  if ('error' in request || request.action !== 'list') throw new Error('not a list request')

  return request.query
}

test('list shows the open decisions in full and the 5 latest closed ones in one line', async () => {
  expect(listText(longLedger(), query({}))).toBe(
    [
      'D9 [open] Nine\nWhy Nine matters.\n- D9a: Yes\n- D9b: No\nRecommendation: D9a (Yes)',
      'Latest closed (5 of 8):\nD8 [ruled] Eight · Ruling: a8\nD7 [ruled] Seven · Ruling: a7\n' +
        'D6 [ruled] Six · Ruling: a6\nD5 [ruled] Five · Ruling: a5\nD4 [ruled] Four · Ruling: a4',
      '3 older closed: list with before: "D4". To read a decision in full: list with ids, such as ids: ["D4"].',
    ].join('\n\n'),
  )
})

test('list with before pages through the older closed decisions', async () => {
  const ledger = longLedger()
  expect(listText(ledger, query({ before: 'D4', limit: 2 }))).toBe(
    'Closed before D4 (2 of 8):\nD3 [ruled] Three · Ruling: a3\nD2 [ruled] Two · Ruling: a2\n\n' +
      '1 older closed: list with before: "D2". To read a decision in full: list with ids, such as ids: ["D2"].',
  )
  expect(listText(ledger, query({ before: 'd2' }))).toBe('Closed before D2 (1 of 8):\nD1 [ruled] One · Ruling: a1')
  expect(listText(ledger, query({ before: 'D1' }))).toBe('No closed decisions before D1.')
})

test('list with ids gives each decision in full and names the missing ones', async () => {
  expect(listText(longLedger(), query({ ids: ['D2', 'D40'] }))).toBe(
    'D2 [ruled] Two\nWhy Two matters.\n- D2a: Yes\n- D2b: No\nRecommendation: D2a (Yes)\nRuling: a2\n\n' +
      "D40 is not in this worktree's ledger. A closed decision leaves it 7 days after its last change.",
  )
  expect(listText(EMPTY_LEDGER, query({ ids: ['D1'] }))).toBe('The ledger of this worktree is empty.')
})

test('list without open decisions says so and refuses bad arguments', async () => {
  const { ledger } = applied(EMPTY_LEDGER, raise(['One']))
  const withdrawn = applied(ledger, { action: 'withdraw', items: [{ id: 'D1', ruling: 'superseded' }] }).ledger
  expect(listText(withdrawn, query({}))).toBe(
    'No open decisions.\n\nLatest closed (1 of 1):\nD1 [withdrawn] One · Reason: superseded',
  )
  expect(parseRequest({ action: 'list', ids: [] })).toEqual({ error: expect.stringMatching(/^ids must be/) })
  expect(parseRequest({ action: 'list', ids: ['D1a'] })).toEqual({ error: expect.stringMatching(/^ids must be/) })
  expect(parseRequest({ action: 'list', ids: ['D1'], before: 'D3' })).toEqual({ error: expect.stringMatching(/not both/) })
  expect(parseRequest({ action: 'list', before: 'soon' })).toEqual({ error: expect.stringMatching(/^before must be/) })
  expect(parseRequest({ action: 'list', limit: 0 })).toEqual({ error: expect.stringMatching(/^limit must be/) })
  expect(parseRequest({ action: 'list', limit: 2.5 })).toEqual({ error: expect.stringMatching(/^limit must be/) })
})

test('the tool stores the ledger of the session root', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__decisions__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const raised = await $.tool.call({ tool: TOOL, ...raise(['One', 'Two']) })
  expect(raised.result).toBe('Raised D1 (One), D2 (Two). Use only these IDs.')

  const listed = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(listed.result).toEqual(expect.stringMatching(/^D1 \[open\] One\n[\s\S]*\n\nD2 \[open\] Two\n/))
  const one = await $.tool.call({ tool: TOOL, action: 'list', ids: ['D2'] })
  expect(one.result).toEqual(expect.stringMatching(/^D2 \[open\] Two\n/))
  const wrong = await $.tool.call({ tool: TOOL, action: 'list', limit: 0 })
  expect(wrong).toEqual(expect.objectContaining({ deny: expect.stringMatching(/^limit must be/) }))

  const refused = await $.tool.call({ tool: TOOL, action: 'rule', items: [{ id: 'D7', ruling: 'a' }] })
  expect(refused).toEqual(expect.objectContaining({ deny: expect.stringMatching(/^D7 is not in/) }))
})

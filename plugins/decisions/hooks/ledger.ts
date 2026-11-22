import type { Decision, DecisionOption, Ledger } from '../types'

export const ACTIONS = ['raise', 'update', 'rule', 'withdraw', 'list'] as const
export type Action = (typeof ACTIONS)[number]

export type Item = {
  id?: string
  title?: string
  body?: string
  options?: DecisionOption[]
  recommendation?: string
  ruling?: string
}

// `ids`: these decisions in full. Otherwise: the open decisions in full when `before` is null, and `limit` closed
// decisions below `before`, newest ID first.
export type ListQuery = { ids: string[] | null; before: string | null; limit: number }
export type ChangeRequest = { action: Exclude<Action, 'list'>; items: Item[] }
export type Request = ChangeRequest | { action: 'list'; query: ListQuery }

export const EMPTY_LEDGER: Ledger = { next: 1, decisions: [] }

// A ruled or withdrawn decision stays in the ledger for this long after its last change.
export const CLOSED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TITLE_MAX = 200
const BODY_MAX = 20_000
const OPTION_KEY = /^[a-z0-9]{1,3}$/
const LATEST_CLOSED = 5
const CLOSED_PAGE = 20
const LIMIT_MAX = 100

export function normaliseId(raw: string): string | null {
  const match = /^\s*d?(\d+)\s*$/i.exec(raw)

  return match ? `D${Number(match[1])}` : null
}

const idNumber = (id: string) => Number(id.slice(1))

export function isLedger(value: unknown): value is Ledger {
  const candidate = value as Partial<Ledger> | null

  return typeof candidate?.next === 'number' && Array.isArray(candidate.decisions)
}

export function prune(ledger: Ledger, now: number): Ledger {
  const decisions = ledger.decisions.filter(
    decision => decision.status === 'open' || now - decision.changedAt < CLOSED_TTL_MS,
  )

  return { next: decisions.length === 0 ? 1 : ledger.next, decisions }
}

// The tool's input, or why it is not one. The engine passes the model's arguments unchecked.
export function parseRequest(input: Record<string, unknown>): Request | { error: string } {
  const action = input.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { error: `action must be one of ${ACTIONS.join(', ')}.` }
  }
  if (action === 'list') return parseList(input)
  const items = input.items ?? []
  if (!Array.isArray(items) || items.some(item => typeof item !== 'object' || item === null)) {
    return { error: 'items must be an array of objects.' }
  }

  return { action: action as ChangeRequest['action'], items: items as Item[] }
}

function parseList({ ids, before, limit }: Record<string, unknown>): Request | { error: string } {
  if (ids !== undefined) {
    const normalised = Array.isArray(ids) ? ids.map(id => (typeof id === 'string' ? normaliseId(id) : null)) : []
    if (normalised.length === 0 || normalised.includes(null)) {
      return { error: 'ids must be a non-empty array of IDs, such as ["D3"].' }
    }
    if (before !== undefined || limit !== undefined) return { error: 'list takes ids, or before and limit: not both.' }

    return { action: 'list', query: { ids: normalised as string[], before: null, limit: 0 } }
  }
  const beforeId = typeof before === 'string' ? normaliseId(before) : null
  if (before !== undefined && beforeId === null) return { error: 'before must be an ID, such as D38.' }
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= LIMIT_MAX)) {
    return { error: `limit must be a whole number from 1 to ${LIMIT_MAX}.` }
  }
  const fallback = beforeId === null ? LATEST_CLOSED : CLOSED_PAGE

  return { action: 'list', query: { ids: null, before: beforeId, limit: (limit as number | undefined) ?? fallback } }
}

function checkOptions(options: unknown): string | null {
  if (!Array.isArray(options)) return 'options must be an array.'
  const keys = new Set<string>()
  for (const option of options as Partial<DecisionOption>[]) {
    if (typeof option?.key !== 'string' || !OPTION_KEY.test(option.key)) {
      return 'each option key must be 1 to 3 lowercase letters or digits, such as a.'
    }
    if (typeof option.label !== 'string' || option.label.trim() === '') return `option ${option.key} needs a label.`
    if (keys.has(option.key)) return `option key ${option.key} appears twice.`
    keys.add(option.key)
  }

  return null
}

function checkText(item: Item, isRaise: boolean): string | null {
  if (isRaise && (typeof item.title !== 'string' || item.title.trim() === '')) return 'raise needs a title.'
  if (isRaise && (typeof item.body !== 'string' || item.body.trim() === '')) return 'raise needs a body.'
  if (item.title !== undefined && (typeof item.title !== 'string' || item.title.length > TITLE_MAX)) {
    return `a title is a string of at most ${TITLE_MAX} characters.`
  }
  if (item.body !== undefined && (typeof item.body !== 'string' || item.body.length > BODY_MAX)) {
    return `a body is a string of at most ${BODY_MAX} characters.`
  }

  return item.options === undefined ? null : checkOptions(item.options)
}

export type Applied = { ledger: Ledger; touched: Decision[] } | { error: string }

/**
 * Applies one tool call to the ledger. `mention` is the call's tool_use_id, or null for a call that the main
 * transcript does not draw (a subagent's).
 */
export function apply(ledger: Ledger, request: ChangeRequest, mention: string | null, now: number): Applied {
  const { action, items } = request
  if (items.length === 0) return { error: `${action} needs at least one item.` }

  const decisions = [...ledger.decisions]
  let next = ledger.next
  const touched: Decision[] = []
  const mentions = (decision: Decision) =>
    mention === null || decision.mentions.includes(mention) ? decision.mentions : [...decision.mentions, mention]

  for (const item of items) {
    const textError = checkText(item, action === 'raise')
    if (textError) return { error: textError }

    if (action === 'raise') {
      if (item.id !== undefined) return { error: 'raise gives the IDs: leave id out.' }
      const decision: Decision = {
        id: `D${next}`,
        title: item.title!.trim(),
        body: item.body!.trim(),
        options: item.options ?? [],
        recommendation: item.recommendation?.trim() || null,
        status: 'open',
        ruling: null,
        mentions: mention === null ? [] : [mention],
        raisedAt: now,
        changedAt: now,
      }
      next += 1
      decisions.push(decision)
      touched.push(decision)
      continue
    }

    const id = typeof item.id === 'string' ? normaliseId(item.id) : null
    if (!id) return { error: `${action} needs the id of each item, such as D3.` }
    const index = decisions.findIndex(decision => decision.id === id)
    if (index === -1) return { error: `${id} is not in this worktree's ledger. Use list to see it.` }
    const current = decisions[index]!
    const ruling = item.ruling?.trim() || null
    if (action === 'rule' && !ruling) return { error: `rule needs the ruling for ${id}.` }

    const changed: Decision = {
      ...current,
      ...(item.title === undefined ? {} : { title: item.title.trim() }),
      ...(item.body === undefined ? {} : { body: item.body.trim() }),
      ...(item.options === undefined ? {} : { options: item.options }),
      ...(item.recommendation === undefined ? {} : { recommendation: item.recommendation.trim() || null }),
      ...(action === 'rule' ? { status: 'ruled' as const, ruling } : {}),
      ...(action === 'withdraw' ? { status: 'withdrawn' as const, ruling } : {}),
      mentions: mentions(current),
      changedAt: now,
    }
    decisions[index] = changed
    touched.push(changed)
  }

  return { ledger: { next, decisions }, touched }
}

// `D3a`, the name of an option in prose and in the person's reply.
export const optionName = (decision: Decision, key: string) => `${decision.id}${key}`

export function recommendationText(decision: Decision): string | null {
  const { recommendation } = decision
  if (recommendation === null) return null
  const option = decision.options.find(candidate => candidate.key === recommendation)

  return option ? `${optionName(decision, option.key)} (${option.label})` : recommendation
}

const rulingText = (decision: Decision) =>
  decision.ruling === null ? null : `${decision.status === 'ruled' ? 'Ruling' : 'Reason'}: ${decision.ruling}`

// One decision in full, as the model reads it from `list`.
export function decisionText(decision: Decision): string {
  const lines = [`${decision.id} [${decision.status}] ${decision.title}`, decision.body]
  for (const option of decision.options) lines.push(`- ${optionName(decision, option.key)}: ${option.label}`)
  const recommended = recommendationText(decision)
  if (recommended) lines.push(`Recommendation: ${recommended}`)
  const ruling = rulingText(decision)
  if (ruling) lines.push(ruling)

  return lines.join('\n')
}

// A closed decision in one line: `list` shows only its title and ruling.
const closedLine = (decision: Decision) =>
  [`${decision.id} [${decision.status}] ${decision.title}`, rulingText(decision)].filter(Boolean).join(' · ')

export function listText(ledger: Ledger, { ids, before, limit }: ListQuery): string {
  if (ledger.decisions.length === 0) return 'The ledger of this worktree is empty.'
  if (ids !== null) {
    const missing = (id: string) =>
      `${id} is not in this worktree's ledger. A closed decision leaves it 7 days after its last change.`

    return ids
      .map(id => {
        const decision = ledger.decisions.find(candidate => candidate.id === id)

        return decision ? decisionText(decision) : missing(id)
      })
      .join('\n\n')
  }

  const closed = ledger.decisions
    .filter(decision => decision.status !== 'open')
    .sort((left, right) => idNumber(right.id) - idNumber(left.id))
  const below = before === null ? closed : closed.filter(decision => idNumber(decision.id) < idNumber(before))
  const page = below.slice(0, limit)
  const sections: string[] = []
  if (before === null) {
    const open = ledger.decisions.filter(decision => decision.status === 'open')
    sections.push(open.length === 0 ? 'No open decisions.' : open.map(decisionText).join('\n\n'))
  }
  if (page.length > 0) {
    const heading = before === null ? 'Latest closed' : `Closed before ${before}`
    sections.push([`${heading} (${page.length} of ${closed.length}):`, ...page.map(closedLine)].join('\n'))
  } else if (before !== null) {
    sections.push(`No closed decisions before ${before}.`)
  }
  const last = page.at(-1)
  if (last && below.length > page.length) {
    sections.push(
      `${below.length - page.length} older closed: list with before: "${last.id}". ` +
        `To read a decision in full: list with ids, such as ids: ["${last.id}"].`,
    )
  }

  return sections.join('\n\n')
}

export function resultText(action: ChangeRequest['action'], touched: Decision[]): string {
  const ids = touched.map(decision => decision.id).join(', ')
  switch (action) {
    case 'raise':
      return `Raised ${touched.map(decision => `${decision.id} (${decision.title})`).join(', ')}. Use only these IDs.`
    case 'update':
      return `Updated ${ids}.`
    case 'rule':
      return `Recorded the ruling on ${ids}.`
    case 'withdraw':
      return `Withdrew ${ids}.`
  }
}

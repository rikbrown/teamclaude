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

export type Request = { action: Action; items: Item[] }

export const EMPTY_LEDGER: Ledger = { next: 1, decisions: [] }

// A ruled or withdrawn decision stays in the ledger for this long after its last change.
export const CLOSED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TITLE_MAX = 200
const BODY_MAX = 20_000
const OPTION_KEY = /^[a-z0-9]{1,3}$/

export function normaliseId(raw: string): string | null {
  const match = /^\s*d?(\d+)\s*$/i.exec(raw)

  return match ? `D${Number(match[1])}` : null
}

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
  const items = input.items ?? []
  if (!Array.isArray(items) || items.some(item => typeof item !== 'object' || item === null)) {
    return { error: 'items must be an array of objects.' }
  }

  return { action: action as Action, items: items as Item[] }
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
export function apply(ledger: Ledger, request: Request, mention: string | null, now: number): Applied {
  const { action, items } = request
  if (action === 'list') return { ledger, touched: ledger.decisions }
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

// One decision as the model reads it from `list`.
export function decisionText(decision: Decision): string {
  const lines = [`${decision.id} [${decision.status}] ${decision.title}`]
  if (decision.status === 'open') {
    lines.push(decision.body)
    for (const option of decision.options) lines.push(`- ${optionName(decision, option.key)}: ${option.label}`)
    const recommended = recommendationText(decision)
    if (recommended) lines.push(`Recommendation: ${recommended}`)
  } else if (decision.ruling) {
    lines.push(`${decision.status === 'ruled' ? 'Ruling' : 'Reason'}: ${decision.ruling}`)
  }

  return lines.join('\n')
}

export function resultText(action: Action, touched: Decision[]): string {
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
    case 'list':
      return touched.length === 0 ? 'The ledger of this worktree is empty.' : touched.map(decisionText).join('\n\n')
  }
}

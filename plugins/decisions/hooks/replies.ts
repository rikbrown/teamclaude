import type { Replies, Reply } from '../types'

export const EMPTY_REPLIES: Replies = { next: 1, items: [] }

// The pane and the band read only the newest replies of a session.
export const MAX_REPLIES = 30
const QUESTION_MAX = 200
const TEXT_MAX = 20_000

export type ReplyInput = { question: string | null; text: string }

export function normaliseReplyId(raw: string): string | null {
  const match = /^\s*r(\d+)\s*$/i.exec(raw)

  return match ? `R${Number(match[1])}` : null
}

// The tool's input, or why it is not one. The engine passes the model's arguments unchecked.
export function parseReply(input: Record<string, unknown>): ReplyInput | { error: string } {
  const { text, question } = input
  if (typeof text !== 'string' || text.trim() === '') return { error: 'reply needs text.' }
  if (text.length > TEXT_MAX) return { error: `text is at most ${TEXT_MAX} characters.` }
  if (question !== undefined && (typeof question !== 'string' || question.length > QUESTION_MAX)) {
    return { error: `question is a string of at most ${QUESTION_MAX} characters.` }
  }

  return { question: question?.trim() || null, text: text.trim() }
}

export function addReply(replies: Replies, input: ReplyInput, mention: string, now: number) {
  const reply: Reply = { id: `R${replies.next}`, ...input, mention, at: now, isRead: false }

  return { replies: { next: replies.next + 1, items: [...replies.items, reply].slice(-MAX_REPLIES) }, reply }
}

// Marks one reply read, or every reply when `id` is absent.
export function markRead(replies: Replies, id?: string): Replies {
  if (!replies.items.some(reply => !reply.isRead && (id === undefined || reply.id === id))) return replies

  return {
    ...replies,
    items: replies.items.map(reply => (id === undefined || reply.id === id ? { ...reply, isRead: true } : reply)),
  }
}

/**
 * The reply that `/next-reply` jumps to: the oldest unread one; with none unread, the reply before `lastJumped`, from
 * the newest, wrapping round to the newest after the oldest.
 */
export function nextReply(items: readonly Reply[], lastJumped: string | null): Reply | null {
  const unread = items.find(reply => !reply.isRead)
  if (unread) return unread
  const newestFirst = [...items].reverse()
  const index = newestFirst.findIndex(reply => reply.id === lastJumped)

  return newestFirst[(index + 1) % newestFirst.length] ?? null
}

// The first line of a reply, for a row of the pane.
export function replyTitle(reply: Reply): string {
  return reply.question ?? reply.text.split('\n').find(line => line.trim() !== '')?.trim() ?? reply.id
}

// The id that the transcript draws a stored row's message under keeps the row uuid's first four groups only
// (`9c2a0ccf-5fa2-4924-818d-ad0a4c0ea650` draws as `9c2a0ccf-5fa2-4924-818d-000000000000`). Both sides key by these.
export const messageKey = (id: string) => id.slice(0, 23)
// The id of the drawn row, for a jump to it.
export const drawnMessageId = (uuid: string) => `${messageKey(uuid)}-000000000000`

type Block = { type: string; text?: string }
export type Row = { uuid: string; door: string; content: readonly Block[] }
// A text block of the main thread's turn that no tool call follows yet.
export type Pending = { uuid: string; text: string }

export const textOf = (content: readonly Block[]) =>
  content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()

// The person's prompt in one line, as the question of the reply that ends its turn.
export function promptSummary(content: readonly Block[]): string | null {
  const line = textOf(content)
    .split('\n')
    .find(candidate => candidate.trim() !== '')
    ?.trim()

  return line ? (line.length <= 80 ? line : `${line.slice(0, 79)}…`) : null
}

/**
 * Follows the main thread's rows. A text block is narration when a tool call follows it in the same turn; the text
 * that ends a turn is not. The caller clears `pending` when a turn completes.
 */
export function trackRow(pending: readonly Pending[], row: Row): { pending: Pending[]; narration: string[] } {
  if (row.door === 'prompt' || row.door === 'command') return { pending: [], narration: [] }
  if (row.door !== 'response') return { pending: [...pending], narration: [] }
  const text = textOf(row.content)
  const own = text === '' ? [] : [{ uuid: row.uuid, text }]
  if (row.content.some(block => block.type === 'tool_use')) {
    return { pending: [], narration: [...pending, ...own].map(block => block.uuid) }
  }

  return { pending: [...pending, ...own], narration: [] }
}

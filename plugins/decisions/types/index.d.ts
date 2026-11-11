export type DecisionStatus = 'open' | 'ruled' | 'withdrawn'

// `key` is a letter; the pane and the transcript name the option `D3a`.
export type DecisionOption = { key: string; label: string }

export type Decision = {
  id: string
  title: string
  // Markdown: the context, the options' consequences, the reason for the recommendation.
  body: string
  options: DecisionOption[]
  recommendation: string | null
  status: DecisionStatus
  // The ruling, or the reason for a withdrawal.
  ruling: string | null
  // The tool_use_ids of the main-thread calls that raised and changed it, oldest first: the rows a jump reveals.
  mentions: string[]
  raisedAt: number
  changedAt: number
}

// One worktree's decisions. `next` is the number of the next ID; it restarts at 1 when the ledger empties.
export type Ledger = { next: number; decisions: Decision[] }

// One answer that Claude gave the person with the `reply` tool, in this session.
export type Reply = {
  // `R1`, `R2`, …: the band's and the pane's label, and the argument of `/decisions R3`.
  id: string
  // The question or request that it answers: Claude's summary, or the first line of the person's prompt.
  question: string | null
  // Markdown.
  text: string
  // The tool_use_id of the call, or the uuid of the stored row whose text ended a turn: the row a jump reveals.
  mention: string
  at: number
  // False until the person jumps to it, or sends a prompt while it ends the transcript.
  isRead: boolean
}

// The reply that the last text of a turn makes, as its message draws it.
export type AutoReplyMark = { id: string; question: string | null }

// `next` is the number of the next ID. The list keeps the newest replies only.
export type Replies = { next: number; items: Reply[] }

declare module 'claude-code' {
  interface PluginState {
    decisions: {
      ledger: Ledger
      replies: Replies
      // By `messageKey` of the message id: true for a main-thread text block that a tool call followed in the same
      // turn. Drawn dim.
      isNarration: StateFamily<boolean>
      // By `messageKey` of the message id: the reply that the last text of a turn that the person's prompt started
      // makes.
      autoReply: StateFamily<AutoReplyMark | null>
      // The decision or reply that the pane shows in full.
      expanded: string | null
      // Whether the pane lists ruled and withdrawn decisions; false at the start of each session.
      showClosed: boolean
    }
  }
}

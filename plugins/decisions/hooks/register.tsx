import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AutoReplyMark, Decision, Ledger, Reply } from '../types'
import {
  EMPTY_REPLIES,
  addReply,
  markRead,
  nextReply,
  normaliseReplyId,
  parseReply,
  drawnMessageId,
  messageKey,
  promptSummary,
  replyTitle,
  trackRow,
} from './replies'
import type { Pending, Row } from './replies'
import { segments } from './replyText'
import {
  ACTIONS,
  EMPTY_LEDGER,
  apply,
  isLedger,
  normaliseId,
  optionName,
  parseRequest,
  prune,
  recommendationText,
  resultText,
} from './ledger'
import type { Item } from './ledger'

const TOOL = 'mcp__decisions__decisions'
const REPLY_TOOL = 'mcp__decisions__reply'
const PANE = 'decisions'
const COMMAND = 'decisions'
const NEXT_REPLY_COMMAND = 'next-reply'
// Claude Code has no keybinding action of its own for a plugin, so the prompt hint's Button borrows one that only the
// diff dialog handles. Bind a chord to it under `Global` in ~/.claude/keybindings.json.
const BORROWED_ACTION = 'diff:nextFile'
// One store key a worktree: `ledger:<session root>`.
const STORE_PREFIX = 'ledger:'
const PANE_PAD_X = 1
const TITLE_COLOR = '#ffffff'
const REPLY_COLOR = 'cyan'
// A dark teal under the reply's text, for a dark terminal theme.
const REPLY_BACKGROUND = '#0e2a30'
const REPLY_TEXT = '#ffffff'
const REPLY_CODE = '#7fe0ea'

const ledger = atom({ plugin: 'decisions', key: 'ledger' } as const, EMPTY_LEDGER)
const replies = atom({ plugin: 'decisions', key: 'replies' } as const, EMPTY_REPLIES)
const isNarration = atom({ plugin: 'decisions', key: 'isNarration' } as const, false)
const autoReply = atom({ plugin: 'decisions', key: 'autoReply' } as const, null)
const expanded = atom({ plugin: 'decisions', key: 'expanded' } as const, null)
const showClosed = atom({ plugin: 'decisions', key: 'showClosed' } as const, false)

const MARKS = { open: '◆', ruled: '✓', withdrawn: '✗', reply: '↳' } as const

const REPLY_DESCRIPTION = `Shows your answer to the person in a highlighted box in the transcript. The band above the prompt \
names the answer until the person reads it, and the Decisions pane lists it.

Use it when you answer the person's question or request and more work follows in the same turn: tool calls, subagents \
or other text. The person then finds the answer above that work. When the answer is the last text of the turn, write \
it as prose: the mod shows the last text of a turn that the person's prompt starts as a reply, and text before a tool \
call dim.
- text: the answer, in markdown. Do not repeat it in your prose.
- question: what the person asked, in at most 10 words.

Do not use it for notes on your own work or for a decision: use the decisions tool. Only the session that the person \
talks to uses this tool. A subagent puts its answer in its report.`

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The answer, in markdown.' },
    question: { type: 'string', description: 'What the person asked, in at most 10 words.' },
  },
  required: ['text'],
}

const DESCRIPTION = `Keeps the ledger of the decisions that you ask the person to make in this worktree. The person reads them in \
the Decisions pane, sees the open IDs above the prompt, and jumps from the pane to the row where you raised each one.

Use it for each question that waits on the person's ruling and that you give an ID. Only the session that the person \
talks to raises decisions. A subagent or an orchestration worker sends its questions to its coordinator.
- raise: one item for each decision, with title, body, options and recommendation. The tool gives the IDs (D1, D2, ...) \
and returns them. Use only these IDs. Name an option by ID and key, such as D3a.
- update: change a decision when you refine it. Give the id and the changed fields.
- rule: record the person's ruling when they give it.
- withdraw: close a decision that no longer applies. Give the reason in ruling.
- list: return every decision of this worktree, with the full text of the open ones. Use it after a compaction, and \
before you name an open ID that you did not raise in this context.

The transcript shows each raised decision in full at the call. Do not repeat the body in your reply: name the IDs.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Such as D3. Required for update, rule and withdraw. Not for raise.' },
          title: { type: 'string', description: 'One line. Required for raise.' },
          body: {
            type: 'string',
            description: "Markdown: the context, each option's consequences, the reason for the recommendation. Required for raise.",
          },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'a, b, c, ...' },
                label: { type: 'string', description: 'A short phrase.' },
              },
              required: ['key', 'label'],
            },
          },
          recommendation: { type: 'string', description: 'An option key, or a short text.' },
          ruling: { type: 'string', description: "rule: the person's ruling. withdraw: the reason." },
        },
      },
    },
  },
  required: ['action'],
}

const storeKey = async ($: EngineInterface) => STORE_PREFIX + (await $.session.root())

const hasOpen = (value: Ledger) => value.decisions.some(decision => decision.status === 'open')

// The pane closes when the last open decision closes. A pane opened while nothing is open stays.
async function setLedger($: EngineInterface, value: Ledger) {
  const before = await read($, ledger)
  await update($, ledger, () => value)
  if (hasOpen(before) && !hasOpen(value) && (await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
  }
}

// The stored ledger, which another session in the same worktree can also change.
async function load($: EngineInterface): Promise<Ledger> {
  const stored = await $.store.get(await storeKey($))
  const value = prune(isLedger(stored) ? stored : EMPTY_LEDGER, await $.clock.now())
  await setLedger($, value)

  return value
}

async function save($: EngineInterface, value: Ledger) {
  const key = await storeKey($)
  if (value.decisions.length === 0) {
    await $.store.delete(key)
  } else {
    await $.store.set(key, value)
  }
  await setLedger($, value)
}

// Deletes the ledgers of worktrees that no longer exist.
async function sweep($: EngineInterface) {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX)) continue
    const exists = await $.fs.stat(key.slice(STORE_PREFIX.length)).then(
      () => true,
      () => false,
    )
    if (!exists) await $.store.delete(key)
  }
}

async function openPane($: EngineInterface, isAsked: boolean): Promise<boolean> {
  const { isPlaced } = await $.ui.open({ id: PANE, title: 'Decisions' })
  if (!isPlaced && isAsked) $.ui.toast('Decisions: the pane waits for a wider terminal')
  // A pane opened unasked waits below 144 columns: close it so that it does not appear later.
  if (!isPlaced && !isAsked) await $.ui.close({ id: PANE })

  return isPlaced
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE && pane.isShown)) {
    await $.ui.close({ id: PANE })

    return false
  }

  return openPane($, true)
}

// Scrolls the transcript to the newest row that raised or changed the decision. Works only for a press or a command.
async function jump($: EngineInterface, decision: Decision, which: 'raised' | 'latest'): Promise<string | null> {
  const requestId = which === 'raised' ? decision.mentions[0] : decision.mentions.at(-1)
  if (!requestId) return `${decision.id} was raised by a subagent: no row to jump to.`
  try {
    const { deny } = await $.ui.scroll({ to: { requestId }, block: 'start' })

    return deny ? `${decision.id}: no row in this transcript (${deny})` : null
  } catch (error) {
    return `${decision.id}: jump failed (${error instanceof Error ? error.message : String(error)})`
  }
}

async function show($: EngineInterface, decision: Decision) {
  await update($, expanded, () => decision.id)
  await openPane($, true)
  toast($, await jump($, decision, 'latest'))
}

async function jumpToReply($: EngineInterface, reply: Reply): Promise<string | null> {
  await update($, replies, value => markRead(value, reply.id))
  // A message's row is drawn under its full uuid or under `drawnMessageId`, which differs between sessions.
  const targets = reply.mention === drawnMessageId(reply.mention) ? [reply.mention] : [reply.mention, drawnMessageId(reply.mention)]
  let problem = ''
  for (const requestId of new Set(targets)) {
    try {
      const { deny } = await $.ui.scroll({ to: { requestId }, block: 'start' })
      if (!deny) return null
      problem = `no row in this transcript (${deny})`
    } catch (error) {
      problem = `jump failed (${error instanceof Error ? error.message : String(error)})`
    }
  }

  return `${reply.id}: ${problem}`
}

async function showReply($: EngineInterface, reply: Reply) {
  await update($, expanded, () => reply.id)
  await openPane($, true)
  toast($, await jumpToReply($, reply))
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>

// A reply in the transcript: bright text on a dark background between two rules, so that it stands out from the work
// around it. No side borders and no padding: a copied line holds only the answer's text.
// No prop is ever undefined: the terminal can throw while it draws one, and then draws the engine's own row.
const RULE_MARGIN = 4
const replyBox = (
  { Box, Text, Markdown }: Ui,
  columns: number | undefined,
  label: string,
  question: string | null,
  text: string,
) => {
  const width = Math.max(20, (columns ?? 80) - RULE_MARGIN)
  const header = truncate(`── ${MARKS.reply} ${label}${question ? `  ${question}` : ''} `, width)

  return (
    <Box flexDirection="column" backgroundColor={REPLY_BACKGROUND}>
      <Text color={REPLY_COLOR}>
        <Text bold>{header}</Text>
        {'─'.repeat(Math.max(0, width - header.length))}
      </Text>
      {segments(text).map(segment =>
        segment.kind === 'markdown' ? (
          <Markdown text={segment.text} />
        ) : segment.kind === 'blank' ? (
          <Text> </Text>
        ) : (
          <Text color={REPLY_TEXT} {...(segment.isHeading ? { bold: true } : {})}>
            {segment.spans.map(span => (
              <Text {...(span.isBold ? { bold: true } : {})} {...(span.isCode ? { color: REPLY_CODE } : {})}>
                {span.text}
              </Text>
            ))}
          </Text>
        ),
      )}
      <Text color={REPLY_COLOR}>{'─'.repeat(width)}</Text>
    </Box>
  )
}

// The reply that `/next-reply` last jumped to: the next press goes to the one before it. A reload clears it.
let lastJumped: string | null = null

async function jumpToNextReply($: EngineInterface) {
  const reply = nextReply((await read($, replies)).items, lastJumped)
  if (!reply) {
    $.ui.toast('No replies in this session.')

    return
  }
  lastJumped = reply.id
  toast($, await jumpToReply($, reply))
}

function toast($: EngineInterface, problem: string | null) {
  if (problem) $.ui.toast(problem)
}

const truncate = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

export const register: Register = on => {
  // The main thread's turn, which a reload drops: its text then stays bright and its last text makes no reply.
  // The text blocks that no tool call follows yet.
  let pending: Pending[] = []
  // The question of the person's prompt that started the turn; null for a turn that a notification started.
  let personPrompt: string | null | undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'decisions', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.tool.register({
      name: 'reply',
      description: REPLY_DESCRIPTION,
      inputSchema: REPLY_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description:
        'Show or hide the Decisions pane; `/decisions D3` shows D3, `/decisions R2` shows reply R2, and each jumps to its row',
    })
    await $.command.register({
      name: NEXT_REPLY_COMMAND,
      description:
        'Jump to the oldest unread reply; with none unread, to the newest reply, then each older one in turn. Bind it to a key as `command:next-reply`',
    })
    await sweep($).catch(() => undefined)
    await load($)

    return next(e)
  })

  // A failed reload keeps the ledger that the pane shows and never stops the prompt.
  // A prompt from the person marks every reply read: the band then names only answers given after it.
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) await update($, replies, value => markRead(value))
    await load($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const content = e.message.content as Row['content']
    const tracked = trackRow(pending, { uuid: e.uuid, door: e.door, content })
    pending = tracked.pending
    if ((e.door === 'prompt' || e.door === 'delivery') && !e.message.isMeta) personPrompt = promptSummary(content)
    for (const uuid of tracked.narration) {
      await update($, memberOf(isNarration, { requestId: messageKey(uuid) }), () => true)
    }

    return result
  }).catch(($, e, next) => next(e))

  // The last text of a turn that the person's prompt started is the answer to it: it becomes a reply.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const last = pending.at(-1)
    const question = personPrompt
    pending = []
    personPrompt = undefined
    if (last && question !== undefined && e.reason === 'answer') {
      const now = await $.clock.now()
      let mark: AutoReplyMark | null = null
      await update($, replies, value => {
        const added = addReply(value, { question, text: last.text }, last.uuid, now)
        mark = { id: added.reply.id, question }

        return added.replies
      })
      await update($, memberOf(autoReply, { requestId: messageKey(last.uuid) }), () => mark)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: REPLY_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the session that the person talks to replies to them. Put the answer in your report.' }
    }
    const input = parseReply(e as unknown as Record<string, unknown>)
    if ('error' in input) return { deny: input.error }
    const now = await $.clock.now()
    let id = ''
    await update($, replies, value => {
      const added = addReply(value, input, e.tool_use_id, now)
      id = added.reply.id

      return added.replies
    })

    return { result: `Shown to the person as ${id}. Do not repeat it. Continue the work.` }
  }).catch(() => ({ deny: 'reply: the answer could not be recorded. Write it as prose.' }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const request = parseRequest(e as unknown as Record<string, unknown>)
    if ('error' in request) return { deny: request.error }
    const now = await $.clock.now()
    const current = await load($)
    const applied = apply(current, request, e.agentId === undefined ? e.tool_use_id : null, now)
    if ('error' in applied) return { deny: applied.error }
    if (request.action !== 'list') await save($, applied.ledger)
    if (request.action === 'raise') await openPane($, false)

    return { result: resultText(request.action, applied.touched) }
  }).catch(() => ({ deny: 'decisions: the ledger could not be read or written. Try again.' }))

  // No text: an output line could add a row and scroll the transcript away from the reply.
  on('command.run', { command: NEXT_REPLY_COMMAND }, async $ => {
    await jumpToNextReply($)

    return {}
  }).catch(() => ({ text: 'next-reply: the replies could not be read.' }))

  // The hint line under the prompt: a button for `/next-reply` that the borrowed action's chord presses. Cyan while a
  // reply is unread; absent while the session has no reply.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const items = (await read($, replies)).items
    if (items.length === 0) return engineLine
    const { Box, Button, Text } = $.ui.resolve(e)
    const label = ` ${MARKS.reply} ctrl+x r`

    return (
      <Box flexDirection="row">
        {engineLine}
        <Button key="next-reply" action={BORROWED_ACTION} plain onPress={() => void jumpToNextReply($)}>
          {items.some(reply => !reply.isRead) ? <Text color={REPLY_COLOR}>{label}</Text> : <Text dimColor>{label}</Text>}
        </Button>
      </Box>
    )
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) {
      const isOpen = await togglePane($)

      return { text: isOpen ? 'Decisions pane opened.' : 'Decisions pane closed.' }
    }
    const replyId = normaliseReplyId(arg)
    if (replyId) {
      const reply = (await read($, replies)).items.find(candidate => candidate.id === replyId)
      if (!reply) return { text: `${replyId} is not among this session's replies.` }
      await showReply($, reply)

      return { text: `${reply.id}: ${replyTitle(reply)}` }
    }
    const id = normaliseId(arg)
    if (!id) return { text: `Usage: /${COMMAND} [D3 | R2]` }
    const decision = (await load($)).decisions.find(candidate => candidate.id === id)
    if (!decision) return { text: `${id} is not in this worktree's ledger.` }
    await show($, decision)

    return { text: `${decision.id}: ${decision.title}` }
  }).catch(() => ({ text: 'decisions: the ledger could not be read.' }))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== REPLY_TOOL || e.props.isErrored) return next(e)
    const input = parseReply((e.props.input ?? {}) as Record<string, unknown>)
    if ('error' in input) return next(e)
    const reply = (await read($, replies)).items.find(candidate => candidate.mention === e.props.tool_use_id)

    return replyBox($.ui.resolve(e), e.viewport?.columns, reply?.id ?? 'Reply', input.question, input.text)
  })

  // Text that a tool call followed in the same turn: drawn dim, so that replies and the text that ends a turn stand out.
  // The last text of a turn that the person's prompt started: drawn as a reply.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const key = { requestId: messageKey(e.requestId) }
    const [mark, isDim] = await Promise.all([read($, memberOf(autoReply, key)), read($, memberOf(isNarration, key))])
    if (mark) return replyBox($.ui.resolve(e), e.viewport?.columns, mark.id, mark.question, e.props.text)
    if (!isDim) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text dimColor>{e.props.isFirstOfReply ? '⏺' : ''}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown text={e.props.text} dimColor />
        </Box>
      </Box>
    )
  })

  // The decision rows in the transcript: the call's own text, drawn as the person reads it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isErrored) return next(e)
    const request = parseRequest((e.props.input ?? {}) as Record<string, unknown>)
    if ('error' in request || request.action === 'list') return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const value = await read($, ledger)
    const raised = value.decisions.filter(decision => decision.mentions[0] === e.props.tool_use_id)

    const card = (item: Item, index: number) => {
      const id = request.action === 'raise' ? (raised[index]?.id ?? 'D…') : (normaliseId(item.id ?? '') ?? '?')
      if (request.action === 'rule' || request.action === 'withdraw') {
        const mark = request.action === 'rule' ? MARKS.ruled : MARKS.withdrawn
        const verb = request.action === 'rule' ? 'ruled' : 'withdrawn'

        return (
          <Text>
            <Text bold>
              {mark} {id} {verb}
            </Text>
            {item.ruling ? `: ${item.ruling}` : ''}
          </Text>
        )
      }
      const decision = { id, options: item.options ?? [], recommendation: item.recommendation ?? null } as Decision

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>
            {request.action === 'raise' ? MARKS.open : '◇'} {id}
            {request.action === 'update' ? ' updated' : ''}
            {item.title ? `  ${item.title}` : ''}
          </Text>
          {item.body ? (
            <Box paddingLeft={2}>
              <Markdown text={item.body} />
            </Box>
          ) : null}
          {(item.options ?? []).map(option => (
            <Text>
              {'  '}
              <Text bold>{optionName(decision, option.key)}</Text> {option.label}
              {option.key === item.recommendation ? <Text color="green"> ← recommended</Text> : ''}
            </Text>
          ))}
          {item.recommendation && !(item.options ?? []).some(option => option.key === item.recommendation) ? (
            <Text>
              {'  '}Recommendation: {recommendationText(decision)}
            </Text>
          ) : null}
        </Box>
      )
    }

    return <Box flexDirection="column">{request.items.map(card)}</Box>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [value, answers] = await Promise.all([read($, ledger), read($, replies)])
    const open = value.decisions.filter(decision => decision.status === 'open')
    const unread = answers.items.filter(reply => !reply.isRead)
    if (e.props.hasSurvey || (open.length === 0 && unread.length === 0)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        {open.length > 0 ? <Text dimColor>{MARKS.open} Open:</Text> : null}
        {open.map(decision => (
          <Button key={`band-${decision.id}`} label={decision.id} plain onPress={() => void show($, decision)} />
        ))}
        {open.length > 0 && unread.length > 0 ? <Text dimColor>·</Text> : null}
        {unread.length > 0 ? <Text color={REPLY_COLOR}>{MARKS.reply} Unread:</Text> : null}
        {unread.map(reply => (
          <Button
            key={`band-${reply.id}`}
            label={reply.id}
            plain
            onPress={async () => toast($, await jumpToReply($, reply))}
          />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const [value, answers, shown, isClosedShown] = await Promise.all([
      read($, ledger),
      read($, replies),
      read($, expanded),
      read($, showClosed),
    ])
    const width = Math.max(10, e.props.bodyColumns - 2 * PANE_PAD_X)
    if (value.decisions.length === 0 && answers.items.length === 0) {
      return (
        <Box paddingX={PANE_PAD_X}>
          <Text dimColor>No decisions in this worktree and no replies in this session.</Text>
        </Box>
      )
    }

    // A click scrolls the transcript to the reply's row, and shows or hides its full text here.
    const replyRow = (reply: Reply) => {
      const prefix = `${MARKS.reply} ${reply.id}  `
      const title = truncate(replyTitle(reply), width - prefix.length)

      return (
        <Button
          key={`row-${reply.id}`}
          plain
          onPress={async () => {
            await update($, expanded, id => (id === reply.id ? null : reply.id))
            toast($, await jumpToReply($, reply))
          }}
        >
          <Text color={REPLY_COLOR} dimColor={reply.isRead}>
            {prefix}
          </Text>
          {reply.isRead ? (
            <Text dimColor>{title}</Text>
          ) : (
            <Text bold color={TITLE_COLOR}>
              {title}
            </Text>
          )}
        </Button>
      )
    }
    const replyDetail = (reply: Reply): RenderElement => (
      <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
        <Markdown text={reply.text} />
      </Box>
    )
    const newestFirst = [...answers.items].reverse()
    const replySection =
      newestFirst.length === 0
        ? []
        : [
            <Text dimColor>Replies · {newestFirst.length}</Text>,
            ...newestFirst.flatMap(reply => [replyRow(reply), ...(shown === reply.id ? [replyDetail(reply)] : [])]),
          ]

    const detail = (decision: Decision): RenderElement => (
      <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
        {decision.status === 'open' ? (
          <Markdown text={decision.body} />
        ) : (
          <Text>
            {decision.status === 'ruled' ? 'Ruling' : 'Reason'}: {decision.ruling ?? '(none given)'}
          </Text>
        )}
        {decision.status === 'open'
          ? decision.options.map(option => (
              <Button
                key={`option-${decision.id}-${option.key}`}
                label={truncate(
                  `${optionName(decision, option.key)} ${option.label}${option.key === decision.recommendation ? ' ←' : ''}`,
                  width - 2,
                )}
                plain
                onPress={() => void $.prompt.fill({ text: `${optionName(decision, option.key)} `, mode: 'insert' })}
              />
            ))
          : null}
        {decision.mentions.length > 1 ? (
          <Button
            key={`raised-${decision.id}`}
            label="↑ where it was first raised"
            plain
            dimColor
            onPress={async () => toast($, await jump($, decision, 'raised'))}
          />
        ) : null}
      </Box>
    )

    // A click scrolls the transcript to the decision's latest row, and shows or hides its full text here.
    const row = (decision: Decision) => {
      const prefix = `${MARKS[decision.status]} ${decision.id}  `
      const title = truncate(decision.title, width - prefix.length)

      return (
        <Button
          key={`row-${decision.id}`}
          plain
          onPress={async () => {
            await update($, expanded, id => (id === decision.id ? null : decision.id))
            toast($, await jump($, decision, 'latest'))
          }}
        >
          <Text dimColor>{prefix}</Text>
          {decision.status === 'open' ? (
            <Text bold color={TITLE_COLOR}>
              {title}
            </Text>
          ) : (
            <Text dimColor>{title}</Text>
          )}
        </Button>
      )
    }

    const rowsOf = (status: Decision['status']) => value.decisions.filter(decision => decision.status === status)
    const rowsWithDetail = (rows: Decision[]) =>
      rows.flatMap(decision => [row(decision), ...(shown === decision.id ? [detail(decision)] : [])])

    const open = rowsOf('open')
    // The ruled and withdrawn sections are hidden until a click on either heading shows both.
    const closed = (status: Exclude<Decision['status'], 'open'>, heading: string) => {
      const rows = rowsOf(status)
      if (rows.length === 0) return []

      return [
        <Button
          key={`heading-${status}`}
          label={`${isClosedShown ? '▾' : '▸'} ${heading} · ${rows.length}`}
          plain
          dimColor
          onPress={() => void update($, showClosed, isShown => !isShown)}
        />,
        ...(isClosedShown ? rowsWithDetail(rows) : []),
      ]
    }

    return (
      <Box flexDirection="column" paddingX={PANE_PAD_X}>
        {value.decisions.length === 0 ? null : open.length === 0 ? (
          <Text dimColor>No open decisions.</Text>
        ) : (
          [
            <Text dimColor>Open · {open.length}</Text>,
            ...rowsWithDetail(open),
          ]
        )}
        {closed('ruled', 'Ruled')}
        {closed('withdrawn', 'Withdrawn')}
        {replySection}
      </Box>
    )
  })
}

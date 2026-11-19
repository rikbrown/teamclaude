import type { EngineInterface, Register } from 'claude-code'

const TOOL = 'compact'
const PLUGIN = 'self-compact'

// The reminder starts this many tokens below the engine's auto-compaction threshold, and repeats after each step.
const NUDGE_MARGIN_TOKENS = 45_000
const NUDGE_STEP_TOKENS = 15_000
// When the engine does not give its threshold. With `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` it compacts at about 267k.
const FALLBACK_NUDGE_TOKENS = 220_000
const FALLBACK_AUTO_COMPACT_TOKENS = 265_000

// The summary is written at about 290 characters per second, so its length sets the time that a compaction takes.
const SUMMARY_LIMIT_INSTRUCTION =
  'Keep the summary under 5,000 words. Drop finished work and the history of earlier summaries; keep open tasks, ' +
  'decisions, identifiers and paths that the open work needs.'

const TOOL_DESCRIPTION =
  'Compacts this conversation, the same as the person typing /compact. The compaction runs after the current turn ' +
  'ends, so end your turn immediately after the call. Use it when the context is large and the work so far can be ' +
  'summarised. A long summary takes minutes to write, so ask for a short one. Before the call, write each fact that ' +
  'must outlive this session to a ticket, a notes file or memory: do not keep it only in the summary. ' +
  '`instructions` tells the summariser what to keep and what to drop. `resume` is a prompt sent to you as a new turn ' +
  'after the compaction, so you can continue the work; leave it out to wait for the person.'

const INSTRUCTIONS_DESCRIPTION =
  'What the summary must keep and drop, as typed after /compact. Keep the open tasks, decisions, identifiers and ' +
  'paths that the open work needs. Drop finished work, merged pull requests, resolved questions and the history of ' +
  'earlier summaries. Ask for a summary of at most 5,000 words. Write at most about 1,500 characters.'

const optionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const compactArgs = (instructions: string | undefined) =>
  instructions === undefined ? SUMMARY_LIMIT_INSTRUCTION : `${instructions}\n\n${SUMMARY_LIMIT_INSTRUCTION}`

const ENGINE_COMPACTED_NOTE =
  'The self-compact plugin did not compact this conversation: the engine compacted it first, after your call. Your ' +
  'compact `instructions` were not applied.'

const resumeContext = (resume: string) =>
  `The self-compact plugin compacted this conversation at your request. Your resume prompt follows. Do it after you ` +
  `deal with the message above:\n\n${resume}`

const engineResumeContext = (resume: string) =>
  `${ENGINE_COMPACTED_NOTE} Your resume prompt follows. Do it after you deal with the message above:\n\n${resume}`

const contextNudge = (tokens: number, autoCompactTokens: number) =>
  `From the self-compact plugin: context is about ${Math.round(tokens / 1000)}k tokens. Auto-compaction runs at ` +
  `about ${Math.round(autoCompactTokens / 1000)}k. At the next quiet point, call the self-compact \`compact\` tool ` +
  `with \`instructions\` and a \`resume\` prompt. Do not stop in the middle of a step.`

type ContextReading = { tokens: number | undefined; autoCompactTokens: number | undefined }

// `tokens` is the status line's figure: the input tokens of the main conversation's last response; absent before one.
// The threshold can change in a session, for example with the model, so each reading asks for it again.
async function readContext($: EngineInterface): Promise<ContextReading> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    return { tokens: context.tokens, autoCompactTokens: context.breakdown?.autoCompactThreshold }
  } catch {
    return { tokens: undefined, autoCompactTokens: undefined }
  }
}

const toastError = ($: EngineInterface, error: unknown) =>
  $.ui.toast(`self-compact: ${error instanceof Error ? error.message : String(error)}`)

type Resume = { text: string; isCompacted: boolean; isDelivered: boolean; isEngineCompaction: boolean }

// From the tool call until its `/compact` ends.
type Queued = {
  // The `/compact` arguments, which the compaction reads as its `instructions`.
  args: string
  resume: string | undefined
  // Set when the turn ends and the plugin starts `/compact`.
  isStarted: boolean
  // Another compaction of the main conversation completed after the tool call.
  isPreempted: boolean
}

type State = {
  // A second tool call is refused while a compaction is queued.
  queued: Queued | undefined
  // The resumes whose own prompt has not started.
  resumes: Resume[]
  // The context size at the last nudge, until the context drops below the nudge point or compacts.
  nudgedAtTokens: number | undefined
}

function queueResume($: EngineInterface, state: State, resume: Resume) {
  state.resumes.push(resume)
  // In Claude Code 2.1.326, a prompt from a timer that starts after a hook's first `await` does not reach this
  // plugin's `prompt.submit` hook, which then cannot drop it. `$.prompt.submit` rejects inside a hook the session
  // waits on; a timer callback runs outside it.
  $.clock.after(0, () => {
    $.prompt.submit({ text: resume.text }).catch((error: unknown) => toastError($, error))
  })
}

async function takeContextNudge($: EngineInterface, state: State) {
  if (state.queued) return undefined
  const { tokens, autoCompactTokens } = await readContext($)
  if (state.queued) return undefined
  const nudgeAt = autoCompactTokens === undefined ? FALLBACK_NUDGE_TOKENS : autoCompactTokens - NUDGE_MARGIN_TOKENS
  if (tokens === undefined || tokens < nudgeAt) {
    state.nudgedAtTokens = undefined
    return undefined
  }
  if (state.nudgedAtTokens !== undefined && tokens < state.nudgedAtTokens + NUDGE_STEP_TOKENS) return undefined
  state.nudgedAtTokens = tokens
  return contextNudge(tokens, autoCompactTokens ?? FALLBACK_AUTO_COMPACT_TOKENS)
}

export const register: Register = on => {
  const state: State = { queued: undefined, resumes: [], nudgedAtTokens: undefined }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string', description: INSTRUCTIONS_DESCRIPTION },
          resume: { type: 'string', description: 'The prompt to send to yourself after the compaction.' },
        },
      },
      isDeferred: false,
    })
    return next(e)
  })

  // Claude Code 2.1.328 rejects `$.command.run` from a `tool.call` hook and its timers, because the command would wait
  // on the turn that the hook holds. The command queues until the session is idle.
  on('turn.complete', ($, e, next) => {
    const queued = state.queued
    if (e.agentId !== undefined || !queued || queued.isStarted) return next(e)
    if (e.isAborted) {
      state.queued = undefined
      $.ui.toast('self-compact: the turn was stopped, so the compaction did not run.')
      return next(e)
    }
    queued.isStarted = true
    $.command
      .run({ command: 'compact', args: queued.args })
      .catch((error: unknown) => toastError($, error))
      .finally(() => {
        if (state.queued === queued) state.queued = undefined
      })
    return next(e)
  })

  // The engine can compact the main conversation between the tool call and the start of this plugin's `/compact`,
  // for example at its auto-compaction threshold. This plugin's compaction then skips, so the summary is not
  // summarised again.
  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    const queued = isMain ? state.queued : undefined
    const isOwn = queued?.isStarted === true && e.instructions === queued.args
    const text = isOwn ? queued.resume : undefined
    if (queued && text !== undefined) queued.resume = undefined
    if (isOwn && queued.isPreempted) {
      if (text !== undefined) {
        queueResume($, state, { text, isCompacted: true, isDelivered: false, isEngineCompaction: true })
      }
      return { skip: 'self-compact: the conversation was compacted after the compact tool call.' }
    }
    let resume: Resume | undefined
    if (text !== undefined) {
      resume = { text, isCompacted: false, isDelivered: false, isEngineCompaction: false }
      queueResume($, state, resume)
    }
    const result = await next(e)
    if (isMain && result.messages !== undefined) {
      state.nudgedAtTokens = undefined
      if (resume) resume.isCompacted = true
      if (queued && !isOwn) queued.isPreempted = true
    }
    return result
  })

  // The engine starts this plugin's resume prompt only when no other prompt waits, and it raises `prompt.submit` when a
  // prompt starts. So the first prompt to start after the compaction takes the resume, and the resume prompt is dropped
  // if it starts later.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const isOwn = e.origin.kind === 'plugin' && e.origin.name === PLUGIN
    const own = isOwn ? state.resumes.find(resume => resume.text === e.text) : undefined
    if (own) {
      state.resumes.splice(state.resumes.indexOf(own), 1)
      if (!own.isCompacted) return { drop: 'self-compact: the compaction did not run.' }
      if (own.isDelivered) return { drop: 'self-compact: an earlier prompt took the resume.' }
      own.isDelivered = true
      return own.isEngineCompaction ? next({ ...e, context: [...(e.context ?? []), ENGINE_COMPACTED_NOTE] }) : next(e)
    }
    const context: string[] = []
    // A meta prompt that starts a turn takes no context.
    const due = e.isMeta ? undefined : state.resumes.find(resume => resume.isCompacted && !resume.isDelivered)
    if (due) {
      due.isDelivered = true
      context.push(due.isEngineCompaction ? engineResumeContext(due.text) : resumeContext(due.text))
    }
    const nudge = await takeContextNudge($, state)
    if (nudge !== undefined) context.push(nudge)
    return context.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...context] })
  })

  // Each tool result of a long turn reaches the model, so the nudge does not wait for the next prompt.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined) return result
    const nudge = await takeContextNudge($, state)
    return nudge === undefined ? result : { ...result, context: [...(result.context ?? []), nudge] }
  })

  on('tool.call', { tool: 'mcp__self-compact__compact' }, ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can compact itself.' }
    if (state.queued) return { deny: 'A compaction is already queued for the end of this turn.' }

    const instructions = optionalText(e.instructions)
    const resume = optionalText(e.resume)
    state.queued = { args: compactArgs(instructions), resume, isStarted: false, isPreempted: false }

    return {
      result:
        'Compaction queued. It runs when this turn ends. End your turn now and start no other work.' +
        (resume === undefined ? '' : ' Your resume prompt follows the compaction as a new turn.'),
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-compact: the compaction could not be queued.' }))
}

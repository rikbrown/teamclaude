import type { EngineInterface, Register } from 'claude-code'

const TOOL = 'compact'
const PLUGIN = 'self-compact'

const CONTEXT_NUDGE_TOKENS = 250_000
const CONTEXT_NUDGE_STEP_TOKENS = 20_000
// The `CLAUDE_CODE_AUTO_COMPACT_WINDOW` that the line names. The plugin does not read the variable.
const AUTO_COMPACT_TOKENS = 300_000

const optionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const resumeContext = (resume: string) =>
  `The self-compact plugin compacted this conversation at your request. Your resume prompt follows. Do it after you ` +
  `deal with the message above:\n\n${resume}`

const contextNudge = (tokens: number) =>
  `From the self-compact plugin: context is about ${Math.round(tokens / 1000)}k tokens. Auto-compaction runs at ` +
  `${AUTO_COMPACT_TOKENS / 1000}k. At the next quiet point, call the self-compact \`compact\` tool with ` +
  `\`instructions\` and a \`resume\` prompt. Do not stop in the middle of a step.`

// The status line's figure: the input tokens of the main conversation's last response; absent before one.
async function mainContextTokens($: EngineInterface) {
  try {
    return (await $.session.usage()).context.tokens
  } catch {
    return undefined
  }
}

const toastError = ($: EngineInterface, error: unknown) =>
  $.ui.toast(`self-compact: ${error instanceof Error ? error.message : String(error)}`)

type Resume = { text: string; isCompacted: boolean; isDelivered: boolean }

export const register: Register = on => {
  // From the tool call until `/compact` ends: a second call is refused. A compaction takes `resume` and clears it.
  let queued: { resume: string | undefined } | undefined
  // The resumes whose own prompt has not started.
  const resumes: Resume[] = []
  // The context size at the last nudge, until the context drops below the threshold or compacts.
  let nudgedAtTokens: number | undefined

  const takeContextNudge = (tokens: number | undefined) => {
    if (queued) return undefined
    if (tokens === undefined || tokens < CONTEXT_NUDGE_TOKENS) {
      nudgedAtTokens = undefined
      return undefined
    }
    if (nudgedAtTokens !== undefined && tokens < nudgedAtTokens + CONTEXT_NUDGE_STEP_TOKENS) return undefined
    nudgedAtTokens = tokens
    return contextNudge(tokens)
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Compacts this conversation, the same as the person typing /compact. The compaction runs after the current turn ' +
        'ends, so end your turn immediately after the call. Use it when the context is large and the work so far can be ' +
        'summarised. `instructions` tells the summariser what to keep. `resume` is a prompt sent to you as a new turn ' +
        'after the compaction, so you can continue the work; leave it out to wait for the person.',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string', description: 'What the summary must keep, as typed after /compact.' },
          resume: { type: 'string', description: 'The prompt to send to yourself after the compaction.' },
        },
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    const text = isMain ? queued?.resume : undefined
    let resume: Resume | undefined
    if (queued && text !== undefined) {
      queued.resume = undefined
      resume = { text, isCompacted: false, isDelivered: false }
      resumes.push(resume)
      // In Claude Code 2.1.326, a prompt from a timer that starts after this hook's first `await` does not reach this
      // plugin's `prompt.submit` hook, which then cannot drop it. `$.prompt.submit` rejects inside a hook the session
      // waits on; a timer callback runs outside it.
      $.clock.after(0, () => {
        $.prompt.submit({ text }).catch((error: unknown) => toastError($, error))
      })
    }
    const result = await next(e)
    if (isMain && result.messages !== undefined) {
      nudgedAtTokens = undefined
      if (resume) resume.isCompacted = true
    }
    return result
  })

  // The engine starts this plugin's resume prompt only when no other prompt waits, and it raises `prompt.submit` when a
  // prompt starts. So the first prompt to start after the compaction takes the resume, and the resume prompt is dropped
  // if it starts later.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const isOwn = e.origin.kind === 'plugin' && e.origin.name === PLUGIN
    const own = isOwn ? resumes.find(resume => resume.text === e.text) : undefined
    if (own) {
      resumes.splice(resumes.indexOf(own), 1)
      if (!own.isCompacted) return { drop: 'self-compact: the compaction did not run.' }
      if (own.isDelivered) return { drop: 'self-compact: an earlier prompt took the resume.' }
      own.isDelivered = true
      return next(e)
    }
    const context: string[] = []
    // A meta prompt that starts a turn takes no context.
    const due = e.isMeta ? undefined : resumes.find(resume => resume.isCompacted && !resume.isDelivered)
    if (due) {
      due.isDelivered = true
      context.push(resumeContext(due.text))
    }
    const nudge = takeContextNudge(await mainContextTokens($))
    if (nudge !== undefined) context.push(nudge)
    return context.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...context] })
  })

  // Each tool result of a long turn reaches the model, so the nudge does not wait for the next prompt.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined) return result
    const nudge = takeContextNudge(await mainContextTokens($))
    return nudge === undefined ? result : { ...result, context: [...(result.context ?? []), nudge] }
  })

  on('tool.call', { tool: 'mcp__self-compact__compact' }, ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can compact itself.' }
    if (queued) return { deny: 'A compaction is already queued for the end of this turn.' }

    const instructions = optionalText(e.instructions)
    const resume = optionalText(e.resume)
    queued = { resume }

    // `$.command.run` rejects inside a hook the turn waits on; a timer callback runs outside it, and the command
    // queues until the session is idle.
    $.clock.after(0, () => {
      $.command
        .run({ command: 'compact', args: instructions ?? '' })
        .catch((error: unknown) => toastError($, error))
        .finally(() => (queued = undefined))
    })

    return {
      result:
        'Compaction queued. It runs when this turn ends. End your turn now and start no other work.' +
        (resume === undefined ? '' : ' Your resume prompt follows the compaction as a new turn.'),
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-compact: the compaction could not be queued.' }))
}

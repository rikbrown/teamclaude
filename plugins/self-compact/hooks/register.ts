import type { Register } from 'claude-code'

const TOOL = 'compact'
const PLUGIN = 'self-compact'

const optionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const resumeContext = (resume: string) =>
  `The self-compact plugin compacted this conversation at your request. Your resume prompt follows. Do it after you ` +
  `deal with the message above:\n\n${resume}`

type Compaction = {
  resume: string | undefined
  isCompacted: boolean
  isResumeDelivered: boolean
}

export const register: Register = on => {
  // From the tool call until `/compact` ends: a second call is refused.
  let queued: Compaction | undefined
  // From the compaction until a prompt takes the resume.
  let resumeDue: Compaction | undefined
  // Resume prompts that this plugin queued and that have not started.
  const resumePrompts: Compaction[] = []

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
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined && queued) {
      queued.isCompacted = true
      if (queued.resume !== undefined) resumeDue = queued
    }
    return result
  })

  // `$.command.run` resolves when the compaction ends, before the prompts that queued during it start. The resume
  // prompt then queues behind them and starts only when the session is idle. So the first prompt to start after the
  // compaction takes the resume, and the resume prompt is dropped if it starts later.
  on('prompt.submit', ($, e, next) => {
    if (e.command) return next(e)
    const index =
      e.origin.kind === 'plugin' && e.origin.name === PLUGIN
        ? resumePrompts.findIndex(compaction => compaction.resume === e.text)
        : -1
    if (index !== -1) {
      const [compaction] = resumePrompts.splice(index, 1)
      if (compaction?.isResumeDelivered) return { drop: 'self-compact: an earlier prompt took the resume.' }
      if (compaction) compaction.isResumeDelivered = true
      if (resumeDue === compaction) resumeDue = undefined
      return next(e)
    }
    const compaction = resumeDue
    if (compaction?.resume === undefined || compaction.isResumeDelivered) return next(e)
    compaction.isResumeDelivered = true
    resumeDue = undefined
    return next({ ...e, context: [...(e.context ?? []), resumeContext(compaction.resume)] })
  })

  on('tool.call', { tool: 'mcp__self-compact__compact' }, ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can compact itself.' }
    if (queued) return { deny: 'A compaction is already queued for the end of this turn.' }

    const instructions = optionalText(e.instructions)
    const resume = optionalText(e.resume)
    const compaction: Compaction = { resume, isCompacted: false, isResumeDelivered: false }
    queued = compaction

    // `$.command.run` rejects inside a hook the turn waits on; a timer callback runs outside it, and the command
    // queues until the session is idle.
    $.clock.after(0, () => {
      void (async () => {
        try {
          try {
            await $.command.run({ command: 'compact', args: instructions ?? '' })
          } finally {
            queued = undefined
          }
          if (resume === undefined || !compaction.isCompacted || compaction.isResumeDelivered) return
          resumePrompts.push(compaction)
          await $.prompt.submit({ text: resume })
        } catch (error) {
          $.ui.toast(`self-compact: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          const index = resumePrompts.indexOf(compaction)
          if (index !== -1) resumePrompts.splice(index, 1)
          if (resumeDue === compaction) resumeDue = undefined
        }
      })()
    })

    return {
      result:
        'Compaction queued. It runs when this turn ends. End your turn now and start no other work.' +
        (resume === undefined ? '' : ' Your resume prompt follows the compaction as a new turn.'),
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-compact: the compaction could not be queued.' }))
}

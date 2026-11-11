import type { Register } from 'claude-code'

const TOOL = 'compact'

const optionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const resumeContext = (resume: string) =>
  `The self-compact plugin compacted this conversation at your request. Your resume prompt follows. Do it after you ` +
  `deal with the message above:\n\n${resume}`

type Pending = {
  resume: string | undefined
  // Set once the compaction is installed. From then on, the first prompt of the session takes the resume.
  isCompacted: boolean
  isResumeDelivered: boolean
}

export const register: Register = on => {
  let pending: Pending | undefined

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
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined && pending) {
      pending.isCompacted = true
    }
    return result
  })

  // The engine starts a queued task notification as soon as the compaction ends, before `$.command.run` resolves
  // here. So the first prompt after the compaction, of any origin, carries the resume.
  on('prompt.submit', ($, e, next) => {
    if (!pending?.isCompacted || pending.resume === undefined || pending.isResumeDelivered || e.command) return next(e)
    pending.isResumeDelivered = true
    if (e.origin.kind === 'plugin' && e.text === pending.resume) return next(e)
    return next({ ...e, context: [...(e.context ?? []), resumeContext(pending.resume)] })
  })

  on('tool.call', { tool: 'mcp__self-compact__compact' }, ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can compact itself.' }
    if (pending) return { deny: 'A compaction is already queued for the end of this turn.' }

    const instructions = optionalText(e.instructions)
    const resume = optionalText(e.resume)
    const queued: Pending = { resume, isCompacted: false, isResumeDelivered: false }
    pending = queued

    // `$.command.run` rejects inside a hook the turn waits on; a timer callback runs outside it, and the command
    // queues until the session is idle.
    $.clock.after(0, () => {
      void (async () => {
        try {
          await $.command.run({ command: 'compact', args: instructions ?? '' })
          if (resume !== undefined && queued.isCompacted && !queued.isResumeDelivered) {
            await $.prompt.submit({ text: resume })
          }
        } catch (error) {
          $.ui.toast(`self-compact: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          pending = undefined
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

import type { EngineInterface, Register } from 'claude-code'

const COMMAND = 'last'
// Claude Code has no keybinding action of its own for a plugin, so the prompt hint's Button borrows one that
// only the diff dialog handles. Bind a chord to it under `Global` in ~/.claude/keybindings.json.
const BORROWED_ACTION = 'diff:back'

async function jumpTo($: EngineInterface, promptIds: readonly string[], n: number) {
  const id = promptIds.at(-n)
  if (!id) return `No prompt ${n} back (${promptIds.length} seen).`

  try {
    const { deny } = await $.ui.scroll({ to: { requestId: id }, block: 'start' })
    return deny ? `Prompt ${n} back: scroll refused (${deny})` : `Prompt ${n} back.`
  } catch (error) {
    return `Prompt ${n} back: scroll failed (${error instanceof Error ? error.message : String(error)})`
  }
}

export const register: Register = on => {
  // Message ids of the person's prompts, oldest first, in the order the transcript first drew them.
  const promptIds: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Scroll to your last prompt (/last 2 for the one before)',
    })

    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const isPrompt = e.props.origin.kind === 'composer' || e.props.origin.kind === 'bridge'
    const isOwnCommand = e.props.text.trimStart().startsWith(`/${COMMAND}`)
    if (isPrompt && !isOwnCommand && !promptIds.includes(e.requestId)) promptIds.push(e.requestId)

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {engineLine}
        <Button
          key="last-prompt"
          label=" ↑ ctrl+x u"
          action={BORROWED_ACTION}
          plain
          dimColor
          onPress={async () => {
            const result = await jumpTo($, promptIds, 1)
            if (result !== 'Prompt 1 back.') $.ui.toast(result)
          }}
        />
      </Box>
    )
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const n = Number(e.args.trim() || '1')
    if (!Number.isInteger(n) || n < 1) return { text: `Usage: /${COMMAND} [n], n ≥ 1` }

    return { text: await jumpTo($, promptIds, n) }
  })
}

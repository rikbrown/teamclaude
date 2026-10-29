import type { Register } from 'claude-code'

import { quotedBlocks } from './quotes'

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const blocks = e.props.isSummary ? [] : quotedBlocks(e.props.text)

    if (blocks.length === 0) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const copy = async (text: string, label: string) => {
      const result = await $.ui.copy({ text, surface: e.surface })
      $.ui.toast(result.isCopied ? `Copied ${label}` : `Not copied: ${result.reason}`)
    }

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="row" gap={1}>
          {blocks.map((text, index) => {
            const label = blocks.length === 1 ? 'Copy' : `Copy ${index + 1}`

            return (
              <Button
                key={`copy-${index}`}
                label={label}
                dimColor
                onPress={() => copy(text, blocks.length === 1 ? 'quote' : `quote ${index + 1}`)}
              />
            )
          })}
        </Box>
      </Box>
    )
  })
}

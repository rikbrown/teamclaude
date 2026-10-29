const FENCE = /^\s*(```|~~~)/
const QUOTE = /^\s*>\s?/

// A reply quotes a draft for the person to send as a markdown blockquote; the terminal draws each `>` as a bar.
export const quotedBlocks = (markdown: string): string[] => {
  const blocks: string[] = []
  let current: string[] | undefined
  let isInFence = false

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      isInFence = !isInFence
    }

    if (!isInFence && QUOTE.test(line)) {
      current ??= []
      current.push(line.replace(QUOTE, ''))
      continue
    }

    if (current) {
      blocks.push(toPlainText(current))
      current = undefined
    }
  }

  if (current) {
    blocks.push(toPlainText(current))
  }

  return blocks.filter(block => block.length > 0)
}

// Keep the text as the terminal shows it: bold and inline code lose their markers.
const toPlainText = (lines: string[]): string =>
  lines
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim()

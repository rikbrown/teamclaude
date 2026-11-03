// A reply's markdown, split so that its prose can draw as bright Text: `Markdown` takes no colour, and the engine
// refuses a `Markdown` inside a `Text`. Code blocks and tables stay markdown, which draws their layout.

export type Span = { text: string; isBold?: true; isCode?: true }
export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'line'; spans: Span[]; isHeading?: true }
  | { kind: 'blank' }

const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|/
const HEADING = /^\s{0,3}#{1,6}\s+/
const BULLET = /^(\s*)[-*+]\s+/
const INLINE = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g

export function inlineSpans(line: string): Span[] {
  const spans: Span[] = []
  let at = 0
  for (const match of line.matchAll(INLINE)) {
    if (match.index > at) spans.push({ text: line.slice(at, match.index) })
    const [, bold, underscored, code, label] = match
    if (code !== undefined) spans.push({ text: code, isCode: true })
    else if (label !== undefined) spans.push({ text: label })
    else spans.push({ text: bold ?? underscored ?? '', isBold: true })
    at = match.index + match[0].length
  }
  if (at < line.length) spans.push({ text: line.slice(at) })

  return spans
}

export function segments(markdown: string): Segment[] {
  const lines = markdown.split('\n')
  const result: Segment[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1]!
      const block = [line]
      while (++index < lines.length) {
        block.push(lines[index]!)
        if (lines[index]!.trim().startsWith(fence)) break
      }
      result.push({ kind: 'markdown', text: block.join('\n') })
    } else if (TABLE_ROW.test(line)) {
      const block = [line]
      while (index + 1 < lines.length && TABLE_ROW.test(lines[index + 1]!)) block.push(lines[++index]!)
      result.push({ kind: 'markdown', text: block.join('\n') })
    } else if (line.trim() === '') {
      if (result.at(-1)?.kind !== 'blank') result.push({ kind: 'blank' })
    } else if (HEADING.test(line)) {
      result.push({ kind: 'line', spans: inlineSpans(line.replace(HEADING, '')), isHeading: true })
    } else {
      result.push({ kind: 'line', spans: inlineSpans(line.replace(BULLET, '$1• ')) })
    }
  }

  return result
}

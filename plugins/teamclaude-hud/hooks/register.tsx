import { atom, read, update } from 'claude-code'
import type {
  ElementConstructor,
  EngineInterface,
  Register,
  RenderElement,
  TextProps,
  Timer,
} from 'claude-code'

import type { Bucket, Fleet, Reading, Seat, Segment } from '../types'
import {
  BAR_EMPTY,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  barCells,
  controlOrigin,
  miniBar,
  parseHeaders,
  parseQuota,
} from './quota'

const PANE = 'teamclaude'
const POLL_MS = 5000
// Below this many terminal columns the footer drops its bars for percentages.
const FOOTER_BARS_MIN_COLUMNS = 110
const FOOTER_BAR_WIDTH = 5
// Keybindings name engine actions only, so the footer's button borrows one
// that nothing handles outside the diff panel. Bind a chord to it in Global
// (`"ctrl+x t": "app:cycleDiffBase"`) and that chord presses the button.
const PANE_ACTION = 'app:cycleDiffBase'
// The pane's padding, in cells: across on each side, and above and below.
const PANE_PAD_X = 2
const PANE_PAD_Y = 1

const reading = atom({ plugin: 'teamclaude-hud', key: 'reading' } as const, null)
const error = atom({ plugin: 'teamclaude-hud', key: 'error' } as const, null)
const isHidden = atom({ plugin: 'teamclaude-hud', key: 'isHidden' } as const, false)

type TextElement = ElementConstructor<TextProps>

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))

const describe = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 80)

/**
 * One poll. Resolves false when the base URL is not a TeamClaude proxy, so the
 * caller stops asking; an outage or a refused key keeps the poll going.
 */
async function refresh(
  $: EngineInterface,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  let response
  try {
    response = await $.http.fetch(url, { headers })
  } catch (err) {
    await update($, error, () => `unreachable: ${describe(err)}`)

    return true
  }
  if (response.status === 401 || response.status === 403) {
    await update($, error, () => 'the proxy refused the key')

    return true
  }
  if (!response.ok && response.status !== 404) {
    await update($, error, () => `HTTP ${response.status}`)

    return true
  }
  const parsed = response.ok ? parseQuota(response.text, await $.clock.now()) : null
  if (!parsed) {
    await update($, reading, () => null)
    await update($, error, () => null)

    return false
  }
  await update($, reading, () => parsed)
  await update($, error, () => null)

  return true
}

// Closes the pane when it is the one on screen; otherwise opens or raises it.
async function togglePane($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE && pane.isShown)) {
    await $.ui.close({ id: PANE })

    return false
  }
  const opened = await $.ui.open({ id: PANE, title: 'TeamClaude' })
  if (!opened.isPlaced) {
    $.ui.toast('TeamClaude: the pane waits for a wider terminal; ◧ TC or ctrl+x t opens it at any width')
  }

  return true
}

function bar(
  Text: TextElement,
  bucket: Bucket | null,
  width: number,
  windowMs: number,
  now: number,
): RenderElement[] {
  const cells = barCells(bucket, width, windowMs, now)
  const parts: RenderElement[] = []
  if (cells.filled) {
    parts.push(
      <Text backgroundColor={cells.colour.bg} color={cells.colour.fg}>
        {cells.filled}
      </Text>,
    )
  }
  if (cells.empty) {
    parts.push(
      <Text backgroundColor={BAR_EMPTY.bg} color={BAR_EMPTY.fg}>
        {cells.empty}
      </Text>,
    )
  }

  return parts
}

function bars(
  Text: TextElement,
  buckets: Pick<Seat, 'fiveHour' | 'weekly' | 'fable'>,
  width: number,
  now: number,
): RenderElement[] {
  return [
    <Text dimColor>5h </Text>,
    ...bar(Text, buckets.fiveHour, width, FIVE_HOUR_MS, now),
    <Text dimColor>  7d </Text>,
    ...bar(Text, buckets.weekly, width, SEVEN_DAY_MS, now),
    ...(buckets.fable
      ? [<Text dimColor>  F7 </Text>, ...bar(Text, buckets.fable, width, SEVEN_DAY_MS, now)]
      : []),
  ]
}

function statusTag(Text: TextElement, seat: Seat): RenderElement | null {
  if (seat.isDisabled) {
    return <Text dimColor> off</Text>
  }
  if (seat.status === 'throttled') {
    return <Text color="yellow"> throttled</Text>
  }
  if (seat.status === 'exhausted' || seat.status === 'error') {
    return <Text color="red"> {seat.status}</Text>
  }

  return null
}

// `5h ▰▱▱▱▱ 13%`, or `5h 13%` where the footer has no room for the bar.
function footerReading(
  label: string,
  bucket: Bucket | null,
  windowMs: number,
  hasBar: boolean,
  now: number,
): Segment[] {
  const bar = miniBar(bucket, FOOTER_BAR_WIDTH, windowMs, now)
  const paint = { color: bar.colour, isDim: bar.colour === null }

  return [
    { text: ` ${label} `, color: null, isDim: true },
    ...(hasBar && bar.filled ? [{ ...paint, text: bar.filled }] : []),
    ...(hasBar ? [{ text: `${bar.empty} `, color: null, isDim: true }] : []),
    { ...paint, text: bar.pct },
  ]
}

function footerSegments(
  fleet: Fleet | null | undefined,
  problem: string | null,
  hasBars: boolean,
  now: number,
): Segment[] {
  if (!fleet) {
    return [{ text: ' offline', color: null, isDim: true }]
  }

  return [
    ...footerReading('5h', fleet.fiveHour, FIVE_HOUR_MS, hasBars, now),
    { text: ' ', color: null, isDim: true },
    ...footerReading('7d', fleet.weekly, SEVEN_DAY_MS, hasBars, now),
    ...(fleet.fable
      ? [{ text: ' ', color: null, isDim: true }, ...footerReading('F7', fleet.fable, SEVEN_DAY_MS, hasBars, now)]
      : []),
    ...(problem ? [{ text: ' · offline', color: null, isDim: true }] : []),
  ]
}

// One line a seat where the bars still hold `97% · 2h30m`; a narrow pane (a
// docked sidebar) puts the name on a line of its own above them.
function seatRows(Text: TextElement, value: Reading, columns: number, now: number) {
  const nameWidth = clamp(Math.max(...value.seats.map(seat => seat.name.length)), 8, 28)
  const lineWidth = (columns - nameWidth - 2 - 15) / 3
  const isWide = lineWidth >= 11
  const width = Math.floor(clamp(isWide ? lineWidth : (columns - 16) / 3, 5, 16))

  return value.seats.flatMap(seat => {
    const name = seat.name.length > nameWidth ? `${seat.name.slice(0, nameWidth - 1)}…` : seat.name
    const tag = statusTag(Text, seat)
    if (isWide) {
      return [
        <Text wrap="truncate">
          <Text bold={!seat.isDisabled} dimColor={seat.isDisabled}>
            {name.padEnd(nameWidth)}
          </Text>
          {'  '}
          {bars(Text, seat, width, now)}
          {tag}
        </Text>,
      ]
    }

    return [
      <Text wrap="truncate">
        <Text bold={!seat.isDisabled} dimColor={seat.isDisabled}>
          {name}
        </Text>
        {tag}
      </Text>,
      <Text wrap="truncate">{bars(Text, seat, width, now)}</Text>,
    ]
  })
}

export const register: Register = on => {
  let timer: Timer | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'teamclaude',
      description: 'Show or hide the TeamClaude seat usage pane; `/teamclaude toggle` shows or hides the footer readout',
    })
    const origin = controlOrigin(
      await $.env.get('ANTHROPIC_BASE_URL'),
      (await $.env.get('HTTPS_PROXY')) ?? (await $.env.get('https_proxy')),
    )
    if (e.isInteractive && origin) {
      const url = `${origin}/teamclaude/quota`
      const headers = parseHeaders(await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))
      let isBusy = false
      const poll = async () => {
        // A proxy that hangs must not stack one request a period.
        if (isBusy) {
          return
        }
        isBusy = true
        try {
          if (!(await refresh($, url, headers))) {
            timer?.cancel()
          }
        } finally {
          isBusy = false
        }
      }
      timer?.cancel()
      timer = $.clock.every(POLL_MS, () => void poll())
      void poll()
    }

    return next(e)
  })

  on('command.run', { command: 'teamclaude' }, async ($, e) => {
    if (e.args.trim() === 'toggle') {
      const hidden = await update($, isHidden, value => !value)

      return { text: hidden ? 'TeamClaude readout hidden.' : 'TeamClaude readout shown.' }
    }
    const isOpen = await togglePane($)

    return { text: isOpen ? 'TeamClaude pane opened.' : 'TeamClaude pane closed.' }
  })

  // The right of the prompt footer, after the engine's own mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [value, problem, hidden] = await Promise.all([
      read($, reading),
      read($, error),
      read($, isHidden),
    ])
    if (hidden || (!value?.fleet && !problem)) {
      return next(e)
    }
    const [modes, now] = await Promise.all([next(e), $.clock.now()])
    const elements = $.ui.resolve(e)
    const { Box, Button } = elements
    const hasBars = (e.viewport?.columns ?? 0) >= FOOTER_BARS_MIN_COLUMNS
    const segments = footerSegments(value?.fleet, problem, hasBars, now)

    return (
      <Box flexDirection="row" gap={e.props.modes.length > 0 ? 2 : 0}>
        {modes}
        <Box flexDirection="row">
          <Button
            key="pane"
            label="◧ TC"
            plain
            dimColor
            action={PANE_ACTION}
            onPress={() => void togglePane($)}
          />
          {'Client' in elements ? (
            <elements.Client key="readout" module="./readout.tsx" props={{ segments }} />
          ) : (
            <elements.Text>{segments.map(segment => segment.text).join('')}</elements.Text>
          )}
        </Box>
      </Box>
    )
  })

  // A click anywhere on the readout.
  on('ui.message', async ($, e) => {
    const data = e.data as { toggle?: unknown } | null
    if (e.element === 'readout' && data?.toggle === true) {
      await togglePane($)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [value, problem] = await Promise.all([read($, reading), read($, error)])
    if (!value) {
      return (
        <Box paddingX={PANE_PAD_X} paddingY={PANE_PAD_Y}>
          <Text dimColor>{problem ? `TeamClaude ${problem}` : 'Waiting for TeamClaude…'}</Text>
        </Box>
      )
    }
    const now = await $.clock.now()
    const age = Math.max(0, Math.round((now - value.at) / 1000))
    const columns = e.props.bodyColumns - 2 * PANE_PAD_X

    return (
      <Box flexDirection="column" paddingX={PANE_PAD_X} paddingY={PANE_PAD_Y}>
        {seatRows(Text, value, columns, now)}
        <Box marginTop={1}>
          <Text dimColor>
            Updated {age}s ago{problem ? ` · ${problem}` : ''}
          </Text>
        </Box>
      </Box>
    )
  })
}

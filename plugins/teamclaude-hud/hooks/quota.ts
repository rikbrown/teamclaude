import type { Bucket, Fleet, Reading, Seat } from '../types'

// Ported from TeamClaude's tui.js (barColor, bar, formatReset) so the bars here
// read the same as the dashboard's. Keep them in step.

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

export type BarColour = { bg: string; fg: string }

export const BAR_GREEN: BarColour = { bg: 'green', fg: 'black' }
export const BAR_YELLOW: BarColour = { bg: 'yellow', fg: 'black' }
export const BAR_ORANGE: BarColour = { bg: '#ff8700', fg: 'black' }
export const BAR_RED: BarColour = { bg: 'red', fg: 'whiteBright' }
export const BAR_EMPTY: BarColour = { bg: 'blackBright', fg: 'white' }

// Above the pace of the window, the bar warms up. With no window to pace
// against it goes by raw fill: an API-key seat's token and request buckets,
// whose cadence is unknown; a reset already past; and the fleet's figures,
// whose reset is the soonest of several staggered ones and so always looks
// like a window about to end (`windowMs` null, as the TUI's fleet lines do).
export function barColour(
  ratio: number,
  resetAt: number | null,
  windowMs: number | null,
  now: number,
): BarColour {
  if (ratio >= 1) {
    return BAR_RED
  }
  const remaining = resetAt ? resetAt - now : 0
  if (windowMs && remaining > 0) {
    const elapsed = Math.max(0, windowMs - remaining)
    const diff = ratio * 100 - (elapsed / windowMs) * 100
    if (diff <= 0) {
      return BAR_GREEN
    }
    if (diff <= 5) {
      return BAR_YELLOW
    }
    if (diff <= 15) {
      return BAR_ORANGE
    }

    return BAR_RED
  }

  return ratio < 0.7 ? BAR_GREEN : ratio < 0.9 ? BAR_YELLOW : BAR_RED
}

export function formatReset(resetAt: number | null, now: number): string {
  if (!resetAt) {
    return ''
  }
  const ms = resetAt - now
  if (ms <= 0) {
    return ''
  }
  const mins = Math.ceil(ms / 60000)
  if (mins < 60) {
    return `${mins}m`
  }
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  if (hrs < 24) {
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
  }
  const days = Math.floor(hrs / 24)
  const rh = hrs % 24

  return rh > 0 ? `${days}d${rh}h` : `${days}d`
}

export type BarCells = { filled: string; empty: string; colour: BarColour }

// The bar's text, centred, cut into the filled and the empty part. The label
// is `97% · 2h30m` where that fits, else the countdown, else the percentage.
export function barCells(
  bucket: Bucket | null,
  width: number,
  windowMs: number | null,
  now: number,
): BarCells {
  const centre = (label: string) => {
    const text = label.slice(0, width)
    const pad = width - text.length
    const left = Math.floor(pad / 2)

    return ' '.repeat(left) + text + ' '.repeat(pad - left)
  }
  const reset = formatReset(bucket?.resetAt ?? null, now)
  if (bucket?.utilization == null || Number.isNaN(bucket.utilization)) {
    return { filled: '', empty: centre(reset || '-'), colour: BAR_EMPTY }
  }
  const ratio = Math.max(0, Math.min(1, bucket.utilization))
  const pct = `${(ratio * 100).toFixed(0)}%`
  const both = reset ? `${pct} · ${reset}` : ''
  const cells = centre(both && both.length <= width ? both : reset || pct)
  const fill = Math.round(ratio * width)

  return {
    filled: cells.slice(0, fill),
    empty: cells.slice(fill),
    colour: barColour(ratio, bucket.resetAt, windowMs, now),
  }
}

export type MiniBar = { filled: string; empty: string; pct: string; colour: string | null }

// The footer's bar: no label inside, the percentage after it, the fill in the
// colour the full bar's background would be.
export function miniBar(
  bucket: Bucket | null,
  width: number,
  windowMs: number | null,
  now: number,
): MiniBar {
  if (bucket?.utilization == null || Number.isNaN(bucket.utilization)) {
    return { filled: '', empty: '▱'.repeat(width), pct: '-', colour: null }
  }
  const ratio = Math.max(0, Math.min(1, bucket.utilization))
  const fill = Math.round(ratio * width)

  return {
    filled: '▰'.repeat(fill),
    empty: '▱'.repeat(width - fill),
    pct: `${(ratio * 100).toFixed(0)}%`,
    colour: barColour(ratio, bucket.resetAt, windowMs, now).bg,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function bucket(value: unknown): Bucket | null {
  if (!isRecord(value)) {
    return null
  }
  const utilization = num(value.utilization)
  const resetAt = num(value.resetAt) ?? num(value.nextResetAt)

  return utilization == null && resetAt == null ? null : { utilization, resetAt }
}

// A Fable figure the server filled from the shared weekly bucket is not a
// Fable reading: show it only when it came from the Fable bucket itself.
function fableBucket(value: unknown): Bucket | null {
  return isRecord(value) && value.source === 'unified7dFable' ? bucket(value) : null
}

/**
 * Reads a /teamclaude/quota reply. Null when the reply is not one, so a base
 * URL that is not a TeamClaude proxy reads as "nothing here", not as an error.
 */
export function parseQuota(body: string, at: number): Reading | null {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(payload) || !Array.isArray(payload.accounts)) {
    return null
  }

  const aggregate = isRecord(payload.aggregate) ? payload.aggregate : null
  const fleet: Fleet | null = aggregate && {
    fiveHour: bucket(aggregate.fiveHour),
    weekly: bucket(aggregate.weeklyShared),
    // The aggregate carries no source; a fleet with no Fable figures reports
    // the shared bucket's numbers here, which is still the right ceiling.
    fable: bucket(aggregate.weeklyFable),
    knownAccounts: isRecord(aggregate.fiveHour)
      ? (num(aggregate.fiveHour.knownAccounts) ?? 0)
      : 0,
  }

  const seats: Seat[] = payload.accounts.filter(isRecord).flatMap(account => {
    const buckets = isRecord(account.buckets) ? account.buckets : {}
    const seat: Seat = {
      name: typeof account.name === 'string' ? account.name.slice(0, 64) : '?',
      status: typeof account.status === 'string' ? account.status.slice(0, 16) : '',
      isDisabled: account.disabled === true,
      isFleet: isRecord(account.tier) && num(account.tier.weight) !== null,
      fiveHour: bucket(buckets.fiveHour),
      weekly: bucket(buckets.weeklyShared),
      fable: fableBucket(buckets.weeklyFable),
      tokens: bucket(buckets.tokens),
      requests: bucket(buckets.requests),
    }
    // A local backend (a translating proxy, not a subscription) has no tier
    // and no readings; the dashboard leaves it out of its rows too. A seat
    // with a tier stays while it waits for its first reading.
    const hasReading = seat.fiveHour || seat.weekly || seat.fable || seat.tokens || seat.requests

    return hasReading || seat.isFleet ? [seat] : []
  })

  return { fleet, seats: sortSeats(seats, at), at }
}

// TeamClaude's `weekly-reset` sort (tui.js _displayOrder): the seat whose week
// ends soonest first, so quota about to lapse unspent is at the top; no
// reading, or a reset already past, last. Fleet seats go above the rest (the
// Codex and API-key seats, which have no tier), as the dashboard groups by
// provider. Ties keep the proxy's own order, the nearest this reply has to the
// arrangement the dashboard breaks them by.
export function sortSeats(seats: Seat[], now: number): Seat[] {
  const resetRank = (seat: Seat) => {
    const resetAt = seat.weekly?.resetAt

    return resetAt != null && resetAt > now ? resetAt : Infinity
  }

  return seats
    .map((seat, index) => ({ seat, index }))
    .sort((x, y) => {
      if (x.seat.isFleet !== y.seat.isFleet) {
        return x.seat.isFleet ? -1 : 1
      }
      const tx = resetRank(x.seat)
      const ty = resetRank(y.seat)
      if (tx !== ty) {
        return tx < ty ? -1 : 1
      }

      return x.index - y.index
    })
    .map(({ seat }) => seat)
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Where the proxy's control plane answers, or null when no TeamClaude is in
 * sight. The origin of ANTHROPIC_BASE_URL (base-URL mode; a pinned session's
 * carries a `/tc-acct/<name>` path the control routes do not answer under),
 * else of HTTPS_PROXY (MITM mode), and that only on this machine: a proxy
 * elsewhere is more likely a corporate one than TeamClaude, and is never sent
 * the proxy key.
 */
export function controlOrigin(
  baseUrl: string | undefined,
  httpsProxy: string | undefined,
): string | null {
  const origin = (raw: string | undefined, isLoopbackOnly: boolean) => {
    if (!raw) {
      return null
    }
    try {
      const url = new URL(raw)
      const isHttp = url.protocol === 'http:' || url.protocol === 'https:'

      return isHttp && (!isLoopbackOnly || LOOPBACK_HOSTS.has(url.hostname)) ? url.origin : null
    } catch {
      return null
    }
  }

  return origin(baseUrl, false) ?? origin(httpsProxy, true)
}

// ANTHROPIC_CUSTOM_HEADERS is `Name: value` lines. The proxy key rides there.
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    }
  }

  return headers
}

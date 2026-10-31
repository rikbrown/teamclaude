// One quota bucket as /teamclaude/quota reports it: how full, and when it resets.
export type Bucket = { utilization: number | null; resetAt: number | null }

// The Claude fleet, tier-weighted by the server. Codex seats have no tier and
// are not in it.
export type Fleet = {
  fiveHour: Bucket | null
  weekly: Bucket | null
  fable: Bucket | null
  knownAccounts: number
  // The fleet seats the 5h figure leaves out because their plan meters no
  // 5-hour window (the server's `exemptAccounts`).
  fiveHourExempt: number
  // False when no fleet seat meters a 5-hour window at all.
  hasSessionWindow: boolean
}

export type Seat = {
  name: string
  status: string
  isDisabled: boolean
  // Counted in the server's tier-weighted fleet; the Codex seats are not.
  isFleet: boolean
  fiveHour: Bucket | null
  // False when the plan meters no 5-hour window (an Ultra plan once the limit
  // is lifted) and no reading from before that is left.
  hasSessionWindow: boolean
  weekly: Bucket | null
  fable: Bucket | null
  // An API-key seat's buckets, drawn where it has no subscription windows.
  tokens: Bucket | null
  requests: Bucket | null
}

export type Reading = { fleet: Fleet | null; seats: Seat[]; at: number }

// One run of the footer readout, as the hooks module hands it to the Client.
export type Segment = { text: string; color: string | null; isDim: boolean }

declare module 'claude-code' {
  interface PluginState {
    'teamclaude-hud': {
      reading: Reading | null
      error: string | null
      isHidden: boolean
    }
  }
}

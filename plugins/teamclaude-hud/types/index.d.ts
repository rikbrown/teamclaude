// One quota bucket as /teamclaude/quota reports it: how full, and when it resets.
export type Bucket = { utilization: number | null; resetAt: number | null }

// The Claude fleet, tier-weighted by the server. Codex seats have no tier and
// are not in it.
export type Fleet = {
  fiveHour: Bucket | null
  weekly: Bucket | null
  fable: Bucket | null
  knownAccounts: number
}

export type Seat = {
  name: string
  status: string
  isDisabled: boolean
  // Counted in the server's tier-weighted fleet; the Codex seats are not.
  isFleet: boolean
  fiveHour: Bucket | null
  weekly: Bucket | null
  fable: Bucket | null
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

import type { EngineInterface, Register, Timer } from 'claude-code'

const LOST = /connection lost mid-response/i
const BASE_MS = 5_000
const CAP_MS = 5 * 60_000
const MAX_ATTEMPTS = 10
const CONTINUE =
  'The previous response was cut off: the API connection was lost mid-response. ' +
  'Continue from where it stopped. Do not repeat work that already finished; ' +
  'check the state first if a tool call may have been cut off.'

let attempt = 0
let pending: { fire: Timer; tick: Timer } | undefined

// Full jitter on a capped exponential, as for an API outage: 5s, 10s, 20s ... 5m.
export function backoffMs(attempt: number, random = Math.random()) {
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** attempt)
  return Math.round(ceiling / 2 + (random * ceiling) / 2)
}

function cancel($: EngineInterface) {
  pending?.fire.cancel()
  pending?.tick.cancel()
  pending = undefined
  $.ui.status(undefined)
}

async function retryNow($: EngineInterface) {
  cancel($)
  await $.prompt.submit({ text: CONTINUE })
}

async function showCountdown($: EngineInterface, label: string, dueAt: number) {
  const left = Math.max(0, Math.ceil((dueAt - (await $.clock.now())) / 1000))
  $.ui.status(`${label} in ${left}s (/conn-retry cancel)`)
}

async function schedule($: EngineInterface) {
  if (attempt >= MAX_ATTEMPTS) {
    $.ui.toast(`conn-retry: gave up after ${MAX_ATTEMPTS} retries`)
    attempt = 0
    return
  }

  cancel($)
  const waitMs = backoffMs(attempt)
  attempt += 1
  const dueAt = (await $.clock.now()) + waitMs
  const label = `conn-retry: retry ${attempt}/${MAX_ATTEMPTS}`

  pending = {
    fire: $.clock.after(waitMs, () => void retryNow($)),
    tick: $.clock.every(1000, () => void showCountdown($, label, dueAt)),
  }
  await showCountdown($, label, dueAt)
  $.ui.toast(`Connection lost mid-response. ${label} in ${Math.round(waitMs / 1000)}s`)
}

export const register: Register = on => {
  attempt = 0
  pending = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'conn-retry',
      description: 'Lost-connection auto-retry: `now`, `cancel`, or no args for status',
    })
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    const said = `${e.error_details ?? ''}\n${e.last_assistant_message ?? ''}`
    if (e.agent_id === undefined && LOST.test(said)) await schedule($)
    return result
  })

  // A clean answer ends the outage: the next drop starts from the shortest wait.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer' && !pending) attempt = 0
    return next(e)
  })

  // The person typed something: they have taken over, so drop the queued retry.
  on('prompt.submit', async ($, e, next) => {
    const isOurs = e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name
    if (!isOurs && pending) {
      cancel($)
      attempt = 0
    }
    return next(e)
  })

  on('command.run', { command: 'conn-retry' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'cancel') {
      const had = pending !== undefined
      cancel($)
      attempt = 0
      return { text: had ? 'Retry cancelled.' : 'No retry is waiting.' }
    }
    if (arg === 'now') {
      await retryNow($)
      return { text: 'Retrying now.' }
    }
    return {
      text: pending
        ? `Retry ${attempt}/${MAX_ATTEMPTS} is waiting.`
        : `Watching for "Connection lost mid-response". ${attempt} retries used in this outage.`,
    }
  })
}

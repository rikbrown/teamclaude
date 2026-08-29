# Quota

How TeamClaude learns each account's quota, the two optional background jobs, and what happens when everything is spent.

## How quota is observed

TeamClaude is **passive** by default: it reads `anthropic-ratelimit-unified-*` headers off the responses that flow through it. An account that hasn't served a request yet shows unknown quota until rotation first reaches it.

Observed quota is persisted to `teamclaude.state.json` next to the config, so rotation state survives a restart. Stale windows are discarded automatically, and the file is safe to delete — quota is simply re-learned from traffic.

## Quota probe

If you'd rather keep idle accounts' quota fresh, enable the background probe:

```bash
teamclaude probe 300    # refresh every 300s
teamclaude probe off    # back to passive (default)
teamclaude probe        # show current setting
```

The **Quota probe** row on the TUI settings screen (`g`) does the same thing, and `p` on the main screen is a one-shot refresh of every account.

It reads each OAuth account's utilization from Anthropic's usage endpoint (`/api/oauth/usage`), which reports quota **without consuming any message quota**. API-key and third-party accounts are skipped. Minimum interval is 30s. Changing it takes effect on a running server immediately.

The probe is also the only source for the **Sonnet 7-day** bucket, when your plan exposes it. The Fable weekly bucket arrives passively in the response headers (`anthropic-ratelimit-unified-7d_oi-*`), so Fable-aware routing works without turning the probe on.

### Revalidating a spent family bucket

Those `7d_oi` headers ride on **Fable responses only** — no other model's response carries them. That makes a spent Fable (or Sonnet) reading self-sealing: once it reads at or above the switch threshold, rotation stops sending that family to the account, which is also the only thing that could have refreshed the reading ([#167](https://github.com/KarpelesLab/teamclaude/issues/167)).

So a spent family reading is trusted for 30 minutes. After that it is dropped, the family falls back to the shared weekly bucket, and the next request of that family re-establishes the truth from real headers — a rejection re-arms the gate with a fresh reading for another 30 minutes, so a genuinely spent bucket costs at most one rejected request per account per window. Set `TEAMCLAUDE_FAMILY_STALE_MS` to tune the window. Readings with headroom are never dropped: they gate nothing.

Running the probe sidesteps this entirely — it refreshes the family buckets from the usage endpoint without spending quota, so a reset is picked up within one probe interval instead of within the staleness window.

## Burn-rate projection

A bar shows how much of a window is spent. It does not say whether you will reach the reset. The projection answers that: it samples each bucket's utilization over a rolling window (default 90 minutes), fits a consumption rate, and compares the time to exhaustion against the bucket's own reset.

Each account row gains a tag per projected bucket, most urgent first, separated by `·`:

- `Ses TTL 38m` — at the current pace this window runs out 38 minutes from now, before it resets.
- `Wk 22% unspent` — the reset arrives first and 22% of the window expires unused.

A window that will stop you is always listed before one that will merely expire, and is colored rather than gray. An unspent share is reported for weekly buckets only: a 5h window refills the same day, so its tail is not worth reading. Small surpluses are suppressed below `projection.wasteFloor` (default 10%).

Consumption is bursty, so the estimate is deliberately conservative about when it speaks. Nothing is reported until the samples span five minutes and show measurable consumption, and an idle account reports nothing rather than a rate of zero. History is held in memory only and restarts with the server, so tags reappear a few minutes after a restart. A window rolling over clears that bucket's history, whether it arrives as a cleared reading or as a drop in utilization.

### Choosing the window

Utilization arrives as whole percent, so the signal is a staircase with 1% steps and a narrow window can contain no step to measure. Sampling once a minute against a known burn rate:

| true burn | 30 min | 60 min | 90 min | 120 min |
| --- | --- | --- | --- | --- |
| 1%/h | 0.4–2.9, silent half the time | 0.1–1.5 | 0.9–1.1 | 0.8–1.1 |
| 2%/h | 0.4–2.9 | 1.6–2.2 | 1.8–2.1 | 1.9–2.1 |
| 3%/h | 2.5–3.4 | 2.6–3.2 | 2.9–3.0 | 2.9–3.0 |
| 5%/h | 4.8–5.2 | | | 5.0 |

Weekly buckets burn slowly enough to sit in the unreliable range, which is why the default is 90 minutes rather than 30. A fast 5h burn is tracked closely at any of these widths, since a heavy run fills the window with steps quickly. Lower `windowMinutes` to react faster to a change of pace, at the cost of a jumpier figure on the weekly buckets.

`status --json` carries every bucket's projection per account, not just the one on the row. Nothing in selection reads any of this: it is a readout, and turning it off changes no routing decision.

## Keep-warm

The rolling **5-hour session window** only starts once an account sends a real message. So when your active account runs out and rotation moves to a cold account, that account's 5h window starts *then* — right when you need its full headroom. Keep-warm ([#76](https://github.com/KarpelesLab/teamclaude/issues/76)) starts the timer on idle accounts ahead of time, so the next account is already partway (or fully) through a fresh window when it's needed.

```bash
teamclaude warmup 600    # warm idle accounts every 600s
teamclaude warmup off    # disabled (default)
teamclaude warmup        # show current setting
```

> ⚠️ **This spends a little quota — unlike the passive quota probe.** The 5h timer can't be started by a read-only call, so keep-warm sends a real (minimal) message: for each eligible idle account it spawns a one-shot `claude -p --bare --model haiku --output-format text "hi"` pointed at this proxy, pinned to that account. It only warms accounts whose 5h window is **not already running**, skips disabled/throttled/errored and third-party-backend accounts, and uses the cheapest model — but it does consume a few tokens and a slice of the 5h/weekly buckets per account per window. Requires the `claude` CLI on `PATH`. Minimum interval 60s; changes apply live. Status shows under `warm` in `teamclaude status --json`.

Keep-warm has nothing to do with the prompt cache — see [Prompt caching across rotation](routing.md#prompt-caching-across-rotation).

## Hold on exhaustion

By default, when all accounts are exhausted TeamClaude returns a `429` immediately, which causes Claude Code to abort the current task. With `holdSeconds` set, the proxy **holds the HTTP connection open** instead and polls silently every ~60 seconds; the instant any account's quota resets, the request is forwarded and Claude Code resumes — the interruption never happens.

Set it in the config file (`~/.config/teamclaude.json`):

```json
"holdSeconds": 3600
```

`teamclaude run` automatically raises `API_TIMEOUT_MS` on the spawned Claude Code process to `holdSeconds + 60` seconds, so the client-side timeout covers the full hold window. No manual Claude Code configuration is needed.

Useful for overnight or unattended runs: rather than waking up to a stopped task, the session resumes silently once a quota window opens.

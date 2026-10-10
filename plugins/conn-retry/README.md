# conn-retry

When a response dies on `API Error: Connection lost mid-response. The response above may be incomplete.`,
this mod waits and then tells Claude to continue. The wait grows as for an API outage: about 5s, 10s,
20s and so on, up to 5 minutes, for at most 10 tries.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude
Code update can change the API under it. Tested on Claude Code 2.1.296.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install conn-retry@rikclaude
```

Pick **user** scope.

## Use

It runs by itself. While a retry waits, the status line shows a countdown:
`conn-retry: retry 2/10 in 17s (type to cancel)`.

If you type a prompt while a retry waits, the mod drops the retry: you have taken over. A turn that
completes with an answer resets the count.

The retry prompt tells Claude to continue from where it stopped, and to check the state before it runs
again a tool call that may have been cut off.

## Limits

- The mod reads the error from the `StopFailure` hook event. Other API errors (rate limits, overload)
  are left to Claude Code's own retries.
- Subagent turns are left alone: the main turn sees the subagent's failure and can deal with it.
- A reload of the mod drops a waiting retry.
- To change the timings, edit `BASE_MS`, `CAP_MS` and `MAX_ATTEMPTS` at the top of `hooks/register.ts`.

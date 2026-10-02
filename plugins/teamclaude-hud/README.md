# teamclaude-hud

Your [TeamClaude](../../README.md) fleet's quota, inside Claude Code. A compact readout sits at
the right of the prompt footer, and a pane shows every seat's bars the way the TeamClaude TUI
does.

```
◧ TC 5h ▰▱▱▱▱ 13%  7d ▰▰▰▰▱ 74%  F7 ▰▰▰▱▱ 50%
```

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a
Claude Code update can change the API under it. Tested on Claude Code 2.1.287.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install teamclaude-hud@rikclaude
```

Pick **user** scope: the fleet is the same in every project. The readout appears once a session
starts with a TeamClaude proxy in its environment.

## What it shows

| Where | What |
| --- | --- |
| Footer, right | The fleet's five-hour, weekly and Fable-weekly use: the server's tier-weighted figures from `GET /teamclaude/quota`. Below 110 terminal columns the bars drop out and the percentages stay. `offline` when the proxy does not answer or refuses the key |
| `/teamclaude` pane | One row per seat: 5h, 7d and (where the seat reports one) F7 bars with the reset countdown, or Tok and Req bars for an API-key seat, plus a tag for a throttled, exhausted or disabled seat. A seat that has not reported yet shows empty bars. Sorted as the TUI's `weekly-reset` sort: the week that ends soonest first, Codex and API-key seats after the Claude ones, ties in the proxy's own order |

The colours follow the TUI's. A seat's bar is green while its window is on pace, then yellow,
orange and red as use runs ahead of the time elapsed. The footer's fleet figures go by fill alone
(red from 90%), as the TUI's fleet lines do: the fleet's reset is the soonest of several staggered
ones, so its pace would always read calm. Codex and API-key seats are not in the footer's fleet
figures, because the server's aggregate does not weight them; they show in the pane.

## Opening the pane

| How | |
| --- | --- |
| Click | Anywhere on the readout. It underlines under the pointer. Clicks reach Claude Code in the fullscreen layout |
| Keyboard | A chord you bind (below) |
| Command | `/teamclaude` opens the pane, and closes it when it is open |

`/teamclaude toggle` hides the footer readout, and shows it again.

### A keyboard shortcut

Keybindings can only name Claude Code's own actions, not a plugin's. So the `◧ TC` button
borrows one that does nothing outside the diff panel, `app:cycleDiffBase`. Bind a chord to it in
`~/.claude/keybindings.json`:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    { "context": "Global", "bindings": { "ctrl+x t": "app:cycleDiffBase" } }
  ]
}
```

While the diff panel is open, that chord cycles the diff base instead, as it would without the
plugin. With the readout hidden there is no button to press, so the chord does nothing.

## How it finds the proxy

| Your setup | What it reads |
| --- | --- |
| Base-URL mode (`teamclaude env --no-mitm`, or a [remote host](../../docs/remote.md)) | The origin of `ANTHROPIC_BASE_URL`. A pinned session's `/tc-acct/<name>` path is dropped: the control routes answer at the root |
| MITM mode (`teamclaude env`, the default) | The origin of `HTTPS_PROXY`, and only when it is on this machine (`127.0.0.1`, `localhost`, `::1`). A proxy anywhere else is never asked |
| A proxy key | The `x-api-key` line in `ANTHROPIC_CUSTOM_HEADERS`, as [Remote host](../../docs/remote.md) sets it. Loopback clients need none |

If the address answers but is not TeamClaude (a 404, or a reply that is not a quota summary), the
mod stops asking and shows nothing. It asks every 5 seconds otherwise.

## Developing it

```bash
claude --plugin-dir plugins/teamclaude-hud     # load this copy; saves reload it
claude plugin validate plugins/teamclaude-hud  # what it hooks and calls, and what the engine refuses
claude plugin test plugins/teamclaude-hud      # tests/*.test.tsx against the engine
```

Once Claude Code has loaded it from this folder, `.claude-plugin/types/` holds the API's
declarations and `tsc -p plugins/teamclaude-hud` type-checks it.

| Path | What it does |
| --- | --- |
| `hooks/register.tsx` | The hooks: the poll, the footer readout, the pane, `/teamclaude` |
| `hooks/readout.tsx` | The footer readout as a `Client` region, so a click anywhere on it toggles the pane |
| `hooks/quota.ts` | Reads the quota reply, finds the proxy, and holds the bar maths ported from the TUI (`barColor`, `bar`, `formatReset`, the `weekly-reset` sort). Keep it in step with `src/tui.js` |
| `types/index.d.ts` | The mod's state contract |

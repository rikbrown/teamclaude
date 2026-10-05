# jump-to-last-prompt

Scrolls the fullscreen transcript back to your last prompt. Works only in the fullscreen layout: in the
classic layout, old output is in the terminal's own scrollback, which Claude Code cannot move.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude
Code update can change the API under it. Tested on Claude Code 2.1.289.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install jump-to-last-prompt@rikclaude
```

Pick **user** scope. Then bind the chord in `~/.claude/keybindings.json` (merge it into an existing file):

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [{ "context": "Global", "bindings": { "ctrl+x u": "diff:back" } }]
}
```

## Use

| How | What |
| --- | --- |
| `ctrl+x u` | Scroll to your last prompt |
| `/last` | The same |
| `/last 2` | The prompt before it, and so on |

A dim `↑ ctrl+x u` at the end of the hint line under the prompt is the button the chord presses. Click it
for the same result.

## Limits

- Claude Code gives a plugin no keybinding action of its own. The button borrows `diff:back`, which only
  the diff dialog handles. While the diff dialog is open, the chord goes back in the dialog.
- The mod learns your prompts as the transcript draws them. After a reload or a resume, a prompt that has
  not drawn since is not on the list yet: scroll past it once, or send a new one.
- The label always reads `ctrl+x u`. If you bind another chord, the label does not change.

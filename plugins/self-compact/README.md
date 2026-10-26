# self-compact

This mod gives Claude a `compact` tool (`mcp__self-compact__compact`). Claude calls it to run `/compact` on its own
session, the same as when you type it. Then a prompt that Claude wrote starts the next turn, so the work continues
without you.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude
Code update can change the API under it. Tested on Claude Code 2.1.310.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install self-compact@rikclaude
```

Pick **user** scope.

## Use

The tool has two optional inputs:

- `instructions`: what the summary must keep, as typed after `/compact`.
- `resume`: the prompt that starts a new turn after the compaction. Without it, the session waits for you.

You can ask for it in plain words, for example "compact yourself, keep the plan, then carry on with step 3".

## How it works

A compaction cannot start while a turn runs, and a tool call always runs inside a turn. The tool queues `/compact`
from a timer callback, outside the hook. The command runs when the turn ends, and the resume prompt follows it as
a new turn. The tool tells Claude to end its turn at once.

## Limits

- Only the main conversation can use it. A subagent's call is refused.
- One compaction at a time: a second call before the first runs is refused.
- If the compaction fails, a toast shows the error and the resume prompt is not sent.

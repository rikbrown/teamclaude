# self-compact

This mod gives Claude a `compact` tool (`mcp__self-compact__compact`). Claude calls it to run `/compact` on its own
session, the same as when you type it. Then a prompt that Claude wrote starts the next turn, so the work continues
without you.

When the main conversation passes 250,000 tokens of context, the mod also tells Claude to compact itself at the next
quiet point, before auto-compaction starts in the middle of a task.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude
Code update can change the API under it. Tested on Claude Code 2.1.326.

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

The resume prompt queues when the compaction starts. Claude Code starts a plugin's prompt only when no other prompt
waits, so a prompt that queued during the compaction, such as a background task's notification, starts first. The
first prompt to start after the compaction, of any origin, carries the resume prompt as context, and the resume prompt
is then dropped. Claude Code shows one line for it: "Prompt dropped by a hook: self-compact: an earlier prompt took the
resume." A slash command, or a prompt that Claude Code adds and does not show as typed, does not take it.

## Context size reminder

A model cannot see its own token count. From 250,000 tokens of context, the mod adds this line after a tool result or a
prompt of the main conversation:

> From the self-compact plugin: context is about 262k tokens. Auto-compaction runs at 300k. At the next quiet point,
> call the self-compact `compact` tool with `instructions` and a `resume` prompt. Do not stop in the middle of a step.

- The count is the status line's figure: the input tokens of the last response of the main conversation.
- The line comes once at 250,000 tokens, then at most once for each further 20,000 tokens.
- A compaction resets it. No line comes while a compaction is queued, or in a subagent.
- The line states the auto-compaction point that `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` sets. The mod does not read
  the variable, and it has no settings.

## Limits

- Only the main conversation can use it. A subagent's call is refused.
- One compaction at a time: a second call before the first compaction ends is refused.
- If the compaction fails or a hook skips it, the resume prompt is dropped. A failure also shows a toast.

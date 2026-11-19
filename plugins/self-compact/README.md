# self-compact

This mod gives Claude a `compact` tool (`mcp__self-compact__compact`). Claude calls it to run `/compact` on its own
session, the same as when you type it. Then a prompt that Claude wrote starts the next turn, so the work continues
without you.

When the main conversation comes within 45,000 tokens of the engine's auto-compaction point, the mod also tells Claude
to compact itself at the next quiet point, before auto-compaction starts in the middle of a task.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude
Code update can change the API under it. Tested on Claude Code 2.1.328.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install self-compact@rikclaude
```

Pick **user** scope.

## Use

The tool has two optional inputs:

- `instructions`: what the summary must keep and drop, as typed after `/compact`.
- `resume`: the prompt that starts a new turn after the compaction. Without it, the session waits for you.

## Summary length

A compaction takes the time that the summarizer needs to write the summary, about 290 characters a second. Each summary
also keeps the one before it, so in a long session the summary grows unless something drops the old parts. The tool's
description tells Claude to ask for a summary of at most 5,000 words, to say what to keep and what to drop, to keep
`instructions` under about 1,500 characters, and to write facts that must outlive the session to a ticket, a notes file
or memory before the call. The mod also adds this sentence after the `instructions` it passes to `/compact`:

> Keep the summary under 5,000 words. Drop finished work and the history of earlier summaries; keep open tasks,
> decisions, identifiers and paths that the open work needs.

You can ask for it in plain words, for example "compact yourself, keep the plan, then carry on with step 3".

## How it works

A compaction cannot start while a turn runs, and a tool call always runs inside a turn. The tool records the request
and tells Claude to end its turn at once. When the main conversation's turn ends, the mod runs `/compact`, and the
resume prompt follows it as a new turn. Claude Code 2.1.328 refuses a `/compact` that the mod starts from the tool call
itself, because the command would wait on the turn that the call holds. If you stop the turn, the compaction does not
run.

### A compaction by the engine first

The engine can compact the main conversation after the tool call and before the mod's `/compact` starts, for example
when the context passes its auto-compaction point. Then the mod's compaction does not run: it would only summarise the
new summary again, which takes minutes. The mod skips it when it starts, and Claude Code shows one line for the skip.
The resume prompt still comes once, with a note that the engine compacted first and that the `instructions` were not
applied.

The mod tells its own compaction from another one by its `instructions`, which are the arguments that it passed to
`/compact`. A precompute, a subagent's compaction and a compaction that a hook skipped do not count.

The resume prompt queues when the compaction starts. Claude Code starts a plugin's prompt only when no other prompt
waits, so a prompt that queued during the compaction, such as a background task's notification, starts first. The
first prompt to start after the compaction, of any origin, carries the resume prompt as context, and the resume prompt
is then dropped. Claude Code shows one line for it: "Prompt dropped by a hook: self-compact: an earlier prompt took the
resume." A slash command, or a prompt that Claude Code adds and does not show as typed, does not take it.

## Context size reminder

A model cannot see its own token count. From 45,000 tokens below the engine's auto-compaction point, the mod adds this
line after a tool result or a prompt of the main conversation:

> From the self-compact plugin: context is about 225k tokens. Auto-compaction runs at about 267k. At the next quiet
> point, call the self-compact `compact` tool with `instructions` and a `resume` prompt. Do not stop in the middle of a
> step.

- The count is the status line's figure: the input tokens of the last response of the main conversation.
- The auto-compaction point is `autoCompactThreshold` of the context breakdown (`$.session.usage({ breakdown:
  'summary' })`). The mod reads it each time, because it can change in a session, for example with the model. With
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` it is 267,000.
- If the engine gives no point, for example when auto-compaction is off, the line comes from 220,000 tokens and says
  "about 265k".
- The line comes once at that point, then at most once for each further 15,000 tokens.
- A compaction resets it. No line comes while a compaction is queued, or in a subagent. The mod has no settings.

## Limits

- Only the main conversation can use it. A subagent's call is refused.
- One compaction at a time: a second call before the first compaction ends is refused.
- If the compaction fails or a hook skips it, the resume prompt is dropped. A failure also shows a toast.

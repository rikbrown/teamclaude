# Agent routing

From the `rikclaude-agents` plugin. These rules decide which model does a piece of work that you hand to another
agent. They apply in the same way to a subagent (the Agent tool) and to a child session that you start on another
model (for example an Orca worktree).

These rules are for the orchestrator, the session the user talks to. An agent that receives a brief does the work in
it. Its agent prompt says if it can delegate.

## How to dispatch

- Subagent: name the agent type in the Agent column. Plugin agents are namespaced, so a bare name such as
  `opus-high` resolves to nothing. Do not dispatch a model directly: it inherits this session's effort. Do not pass
  the Agent tool's `model` parameter with an agent type: it replaces the agent's model and keeps its effort, with no
  warning.
- Child session: pass the Model of the row and the effort in the agent's name. With Orca:
  `orca worktree create --agent claude --model <Model> --effort <effort> …`, for example
  `--model gpt-6.2-sol --effort xhigh`. Use `--agent claude` for each model: the fleet serves the GPT and Gemini
  models through Claude Code. Without both flags, the session starts on the default model. Never use the `codex` or
  `gemini` CLI. Put the blocks of "Child session briefs" in its brief.
- A Gemini model takes its effort only from its model id. The id is the agent name without the prefix, for example
  `--model gemini-4-neon-high`. `--effort` does not change the effort of a Gemini model: to change it, change the id.
- An agent that is not in the table is never your own pick. Use it only when the user or a local override names it.

## Who does what

<!-- roles:start (written by generate.mjs) -->
| Role | Agent | Model | Applies when |
| --- | --- | --- | --- |
| Small settled coding | `rikclaude-agents:gpt-6.2-sol-xhigh` | `gpt-6.2-sol` | A fix round with exact findings, a rebase, PR or CI feedback. New code only if the brief lists the files and functions to add, in 5 source files or fewer. |
| Settled coding | `rikclaude-agents:opus-medium` | `claude-opus-5-5[1m]` | The brief settles the design and, for a bug, names the cause. Any size: split a large plan into parts. |
| Open coding | `rikclaude-agents:opus-high` | `claude-opus-5-5[1m]` | The coder must decide a design question, find the cause of a bug, or write model text or an eval rubric. |
| Throwaway code | `rikclaude-agents:sonnet-high` | `claude-sonnet-5-5[1m]` | Code that is not committed. If a bug in it can reach a user, it is Settled coding. |
| Code review | `rikclaude-agents:opus-high` | `claude-opus-5-5[1m]` | A PR, a branch, a commit or a diff, by an agent that did not write the code. |
| Second reviewer | `rikclaude-agents:gpt-6.2-astra-medium` | `gpt-6.2-astra` | With the Code review agent, on the first review only: a risky change, or above about 400 source lines. |
| Design or plan review | `rikclaude-agents:fable-high` + `rikclaude-agents:gpt-6.2-astra-medium` | `claude-fable-5-2[1m]` + `gpt-6.2-astra` | Before code exists. For the hardest, name `rikclaude-agents:fable-xhigh` in place of fable-high. |
| Research | `rikclaude-agents:opus-medium` | `claude-opus-5-5[1m]` | Fact-finding. Use `rikclaude-agents:opus-high` to reason through how code behaves, and `rikclaude-agents:fable-high` for the widest scope. |
| QA and browser checks | `rikclaude-agents:opus-high` | `claude-opus-5-5[1m]` | Release QA and browser checks of a change. |
| Exploration | `rikclaude-agents:sonnet-high` | `claude-sonnet-5-5[1m]` | Locating code or summarising a module. Or the built-in `Explore` agent. Across many files, `rikclaude-agents:opus-medium`. |
| Quick, cheap tasks | `rikclaude-agents:haiku-medium` | `claude-haiku-5-5[1m]` | Not for production code. |
<!-- roles:end -->

## Rules on the table

- Before you dispatch Open coding, name which of its three conditions holds. Size, the number of packages, shared
  exports and the risk of the area do not raise the tier.
- A fix round with one open item: split it. The open item is Open coding. The other items are Small settled coding.
- Delta after a fix round: you read it when it is up to about 200 source lines. Above that, one Code review agent,
  once. No second reviewer on a delta.
- Never dispatch Astra alone. Dispatch it in the same message as its partner, and merge their findings.
- Fable does not code and does not review code. An agent that wrote the code does not review it.
- Batch reviews: eight tasks, simple ones included, are a few review rounds, not eight reviews.
- The review rules of the user or the repository decide when a review happens and what is risky. This table decides
  who does it.

## Child session briefs

A child session does not get an agent prompt. Copy into its brief each block below whose `models` matches the
model of the session.

<!-- child-briefs:start (written by generate.mjs) -->
<child-brief models="gpt-*, gemini-*">
Load `SendMessage` with `ToolSearch` (`select:SendMessage`). You can message the coordinator at any point. If the code shows that the brief is wrong, stop, report it to the coordinator and end your turn. Do not invent an interface or a workaround. Do not widen the scope. List in your report each item that you left out. A rule in the brief about files, SSH, secrets or commands applies to your own tool calls. When a rule seems to block one step, send one question with your recommendation and continue with the work that it does not block.
</child-brief>

<child-brief models="gemini-*">
A claim about a provider, a count or a measurement gives its source: a quote of the docs, or the command and its output. Write each other claim as an assumption, under 'Not verified'. Cite each file as a path relative to the repository root, at the commit of the brief.
</child-brief>

<child-brief models="gpt-6.2-sol">
When the brief names a report file, write the report to it, and also give it as your final message.
</child-brief>
<!-- child-briefs:end -->

## Local overrides

If a section "Local trial overrides" follows this policy, its rows win over "Who does what".

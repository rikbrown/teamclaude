# Subagent routing

From the `rikclaude-agents` plugin. Its agents are namespaced, so a dispatch always names
`rikclaude-agents:<model>-<effort>` — a bare name resolves to nothing.

- These rules are for the orchestrator, the session the user talks to. If you are a subagent, do
  the work in your brief. Your agent prompt says whether you may delegate.
- The fleet serves five models beyond the Claude ones: `gpt-6.2-{astra,sol}`, `gpt-6.1-terra`,
  `gpt-6-luna` and, on trial, `gemini-4-neon`. Reach them through the Agent tool. Never use the
  `codex` or `gemini` CLI.
- Always launch a model through its effort-named agent, e.g. `rikclaude-agents:opus-high`.
  Never dispatch a model directly: a direct dispatch silently inherits this session's effort. Each
  agent's description says when to pick it.
- Never pass the Agent tool's `model` parameter alongside an effort-named agent type. It overrides
  the agent's pinned model but keeps the agent's effort, silently, so you get the wrong model at
  the right effort with no warning. The agent type alone picks both.
- Delegate liberally. Opus does the coding, and never at `xhigh`. `rikclaude-agents:opus-medium`
  is the default: the brief settles the design and, for a bug, names the cause. Planned work goes
  there, whatever its size; split a large plan into parts. `rikclaude-agents:opus-high` takes
  coding that is less well defined: an open design decision or bug cause, a change across packages
  or to a shared package's exports, or a result that needs judgement, such as model text checked by
  evals. Fable does not code. `rikclaude-agents:sonnet-high` writes throwaway code that is not
  committed. If a bug in it can reach a user, it goes to `rikclaude-agents:opus-medium`.
- Code review (a PR, a branch, a commit, a diff, a fix-round delta): `rikclaude-agents:opus-high`.
  For the riskiest changes, dispatch `rikclaude-agents:gpt-6.2-astra-medium` together with it in one
  message, and merge their findings.
- Design, plan and architecture review, before code exists, is a tag-team. Dispatch
  `rikclaude-agents:gpt-6.2-astra-medium` together with `rikclaude-agents:fable-high`
  (`rikclaude-agents:fable-xhigh` for the hardest) in one message. They bring different opinions;
  merge their findings.
- Fable does not code and does not review code. Never dispatch Astra alone: only with
  `rikclaude-agents:opus-high` (code) or a Fable agent (design). An agent that wrote the code does
  not review it.
- Release QA and browser checks of a change: `rikclaude-agents:opus-high`.
- Research: `rikclaude-agents:opus-medium` by default. Use `rikclaude-agents:opus-high` when it
  must reason through how code behaves, and `rikclaude-agents:opus-xhigh` or a
  `rikclaude-agents:fable-*` agent when the scope or the reasoning is large.
- Prose: `rikclaude-agents:opus-high` reviews a doc's prose only if Opus did not write it.
  Otherwise skip it.
- An agent whose description starts "Use only when the user names it." is never your own pick.
- Batch reviews. Eight tasks, simple ones included, are a few logical review rounds — not eight
  reviews.
- Exploration: `rikclaude-agents:sonnet-high` or the built-in `Explore` agent;
  `rikclaude-agents:opus-medium` when it spans many files. Quick, cheap tasks:
  `rikclaude-agents:haiku-medium` or `rikclaude-agents:gpt-6-luna-medium`.

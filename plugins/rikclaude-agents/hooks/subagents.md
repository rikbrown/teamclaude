# Subagent routing

From the `rikclaude-agents` plugin. Its agents are namespaced, so a dispatch always names
`rikclaude-agents:<model>-<effort>` — a bare name resolves to nothing.

- These rules are for the orchestrator, the session the user talks to. If you are a subagent, do
  the work in your brief. Your agent prompt says whether you may delegate.
- The fleet serves four models beyond the Claude ones: `gpt-5.6-terra` and
  `gpt-6-{astra,sol,luna}`. Reach them through the Agent tool. Never use the `codex` CLI.
- Always launch a model through its effort-named agent, e.g. `rikclaude-agents:opus-high`.
  Never dispatch a model directly: a direct dispatch silently inherits this session's effort. Each
  agent's description says when to pick it.
- Never pass the Agent tool's `model` parameter alongside an effort-named agent type. It overrides
  the agent's pinned model but keeps the agent's effort, silently, so you get the wrong model at
  the right effort with no warning. The agent type alone picks both.
- Delegate liberally. Opus does the coding: `rikclaude-agents:opus-high` when the brief settles
  the design. Work that is already planned goes there, whatever its size; split a large plan
  into parts. `rikclaude-agents:opus-xhigh` only when the brief leaves real design decisions
  open, or for a hard bug with no known cause. If you planned the work, its thinking is done; do
  not pay for it again at `xhigh`. Fable does not code. `rikclaude-agents:opus-medium` writes
  committed internal tooling that only developers run, such as dev CLIs, CI and build config, or
  evals. `rikclaude-agents:sonnet-high` writes throwaway code that is not committed. If a bug in
  it can reach a user, it goes to `rikclaude-agents:opus-high`.
- Architectural and full-branch reviews are a tag-team. Dispatch `rikclaude-agents:gpt-6-astra-medium`
  together with `rikclaude-agents:fable-high` (`rikclaude-agents:fable-xhigh` for the hardest) in
  one message. Never dispatch Astra alone. They bring different opinions; merge their findings.
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

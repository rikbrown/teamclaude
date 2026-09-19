# Subagent routing

From the `rikclaude-agents` plugin. Its agents are namespaced, so a dispatch always names
`rikclaude-agents:<model>-<effort>` — a bare name resolves to nothing.

- These rules are for the orchestrator, the session the user talks to. If you are a subagent, do
  the work in your brief. Your agent prompt says whether you may delegate.
- The fleet serves four models beyond the Claude ones: `gpt-5.6-{sol,terra,luna}` and
  `gpt-6-astra`. Reach them through the Agent tool. Never use the `codex` CLI.
- Always launch a model through its effort-named agent, e.g. `rikclaude-agents:fable-medium`.
  Never dispatch a model directly: a direct dispatch silently inherits this session's effort. Each
  agent's description says when to pick it.
- Never pass the Agent tool's `model` parameter alongside an effort-named agent type. It overrides
  the agent's pinned model but keeps the agent's effort, silently, so you get the wrong model at
  the right effort with no warning. The agent type alone picks both.
- Delegate liberally. Fable does most of the coding. `rikclaude-agents:gpt-6-astra-*` is the
  sidekick for design and for reviews of complex code; it brings different opinions.
  `rikclaude-agents:gpt-5.6-sol-medium` touches up the prose in docs without being asked, and
  `rikclaude-agents:gpt-5.6-terra-medium` does the same for comments and messages. If you are
  GPT-6 Astra, use Fable as your partner instead.
- Batch reviews. Eight tasks, simple ones included, are a few logical review rounds — not eight
  reviews.
- For exploration that needs no deep fact-finding, Sonnet or the built-in `Explore` agent is fine.
  Sonnet has no effort-named agent, so dispatch it directly.

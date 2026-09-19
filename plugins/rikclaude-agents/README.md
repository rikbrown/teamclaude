# rikclaude-agents

One subagent per model **and effort level**, so a dispatch pins both. The Agent tool's `model`
parameter is an alias enum with no effort control, so dispatching a model directly inherits
whatever effort the parent session happens to run at. Only an agent definition can pin the pair.

The agents name models a [TeamClaude](../../README.md) fleet serves — `fable`, `opus`, and the
`gpt-*` ids a [Codex sidecar](../../docs/openai.md) answers. They resolve to nothing on a plain
Claude Code install.

Full write-up, install and team pre-seeding: [docs/agents.md](../../docs/agents.md).

```
/plugin marketplace add rikbrown/teamclaude
/plugin install rikclaude-agents@rikclaude
```

## What is in here

| Path | What it does |
| --- | --- |
| `agents/*.md` | The roster. Dispatched as `rikclaude-agents:<model>-<effort>` — Claude Code namespaces plugin agents, and a bare name resolves to nothing |
| `hooks/subagents.md` | The routing policy: which model to pick for what, and the traps around dispatching them |
| `hooks/hooks.json` | A `SessionStart` command hook that prints that file. Plain stdout on `SessionStart` is added to the session context, and a plugin's own `CLAUDE.md` is not loaded, so this is how always-on policy ships. It `cat`s one file and always exits 0 |
| `generate.mjs` | Writes `agents/` from a single roster array |

## Changing the roster

Edit the `AGENTS` array in `generate.mjs` — it is the source of truth for the files, the
description text and the nesting rule each agent gets — then:

```bash
node plugins/rikclaude-agents/generate.mjs           # rewrite agents/
node plugins/rikclaude-agents/generate.mjs --check   # exit 1 if any file is stale or missing
```

`--check` also names any `.md` in `agents/` it did not write, so a renamed model cannot leave a
ghost agent shipping behind it. `test/plugin-agents.test.js` runs `--check` in CI, so a roster
edit that was not regenerated fails the build.

Claude Code announces agents by name only, so an edited description reaches the orchestrator in a
**new** session, not the one you edited it in.

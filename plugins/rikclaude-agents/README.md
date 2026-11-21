# rikclaude-agents

One subagent per model **and effort level**, so a dispatch pins both. The Agent tool's `model`
parameter is an alias enum with no effort control, so dispatching a model directly inherits
whatever effort the parent session happens to run at. Only an agent definition can pin the pair.

The agents name models a [TeamClaude](../../README.md) fleet serves. GPT agents use a
[Codex sidecar](../../docs/openai.md). Gemini agents use a separate route. A plain Claude Code install cannot serve
those GPT or Gemini model IDs.

Full write-up, install and team pre-seeding: [docs/agents.md](../../docs/agents.md).

```
/plugin marketplace add rikbrown/teamclaude
/plugin install rikclaude-agents@rikclaude
```

## What is in here

| Path | What it does |
| --- | --- |
| `agents/*.md` | Agent definitions. Dispatch them as `rikclaude-agents:<model>-<effort>`. Each description names the agent's role. |
| [`hooks/routing.md`](hooks/routing.md) | The routing policy and role table. Use the table to select an agent. |
| `hooks/hooks.json` | A `SessionStart` command hook that prints the policy, then any local overrides. Claude Code adds the output to the session context. The hook skips missing files and exits 0. |
| `generate.mjs` | Writes `agents/` from `AGENTS` and the role table from `ROLES`. |

## Local routing overrides

Use `~/.claude/rikclaude-agents.local.md` to trial a routing change before it goes into the plugin.
Start the file with `# Local trial overrides`. Add a table with the columns Role, Change, When, and Report.
The hook prints this file after the policy. Its rows take precedence over the role table.

## Changing the roster or routing

Edit `AGENTS` in `generate.mjs` to change the roster, descriptions, or nesting rules. Edit `ROLES` to change the
role table. Then run:

```bash
node plugins/rikclaude-agents/generate.mjs           # rewrite agents/ and the role table
node plugins/rikclaude-agents/generate.mjs --check   # exit 1 if generated content is stale or missing
```

`--check` also reports any extra `.md` file in `agents/`. The plugin would ship those files too.
`test/plugin-agents.test.js` runs `--check` in CI.

Claude Code announces agents by name only, so an edited description reaches the orchestrator in a
**new** session, not the one you edited it in.

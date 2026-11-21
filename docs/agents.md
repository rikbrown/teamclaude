# Subagents

A Claude Code plugin that ships in this repo: **one named subagent per model and effort level**,
plus the routing policy that goes with them. Install it and a session can say "dispatch
`rikclaude-agents:gpt-6.2-astra-high`" and get exactly that model at exactly that effort, every
time.

The models it names are the ones a TeamClaude fleet serves — `claude-fable-5-2[1m]`, `claude-opus-5-5[1m]`, `claude-sonnet-5-5[1m]` and `claude-haiku-5-5[1m]` for Claude,
`gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6-luna` and `gpt-6.1-terra` through the [Codex sidecar](openai.md), and, on trial,
`gemini-4-neon-medium`, `gemini-4-neon-high` and `gemini-4-neon-xhigh` through a `gemini-*` route. On a plain Claude Code install, with no fleet
behind it, the GPT and Gemini agents resolve to model ids nothing can answer.

## Why an agent definition and not the `model` parameter

The Agent tool takes a per-call `model` parameter, and it looks like it solves this. It does not:

- It is an **alias enum** — `sonnet | opus | haiku | fable` — so it cannot name a custom model id
  at all. `gpt-6.2-astra` is not on the list.
- It carries **no effort**. A dispatch that names a model inherits the parent session's effort,
  silently. Ask for a cheap second opinion from a session running at `xhigh` and you buy an `xhigh`
  second opinion.

An agent **definition** pins both, in its frontmatter:

```yaml
---
name: gpt-6.2-astra-high
description: GPT-6.2 Astra at high effort. Not in the routing table. Use only when the user or a local override names it. A design or plan review at higher effort.
model: gpt-6.2-astra
effort: high
---
```

So the roster is one file per (model, effort) pair worth choosing between, and the orchestrator
picks by **name**. Which is also the trap the plugin closes: the `model` parameter and an
effort-named agent type must never be passed together. The parameter overrides the agent's model
and keeps the agent's effort, with no warning — the wrong model at the right effort.

## Install

```shell
/plugin marketplace add rikbrown/teamclaude
/plugin install rikclaude-agents@rikclaude
```

The install opens the plugin's details and asks for a scope. Pick **user** — agents are about how
you work, not about one repository, and user scope applies them across every project. From a shell
instead, which installs to user scope unless you say otherwise:

```bash
claude plugin install rikclaude-agents@rikclaude
```

The marketplace lives at `.claude-plugin/marketplace.json` in this repo and points at
`./plugins/rikclaude-agents`. A relative source like that is resolved against a local copy of the
marketplace, so it works when the marketplace is added from GitHub or a local path — but **not**
from a direct URL to the `marketplace.json` file, because only that one file gets downloaded.

Run `/agents` in a new session to confirm the roster loaded. A short list means a file failed to
parse.

## The roster

Use the [routing table](../plugins/rikclaude-agents/hooks/routing.md#who-does-what) to choose an agent.
Each description names its role. The roster includes these model and effort pairs:

| Model | Agents |
| --- | --- |
| `claude-opus-5-5[1m]` | `opus-medium`, `opus-high`, `opus-xhigh` |
| `claude-sonnet-5-5[1m]` | `sonnet-high`, `sonnet-xhigh` |
| `claude-fable-5-2[1m]` | `fable-medium`, `fable-high`, `fable-xhigh` |
| `gpt-6.2-astra` | `gpt-6.2-astra-medium`, `gpt-6.2-astra-high` |
| `claude-haiku-5-5[1m]` | `haiku-medium` |
| `gpt-6-luna` | `gpt-6-luna-medium` |
| `gpt-6.2-sol` | `gpt-6.2-sol-xhigh` |
| `gpt-6.1-terra` | `gpt-6.1-terra-medium` |
| `gemini-4-neon-medium`, `gemini-4-neon-high`, `gemini-4-neon-xhigh` | `gemini-4-neon-medium`, `gemini-4-neon-high`, `gemini-4-neon-xhigh` |

Use an agent outside the routing table only when the user or a local override names it. The `byName` flag adds
this restriction to its description before the role text.

Each prompt tells the agent if it can launch subagents. GPT and Gemini prompts also tell the agent how to
contact the coordinator, report a problem in the brief, and stay within the brief. Gemini prompts also require
sources for claims about providers, counts, and measurements. Gemini agents label other claims as assumptions
under `Not verified` and cite files by path from the repository root at the commit of the brief.
If the brief names a report file, Sol prompts tell the agent to write its report to that file and give the report as its
final message.

Every `gpt-*` name has to exist in your fleet's [`customModels`](configuration.md) and be served by
a sidecar that knows it, or the dispatch reaches a model id nothing answers. See
[OpenAI models](openai.md) for the sidecar setup; the ids there and the ids here are the same list.

The `gemini-*` agents need a route that sends `gemini-*` to a translating proxy for a Google AI
subscription. The trial uses [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy)
as a backend account (`upstream` set to the proxy, `accessToken` set to the proxy's `API_KEY`). That proxy
holds the Google sign-in and picks the account itself, so TeamClaude does not see the Google quota yet.

A Gemini model takes its effort only from its model id, so each `gemini-*` agent pins the full id, such as
`gemini-4-neon-high`. The `effort` of the agent file and the `--effort` flag of a child session do not change it.
The routing policy states this rule for a child session.

## The routing policy

The [routing policy](../plugins/rikclaude-agents/hooks/routing.md) tells the orchestrator which agent to use.
Claude Code does not load a plugin's `CLAUDE.md` as project context. The `SessionStart` command hook in
`hooks/hooks.json` prints `hooks/routing.md` instead. Claude Code adds the output to the session context at launch,
after `/clear`, and after compaction. The hook skips missing files and exits 0.

A child session does not get an agent prompt. The routing policy prints the model-specific paragraphs in
"Child session briefs" so the orchestrator can copy them into the brief. `generate.mjs` writes that section.

## Local routing overrides

Use `~/.claude/rikclaude-agents.local.md` to trial a routing change before it goes into the plugin.
Start the file with `# Local trial overrides`. Add a table with the columns Role, Change, When, and Report.
The hook prints this file after the policy. Its rows take precedence over the role table.

## Namespacing, and your old agent files

Claude Code namespaces plugin agents as `<plugin>:<agent>`, so the dispatchable name is
`rikclaude-agents:fable-medium`, never `fable-medium`. The frontmatter `name:` stays bare; the
prefix is added for you. Every rule in the plugin that names an agent spells the prefix out, for
the same reason: a bare name resolves to nothing, and the caller falls back to the effort-less
direct dispatch the whole thing exists to prevent.

If you hand-copied these agents into `~/.claude/agents/` before the plugin existed, **delete those
copies**. Agent definitions resolve highest-scope-first:

| Priority | Source |
| --- | --- |
| 1 (highest) | Managed settings |
| 2 | `--agents` CLI flag |
| 3 | `.claude/agents/` (project) |
| 4 | `~/.claude/agents/` (you, everywhere) |
| 5 (lowest) | A plugin's `agents/` |

Plugin agents are last. Your old files will not break the plugin's — the names differ by the prefix
— but you will see both sets in `/agents`, and the bare ones are exactly what an effort-less
dispatch grabs.

The same ordering is why [`customModelAgents`](configuration.md) is **off** by default in this
fork. It injects one plain agent per custom model through `--agents`, which is priority 2: those
agents cover the same models, pin no effort, and sit above everything on disk. Turn it on only for
a fleet that defines no agents of its own.

## Seeding it for a team

Add the marketplace in a settings file and nobody has to run the `marketplace add` themselves.
Project scope is `.claude/settings.json` in the repo; for a whole machine, the same keys work in
`~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "teamclaude": {
      "source": {
        "source": "github",
        "repo": "rikbrown/teamclaude"
      }
    }
  },
  "enabledPlugins": {
    "rikclaude-agents@rikclaude": true
  }
}
```

Claude Code registers the marketplace once the person trusts the repository folder. It does not
install a plugin that comes from an external source on their behalf — it reports the plugin as not
installed and prints the `claude plugin install` line to run. So this removes a step, not all of
them; say so when you hand it to people.

## Changing the roster or routing

Edit `AGENTS` in `plugins/rikclaude-agents/generate.mjs` to change the roster, descriptions, or nesting rules.
Edit `ROLES` to change the role table. Then run:

```bash
node plugins/rikclaude-agents/generate.mjs           # rewrite agents/ and the generated routing sections
node plugins/rikclaude-agents/generate.mjs --check   # exit 1 if generated content is stale or missing
```

`--check` also reports any extra `.md` file in `agents/`. The plugin would ship those files too.
`test/plugin-agents.test.js` runs `--check` in CI.

Claude Code announces agents by name only, so an edited description reaches the orchestrator in a
**new** session, not the one you edited it in.

# Subagents

A Claude Code plugin that ships in this repo: **one named subagent per model and effort level**,
plus the routing policy that goes with them. Install it and a session can say "dispatch
`rikclaude-agents:gpt-6-astra-high`" and get exactly that model at exactly that effort, every
time.

The models it names are the ones a TeamClaude fleet serves — `fable[1m]` and `claude-opus-5-5[1m]` for Claude,
`gpt-6-astra` and the `gpt-5.6-*` family through the [Codex sidecar](openai.md). On a plain Claude
Code install, with no fleet behind it, the GPT agents resolve to model ids nothing can answer.

## Why an agent definition and not the `model` parameter

The Agent tool takes a per-call `model` parameter, and it looks like it solves this. It does not:

- It is an **alias enum** — `sonnet | opus | haiku | fable` — so it cannot name a custom model id
  at all. `gpt-6-astra` is not on the list.
- It carries **no effort**. A dispatch that names a model inherits the parent session's effort,
  silently. Ask for a cheap second opinion from a session running at `xhigh` and you buy an `xhigh`
  second opinion.

An agent **definition** pins both, in its frontmatter:

```yaml
---
name: gpt-6-astra-high
description: GPT-6 Astra at high effort. Engineering sidekick, on par with Fable. …
model: gpt-6-astra
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

Descriptions in `plugins/rikclaude-agents/agents/` are authoritative — the orchestrator reads them
at the moment it picks an agent, and they say more than this table does.

| Model | Agents | Shape of the work |
| --- | --- | --- |
| `fable[1m]` | `fable-medium`, `fable-high`, `fable-xhigh` | Engineering sidekick on par with GPT-6 Astra: full-branch, architectural and design review, `xhigh` for the most challenging. Not code |
| `claude-opus-5-5[1m]` | `opus-high`, `opus-xhigh` | The coding: well-defined work at `high`, larger or ambiguous work at `xhigh`. Also fact-finding |
| `gpt-6-astra` | `gpt-6-astra-medium`, `gpt-6-astra-high` | Engineering sidekick on par with Fable: full-branch, architectural and design review |
| `gpt-5.6-sol` | `gpt-5.6-sol-medium`, `gpt-5.6-sol-xhigh` | Prose refinement of docs; light or interim code review |
| `gpt-5.6-terra` | `gpt-5.6-terra-medium` | Prose refinement of comments and messages |
| `gpt-5.6-luna` | `gpt-5.6-luna-medium` | Haiku-level tasks |

Each prompt also carries a **nesting rule** — whether that agent may launch agents of its own, only
when its brief says so, or not at all. Without it, a subagent that reaches the routing policy takes
"delegate liberally" as an instruction to itself, and a two-line task grows a tree.

Every `gpt-*` name has to exist in your fleet's [`customModels`](configuration.md) and be served by
a sidecar that knows it, or the dispatch reaches a model id nothing answers. See
[OpenAI models](openai.md) for the sidecar setup; the ids there and the ids here are the same list.

## The routing policy

Knowing the agents exist is half of it. Which one to reach for, when to batch reviews, and the
`model`-parameter trap above are policy that spans the whole roster, and a plugin cannot ship a
`CLAUDE.md` — one at a plugin root is not loaded as project context.

So it arrives as a **`SessionStart` command hook**. Claude Code adds a hook's plain stdout to the
session context on `SessionStart` (one of only four events it does that for), and a `command` hook
on that event runs at launch, so the policy is there from the first turn. `hooks/hooks.json` runs
one `cat` of `hooks/subagents.md` and always exits 0, so a missing or unreadable file costs the
session nothing. No matcher, so it also fires after `/clear` and after a compaction, where the
policy would otherwise be lost.

Read it — it is short, and it is injected into every session you have:
[`plugins/rikclaude-agents/hooks/subagents.md`](../plugins/rikclaude-agents/hooks/subagents.md).

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

## Changing the roster

`plugins/rikclaude-agents/generate.mjs` holds the `AGENTS` array and is the single source of truth
for the files, the description text and the nesting rule. Edit it, then:

```bash
node plugins/rikclaude-agents/generate.mjs           # rewrite agents/
node plugins/rikclaude-agents/generate.mjs --check   # exit 1 if any file is stale or missing
```

`--check` also names any `.md` in `agents/` the script did not write, so a renamed model cannot
leave a ghost agent shipping behind it. `test/plugin-agents.test.js` runs `--check` in CI, so an
edit that was not regenerated fails the build.

Keep the roster to efforts somebody would actually choose between: every agent costs the
orchestrator its description text at pick time. Commented-out rows in `AGENTS` are the ones that
did not earn their place.

Claude Code announces agents by name only, so an edited description reaches the orchestrator in a
**new** session, not the one you edited it in.

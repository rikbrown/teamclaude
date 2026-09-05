# TeamClaude

> **Fork notice (rikbrown).** This fork adds four features and two reload fixes on top of
> [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude):
>
> - **[OpenAI models via a Codex sidecar](docs/openai.md)** (`sidecars` + `customModels`, opt-in):
>   route `gpt-*` requests through a supervised local translating proxy to a ChatGPT subscription,
>   under real model names — `/model gpt-5.6-sol` in the picker and typed, correct 272k context
>   sizing, and dispatchable GPT subagents — while Claude traffic stays on the Claude accounts.
> - **[Soonest-weekly rotation](docs/routing.md#soonest-weekly-rotation)** (`soonestWeekly`, opt-in): rank
>   equal-priority accounts by the weekly window that governs the requested model, continuously — preempt the
>   current account when another resets more than `poolHours` sooner, and balance `distributeSessions` within
>   that pool instead of across all accounts. Spends the quota closest to refreshing first, so a window no
>   longer rolls over with quota unspent.
> - **[Burn-rate projection](docs/quota.md#burn-rate-projection)** (`projection`, on by default): sample each
>   bucket's consumption over a rolling window and tag every account row with whichever window binds
>   first — `Ses TTL 38m` when it runs out before it resets, `Wk 22% unspent` when the reset arrives
>   first and that much expires. A readout only: no selection code reads it.
> - **[Session titles](docs/usage.md#session-titles-in-the-activity-log)** (`sessionTitles`, off by default):
>   name each activity row after the Claude Code session that sent the request, reading the title
>   `/rename` writes and the one Claude Code generates. A session with neither keeps its short id.
> - `soonestWeekly` and `distributeSessions` changes now apply on config reload; upstream applies
>   `distributeSessions` only at startup.
>
> Setup and use of each: [Fork features](#fork-features).
>
> Published as [`@rikcodes/teamclaude`](https://www.npmjs.com/package/@rikcodes/teamclaude); self-update
> tracks that package, so installs of this fork can never be replaced by an upstream release.
>
> ```bash
> npm install -g @rikcodes/teamclaude
> ```
>
> Already have upstream installed globally? Run `npm uninstall -g @karpeleslab/teamclaude` first —
> both packages provide the `teamclaude` command.
>
> Branch: `rik/soonest-weekly-pool`. Everything else matches upstream.

[![CI](https://github.com/rikbrown/teamclaude/actions/workflows/ci.yml/badge.svg?branch=rik/soonest-weekly-pool)](https://github.com/rikbrown/teamclaude/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@rikcodes/teamclaude.svg)](https://www.npmjs.com/package/@rikcodes/teamclaude)
[![node](https://img.shields.io/node/v/@rikcodes/teamclaude.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

It sits between Claude Code and the Anthropic API, holds several Claude Max (or API key) accounts, and moves to the next one when the current account gets close to its session or weekly limit. The session keeps running instead of stopping on a 429.

![TeamClaude TUI](screenshots/teamclaude.png)

## Quick start

Node.js 20+ required.

```bash
npm install -g @rikcodes/teamclaude

teamclaude login     # browser OAuth, run it once per account
teamclaude server    # start the proxy, shows the TUI
teamclaude run       # in another terminal: Claude Code through the proxy
```

Already logged into Claude Code? `teamclaude import` takes its credentials instead of a fresh OAuth round. API keys, and one email holding accounts in several orgs, are covered in [docs/accounts.md](docs/accounts.md).

## What it does

- Rotates to the next account when the 5h session or 7d weekly bucket reaches the threshold (98% by default), preferring the account whose weekly quota resets soonest.
- Optionally spends the account whose weekly window resets soonest **first**, preempting the current account when another resets more than `poolHours` sooner, so a window stops rolling over with quota unspent (`soonestWeekly`, this fork).
- Projects each quota window's burn rate against its reset, so a row says `Ses TTL 38m · Wk 22% unspent` instead of leaving you to read it off a bar (`projection`, this fork).
- Tracks the per-model weekly cap separately, so an account out of Fable quota is skipped for Fable requests and still serves Opus and Sonnet.
- Tells a spent quota bucket apart from a per-minute rate limit and only rotates on the first one. Rotating on a rate limit would just move the burst to the next account and drop the warm cache, so it paces the same account instead.
- Paces requests onto a freshly switched account, so a herd of agents failing over at the same instant doesn't throttle it and cascade down the fleet.
- TUI with quota bars, reset countdowns, activity log, and settings you can change while it runs, including adding and removing accounts.
- Catches hardcoded `api.anthropic.com` endpoints (the Claude Design MCP, for one) through a local MITM forward proxy, not only what `ANTHROPIC_BASE_URL` covers.
- Holds the request open until quota resets instead of returning 429 when every account is spent, so an unattended run finishes on its own (`holdSeconds`, off by default).
- Refreshes OAuth tokens before they expire and writes them back to config. Client refreshes pass through untouched.
- Takes any Anthropic-compatible API (DeepSeek, GLM) as a low-priority fallback for when the Claude accounts are done.
- Serves OpenAI models next to Claude ones — a supervised local sidecar translates `gpt-*` requests onto a ChatGPT subscription, with real model names in `/model` and GPT subagents dispatchable from a Claude parent (`sidecars` + `customModels`, this fork).
- No dependencies. Node built-ins only.

## Everyday commands

```bash
teamclaude accounts          # accounts with tier and token status
teamclaude status            # live proxy status, needs a running server
teamclaude disable <name>    # pause an account without removing it
teamclaude priority <name> 1 # rotation order, lower = preferred
teamclaude alias --install   # make plain `claude` go through the proxy
teamclaude help              # everything else
```

Full reference: [docs/usage.md](docs/usage.md).

## Configuration

Config is at `~/.config/teamclaude.json` (`$XDG_CONFIG_HOME` honoured) and is meant to be hand-editable. A proxy API key is generated on first use. Observed quota goes to a separate `teamclaude.state.json` next to it, safe to delete since quota gets re-learned from traffic.

Every field, plus environment variables and network tuning: [docs/configuration.md](docs/configuration.md).

## How it works

1. Claude Code talks to the local proxy instead of `api.anthropic.com`.
2. The proxy picks an eligible account, injects that account's real token, and rewrites `account_uuid` in the body to match.
3. `anthropic-ratelimit-unified-*` response headers feed the session (5h) and weekly (7d) quota view, which survives a restart.
4. At the threshold, rotation moves on. On a quota 429 the request is resent on another account, so the client never sees the limit while some account still has headroom.
5. Expiring tokens, transient network errors and client token refreshes are handled inside the proxy, so none of them interrupt the session.

Step-by-step lifecycle: [docs/routing.md](docs/routing.md#request-lifecycle).

## Fork features

How to set up and use the features in this fork. Everything else in this README is upstream behaviour.

### OpenAI models via a Codex sidecar

A Claude Code session can use OpenAI models alongside the Claude accounts. They are billed to a ChatGPT Plus/Pro subscription and use their real model names in the same session. TeamClaude does not translate the wire format itself. A local **sidecar** does this: [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) speaks `/v1/messages` on the front and the Codex Responses API on the back. TeamClaude starts and supervises this process. It sends every `gpt-*` request to the sidecar and keeps every other request on the Claude accounts.

**1. Install the sidecar and log it into your ChatGPT account** (one time):

```bash
brew install raine/claude-code-proxy/claude-code-proxy
claude-code-proxy codex auth login
```

**2. Connect it** — add four pieces to `~/.config/teamclaude.json`:

```json
{
  "sidecars": [
    { "name": "codex", "command": ["claude-code-proxy", "serve", "--no-monitor", "--port", "18765"] }
  ],
  "accounts": [
    { "name": "codex", "type": "oauth", "accessToken": "unused-local-sidecar",
      "upstream": "http://127.0.0.1:18765", "priority": 100 }
  ],
  "routes": [
    { "name": "codex", "match": ["gpt-*"], "accounts": ["codex"] },
    { "name": "anthropic", "match": ["*"], "accounts": ["your-claude-account", "..."] }
  ],
  "customModels": [
    { "model": "gpt-5.6-sol",   "label": "GPT-5.6 Sol",   "contextTokens": 272000 },
    { "model": "gpt-5.6-terra", "label": "GPT-5.6 Terra", "contextTokens": 272000 },
    { "model": "gpt-5.6-luna",  "label": "GPT-5.6 Luna",  "contextTokens": 272000 }
  ]
}
```

- `sidecars` — the process that TeamClaude owns. It starts with the server, restarts with backoff after a crash, and stops on shutdown. Its pid, restart count and latest stderr lines are in `teamclaude status --json` under `sidecars`.
- `accounts` — the sidecar as a [third-party backend account](docs/accounts.md#third-party-backend-accounts). The token is a placeholder because the sidecar uses its own Codex login for authentication. `priority: 100` is the convention for third-party backends. The routes determine what reaches it.
- `routes` — sends `gpt-*` to the sidecar. **Keep the catch-all `*` route.** Without it, the sidecar joins the exhaustion-fallback pool. A spent Claude fleet would then silently send Claude-model requests to the sidecar, which maps `claude-*` names onto GPT models. With the route, a request can reach a GPT model only when it asks for one by name.
- `customModels` — the rows that make the models visible to Claude Code (next section).

**3. Restart the server.** `teamclaude status --json` should show the sidecar as `running`. If it enters a crash loop, `stderrTail` explains why — the usual cause is that the sidecar is not logged in.

#### How models get into Claude Code

Claude Code offers only models that it knows, and it does not know `gpt-*`. `customModels` closes this gap. Each row contains a model id that the proxy can serve, an optional picker label and description, and the model's context window.

At launch, `teamclaude run` — and the `claude` alias, which passes through `run` — gives these rows to Claude Code:

| Row field | Where it ends up |
| --- | --- |
| `model`, `label`, `description` | A `/model` picker row under the **real** model id (`--settings`), so `/model gpt-5.6-sol` works picked or typed |
| `model` | A dispatchable subagent named after the model (`--agents`), so "dispatch a `gpt-5.6-terra` subagent" works from a Claude parent |
| `contextTokens` | `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, set to the largest value across rows, so Claude Code compacts at the real window instead of assuming 200k |

For tools that spawn `claude` themselves, `teamclaude env` can set only environment variables. It carries the window and `ANTHROPIC_CUSTOM_MODEL_OPTION` for the **first** row. For GPT subagents under `env`, create `~/.claude/agents/<name>.md` with `model: gpt-5.6-terra` in its frontmatter.

Each request is routed by the model name in its body, so one session can freely mix models: use `claude --model gpt-5.6-sol` for a whole session, `/model gpt-5.6-sol` during a session, or a Claude parent that dispatches a GPT subagent.

**To add a model:**

1. Check that your sidecar build lists it: `curl -s http://127.0.0.1:18765/v1/models`. The sidecar has its own allow-list and rejects any id that it does not know, regardless of the TeamClaude configuration. Upgrade the sidecar if the id is missing.
2. Add a `customModels` row. Codex publishes the window for each model as `context_window` in `~/.codex/models_cache.json`; copy it to `contextTokens`.
3. Start a new `teamclaude run` session. The rows are read at launch, so you do not need to restart the server. If you upgraded the sidecar binary, restart the server — or send `SIGTERM` to the sidecar process and let the supervisor restart it with the new binary.

Claude Code prints one `[claude-code:unrecognized_model]` line to stderr for each custom model. This is expected; suppressing it would lose the correct context window. The quota bars for the sidecar account show `unknown` unless the sidecar forwards Codex's rate-limit headers — see [Quota](docs/openai.md#quota). Keep the sidecar on loopback, and use **one** ChatGPT subscription for each person. Pooling several subscriptions is the pattern that OpenAI's fraud systems target ([terms of service](docs/openai.md#terms-of-service)).

Full details: [docs/openai.md](docs/openai.md).

### Soonest-weekly rotation

Default selection is sticky. It re-ranks only when the current account is exhausted, so a weekly window can expire with unused quota. `soonestWeekly` re-ranks continuously. Among equal-priority accounts, the one whose governing weekly window resets soonest is used first. It preempts the current account when another account resets more than `poolHours` sooner.

```json
"soonestWeekly": { "enabled": true, "poolHours": 12 }
```

`distributeSessions` works with this setting. New sessions balance across that pool instead of across all equal-priority accounts. Both settings take effect when the configuration reloads (upstream applies `distributeSessions` only at startup). Details: [Routing](docs/routing.md#soonest-weekly-rotation).

### Burn-rate projection

This feature is on by default. Each account row shows which window binds first: `Ses TTL 38m` when the session bucket runs out before it resets, or `Wk 22% unspent` when the weekly reset arrives first and that amount of quota expires. This is a readout only; no selection code reads it. Tune or disable it with `projection: { enabled, windowMinutes, wasteFloor }`. Details: [Quota](docs/quota.md#burn-rate-projection).

### Session titles

This feature is off by default. Activity rows use the name of the Claude Code session that sent the request. They use the title written by `/rename` or the title that Claude Code generates; a session with neither keeps its short id. Toggle the feature from the settings screen (**g** → Session titles) or with `sessionTitles: { enabled, width, projectsDir }`. Details: [Usage](docs/usage.md#session-titles-in-the-activity-log).

## Documentation

| Page | Contents |
| --- | --- |
| [Accounts](docs/accounts.md) | OAuth login, import, API keys, multiple orgs, third-party backends |
| [Usage](docs/usage.md) | Server and TUI, running Claude Code, shell alias, command reference, logging |
| [Routing](docs/routing.md) | Rotation, the two kinds of 429, storm control, model routes, session spreading, pinning, prompt cache |
| [Quota](docs/quota.md) | Quota probe, keep-warm, holding on exhaustion |
| [OpenAI models](docs/openai.md) | Codex sidecar setup, custom model registration, GPT subagents, limitations |
| [Configuration](docs/configuration.md) | Config format, every field, environment variables, network tuning |
| [Proxy modes](docs/proxy-modes.md) | MITM forward proxy, sx.org residential egress |
| [Compliance](docs/compliance.md) | Terms of service notes |

## Releasing this fork

Versions are `<upstream base>-rik.<n>`, e.g. `1.1.13-rik.1`. The self-updater orders that tail, so every publish reaches existing installs within a day.

1. Rebase onto the upstream release you want as the base, if any.
2. Bump `version` in `package.json` and commit.
3. Push to `rik/soonest-weekly-pool` — the Publish workflow runs the tests, publishes to npm, and cuts a GitHub release.

The workflow authenticates with npm Trusted Publishing (OIDC), which needs a one-time setup on npmjs.com: `@rikcodes/teamclaude` → Settings → Trusted Publisher → GitHub Actions, owner `rikbrown`, repo `teamclaude`, workflow `publish.yml`. Until that exists, publish by hand:

```bash
pnpm publish --publish-branch rik/soonest-weekly-pool --tag latest --otp=<code>
```

A prerelease version always needs an explicit `--tag`, and `latest` is the tag the self-updater reads.

## Security

This repository is a personal fork and is **not** the canonical project. Upstream's canonical sources are unchanged: the [KarpelesLab repository](https://github.com/KarpelesLab/teamclaude) and the [`@karpeleslab/teamclaude`](https://www.npmjs.com/package/@karpeleslab/teamclaude) npm package.

This fork is distributed as this repository and the [`@rikcodes/teamclaude`](https://www.npmjs.com/package/@rikcodes/teamclaude) npm package, published by `rikbrown`. The separate package name means it can never be installed over the canonical one.

Neither is **ever** distributed as a downloadable binary archive, so be wary of any copy that bundles a `.zip` and tells you to extract and run it. See [SECURITY.md](SECURITY.md) for details and how to report issues.

## Compliance

TeamClaude is a local proxy holding your own credentials and driving your own Claude Code CLI. How that lines up with Anthropic's terms, including the multi-subscription question people ask most, is written up in [docs/compliance.md](docs/compliance.md). Not legal advice.

## License

MIT — see [LICENSE](LICENSE).

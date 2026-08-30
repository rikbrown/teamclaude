# TeamClaude

> **Fork notice (rikbrown).** This fork adds three features and two reload fixes on top of
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
> - `soonestWeekly` and `distributeSessions` changes now apply on config reload; upstream applies
>   `distributeSessions` only at startup.
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

Multi-account proxy for [Claude Code](https://claude.ai/claude-code) and [Codex](https://github.com/openai/codex): it pools Claude Max, ChatGPT/Codex, API-key and third-party backend accounts, and rotates on quota.

It sits between the coding agent and the provider's API, holds several accounts, and moves to the next one when the current account gets close to its session or weekly limit. The session keeps running instead of stopping on a 429. Claude accounts serve Claude Code, Codex accounts serve the Codex CLI, and both pools share one proxy.

**It is built for one person.** The "team" is the agents: someone running ten, or fifty, coding-agent sessions at once needs more than one subscription, and switching accounts by hand each time one fills up is what this replaces. Every account in the pool is your own, and the client is the provider's own CLI. It is not a way to share an account between people, and not a bridge for other clients onto subscription credentials — see [Scope](#scope).

![TeamClaude TUI](screenshots/teamclaude.png)

## Quick start

Node.js 20+ required.

```bash
npm install -g @rikcodes/teamclaude

teamclaude login     # browser OAuth, run it once per account
teamclaude server    # start the proxy, shows the TUI
teamclaude run       # in another terminal: Claude Code through the proxy
```

Already logged into Claude Code? `teamclaude import` takes its credentials instead of a fresh OAuth round. A container image is on GHCR — see [Running in a container](docs/usage.md#running-in-a-container). API keys, and one email holding accounts in several orgs, are covered in [docs/accounts.md](docs/accounts.md).

## What it does

- Rotates to the next account when the 5h session or 7d weekly bucket reaches the threshold (98% by default), preferring the account whose weekly quota resets soonest.
- Optionally spends the account whose weekly window resets soonest **first**, preempting the current account when another resets more than `poolHours` sooner, so a window stops rolling over with quota unspent (`soonestWeekly`, this fork).
- Projects each quota window's burn rate against its reset, so a row says `Ses TTL 38m · Wk 22% unspent` instead of leaving you to read it off a bar (`projection`, this fork).
- Tracks the per-model weekly cap separately, so an account out of Fable quota is skipped for Fable requests and still serves Opus and Sonnet.
- Tells a spent quota bucket apart from a per-minute rate limit and only rotates on the first one. Rotating on a rate limit would just move the burst to the next account and drop the warm cache, so it paces the same account instead.
- Paces requests onto a freshly switched account, so a herd of agents failing over at the same instant doesn't throttle it and cascade down the fleet.
- TUI with quota bars, reset countdowns, activity log, and settings you can change while it runs, including adding and removing accounts.
- Opt-in MCP endpoint that hands the same control plane to Claude Code as tools, so an agent can read the fleet's quota or switch accounts from inside a session.
- Catches hardcoded `api.anthropic.com` endpoints (the Claude Design MCP, for one) through a local MITM forward proxy, not only what `ANTHROPIC_BASE_URL` covers.
- Holds the request open until quota resets instead of returning 429 when every account is spent, so an unattended run finishes on its own (`holdSeconds`, off by default).
- Optionally leans on accounts with Anthropic's paid extra usage once every account is out of free quota, instead of returning 429 (`allowExtraUsage`, off by default — it bills real money). Quota between the switch threshold and 100% is used first, on any account; billing starts only when none is left, and stops as soon as a window resets.
- Refreshes OAuth tokens before they expire and writes them back to config. Client refreshes pass through untouched.
- Pools OpenAI Codex subscriptions alongside Claude accounts (experimental): the Codex CLI is routed through the same proxy, by config or transparently through the MITM proxy, and rotates on its own quota.
- Takes any Anthropic-compatible API (DeepSeek, GLM) as a low-priority fallback for when the Claude accounts are done.
- Sends one account's traffic through its own HTTP or SOCKS proxy (`login --routing "socks5h://user:pass@host:1080"`), sign-in and token refresh included, and leaves every other account alone. If that proxy goes down, the request fails over to the next account.
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

## Documentation

| Page | Contents |
| --- | --- |
| [Accounts](docs/accounts.md) | OAuth login, import, API keys, multiple orgs, syncing tokens across machines via callback.net, per-account proxy routing, Codex accounts, third-party backends |
| [Usage](docs/usage.md) | Server and TUI, running Claude Code, shell alias, command reference, browser dashboard, MCP endpoint, logging |
| [Routing](docs/routing.md) | Rotation, the two kinds of 429, storm control, model routes, session spreading, pinning, prompt cache |
| [Quota](docs/quota.md) | Quota probe, keep-warm, holding on exhaustion |
| [OpenAI models](docs/openai.md) | Codex sidecar setup, custom model registration, GPT subagents, limitations |
| [Configuration](docs/configuration.md) | Config format, every field, environment variables, network tuning |
| [Proxy modes](docs/proxy-modes.md) | MITM forward proxy, upstream proxy, per-account routing, sx.org residential egress |
| [Compliance](docs/compliance.md) | Who the project is for, and terms of service notes for each provider |
| [Contributing](CONTRIBUTING.md) | What is in scope, and what a pull request needs |

## Renaming to TeamRouter

TeamClaude is becoming **TeamRouter** — it pools Codex and third-party accounts as well as Claude ones, and the name should say so. The rename is spread over several releases so that nothing installed, scripted or configured breaks; the plan and its progress are in [issue #72](https://github.com/KarpelesLab/teamclaude/issues/72). As of this release the new name is *accepted* everywhere while the old one stays canonical: `teamrouter` runs the same CLI as `teamclaude`, every `TEAMCLAUDE_*` variable is also read as `TEAMROUTER_*`, every `/teamclaude/…` control route also answers at `/teamrouter/…`, and a `~/.config/teamrouter.json` is used when it exists. Nothing on an existing install needs to change, now or when the default flips.

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

## Scope

TeamClaude is a local proxy holding your own credentials and driving the provider's own CLI, for one person's work. That holds for every provider it supports, not only Anthropic:

- **One person, their own accounts.** Not account sharing, not a hosted service, not resale.
- **The provider's own client.** Claude Code on Claude accounts, the Codex CLI on Codex accounts. No support for other harnesses on subscription credentials.
- **A third-party backend is an account like any other:** a key you were issued, used under that vendor's terms.

How this lines up with the providers' terms, including the multi-subscription question people ask most, is written up in [docs/compliance.md](docs/compliance.md). Not legal advice. Changes that step outside this scope are not merged; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

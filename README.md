# TeamClaude

> **Fork notice (rikbrown).** This fork adds two features and two reload fixes on top of
> [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude):
>
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
| [Accounts](docs/accounts.md) | OAuth login, import, API keys, multiple orgs, third-party backends |
| [Usage](docs/usage.md) | Server and TUI, running Claude Code, shell alias, command reference, logging |
| [Routing](docs/routing.md) | Rotation, the two kinds of 429, storm control, model routes, session spreading, pinning, prompt cache |
| [Quota](docs/quota.md) | Quota probe, keep-warm, holding on exhaustion |
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

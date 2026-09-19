# OpenAI models via a Codex sidecar

Route `gpt-*` requests to OpenAI's Codex backend, billed to a ChatGPT Plus/Pro subscription, while
Claude requests keep flowing to your Anthropic accounts — in the same session, under **real model
names**.
No model faking: `opus` stays Opus, and `gpt-5.6-sol` is requested as `gpt-5.6-sol`.

TeamClaude does not translate the wire format itself. A local **sidecar** — an Anthropic→OpenAI
translating proxy — handles the translation; TeamClaude supervises it and routes to it like any
[third-party backend account](accounts.md#third-party-backend-accounts). The reference sidecar is
[raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) (Rust, MIT): it speaks
`/v1/messages` on the front, the Codex Responses API on the back, authenticates via Codex OAuth
against your ChatGPT subscription, and accepts raw `gpt-*` model ids.

**Install the fork, not the upstream build.** Two things this page relies on are not upstream:
the sidecar forwards Codex's quota headers, without which every bar on the account reads
`unknown`, and its header timeout is configurable, without which a long reasoning turn dies at
60 seconds. Both live in
[rikbrown/claude-code-proxy](https://github.com/rikbrown/claude-code-proxy), which tracks
upstream and publishes its own releases.

## Setup

1. Install and authenticate the sidecar (one-time):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/rikbrown/claude-code-proxy/rik/main/scripts/install.sh | bash
   claude-code-proxy codex auth login
   ```

   The installer verifies the checksum and clears the macOS quarantine attribute. It lands the
   binary in `/usr/local/bin` or `~/.local/bin`; `CLAUDE_CODE_PROXY_INSTALL_DIR` overrides that.
   **Give `sidecars[].command` an absolute path** if the install directory is not on the `PATH`
   a service sees — a launchd-started server gets a bare `PATH` and will not resolve
   `claude-code-proxy` by name.

2. Configure TeamClaude — four pieces in `~/.config/teamclaude.json`:

   ```json
   {
     "sidecars": [
       {
         "name": "codex",
         "command": ["claude-code-proxy", "serve", "--no-monitor", "--port", "18765"]
       }
     ],
     "accounts": [
       { "name": "codex", "type": "oauth", "accessToken": "unused-local-sidecar",
         "upstream": "http://127.0.0.1:18765", "priority": 100 }
     ],
     "routes": [
       { "name": "codex", "match": ["gpt-*"], "accounts": ["codex"] },
       { "name": "anthropic", "match": ["*"], "accounts": ["your-claude-accounts", "..."] }
     ],
     "customModels": [
       { "model": "gpt-5.6-sol",   "label": "GPT-5.6 Sol",   "contextTokens": 272000 },
       { "model": "gpt-5.6-terra", "label": "GPT-5.6 Terra", "contextTokens": 272000 },
       { "model": "gpt-5.6-luna",  "label": "GPT-5.6 Luna",  "contextTokens": 272000 },
       { "model": "gpt-6-astra",   "label": "GPT-6 Astra",   "contextTokens": 272000 }
     ]
   }
   ```

3. Restart the server. It now spawns and owns the sidecar (respawned with backoff on crash,
   killed on shutdown, stderr tail in `status --json` under `sidecars`).

The **catch-all route matters**: without it, the third-party account joins the automatic
exhaustion-fallback pool, and an exhausted Claude fleet would silently spill Claude-model requests
onto the sidecar — which maps `claude-*` names onto GPT models. The catch-all `*` route pins Claude
traffic to Claude accounts, so the only way to reach a GPT model is to ask for one by name.

## What you get

- Pick a GPT model at launch (`claude --model gpt-5.6-sol`), typed mid-session
  (**`/model gpt-5.6-sol`**), or from the picker rows `teamclaude run` injects (real ids, your
  labels).
- Correct context sizing: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set to the largest `contextTokens`,
  so Claude Code compacts at the model's real window instead of assuming 200k.
- **Dispatchable GPT subagents**: `run` injects one agent definition per custom model, named after
  the model — "dispatch a `gpt-5.6-terra` subagent" works in any session. (The Agent tool's `model`
  *parameter* is an alias enum and cannot carry a custom id; only an agent definition can.)
  `"customModelAgents": false` turns these off when your own `~/.claude/agents/` definitions
  already name the models.
- Mixed sessions: a Claude parent freely dispatches GPT subagents and vice versa; the proxy routes
  each request by the model in its body.

For tools that spawn `claude` themselves, `teamclaude env` carries the env-var subset: window
sizing, plus `ANTHROPIC_CUSTOM_MODEL_OPTION` for the **first** custom model. Env vars cannot
express picker rows or agent definitions. For GPT subagents under `env`, create
`~/.claude/agents/<name>.md` with `model: gpt-5.6-terra` frontmatter.

## Quota

Codex reports how much of the subscription is spent as `x-codex-*` response headers, and Claude
Code never sees them, so the reference sidecar drops the lot. TeamClaude reads them when they
arrive: each window is filed by its declared length — 300 minutes into the session bar, 10080 into
the weekly one — and a 429 whose headers show a spent window (≥100%) counts as durable exhaustion
rather than a rate limit. Which bar fills depends on the plan: a ChatGPT Pro subscription meters a
weekly window only, so the session bar stays `unknown`.

The account that receives the numbers depends on the setup. A standalone sidecar holds its own
ChatGPT login, so its forwarded numbers fill its own bars. A sidecar whose back leg re-enters this
proxy (below) is a **conduit**: the numbers describe the pooled account that served the second hop,
so they are filed against that account and the conduit keeps none. Otherwise, its bars would track
the account that answered last. If a borrowed number crossed the switch threshold, it would take the
conduit out of service and fail every `gpt-*` request while a sibling remained at 0%, because the
conduit is the only account that its route can use on the way in.

Getting the headers that far takes a patch to the sidecar — one module and four call sites, which
keeps the newest snapshot and stamps it onto every Codex response under the names Codex itself
uses. Both transports are covered: the HTTP one carries the headers, the WebSocket one carries the
same numbers as a `codex.rate_limits` event ahead of the first output, so a response reports the
request it answers. It is offered upstream as
[raine/claude-code-proxy#127](https://github.com/raine/claude-code-proxy/pull/127) and, until that
merges, ships in the [fork release](https://github.com/rikbrown/claude-code-proxy/releases) the
[Setup](#setup) step installs. Upstream's build still works; its bars just read `unknown`, and
exhaustion shows up only as a 429 with `retry-after`.

## Timeouts

A `gpt-*` request waits on **two** header timeouts, and the shorter one wins. TeamClaude's
`headersTimeoutMs` bounds how long it waits on the account; the sidecar separately bounds how long
it waits on Codex. Raising one and not the other just moves which of them fires.

The sidecar's wait defaults to **60 seconds**, which a long reasoning turn exceeds — the turn dies
with no output rather than a useful error. Upstream hardcodes it; the fork build makes it
configurable, so set it on the `sidecars` entry alongside any `headersTimeoutMs` you set on the
accounts:

```json
{ "name": "codex",
  "command": ["/Users/you/.local/bin/claude-code-proxy", "serve", "--no-monitor", "--port", "18765"],
  "env": { "CCP_CODEX_HEADER_TIMEOUT_MS": "300000" } }
```

`codex.headerTimeoutMs` in `~/.config/claude-code-proxy/config.json` does the same thing; the
environment variable wins, and either is ignored below 1000. `sidecars[].env` is read once at
startup, so restart the server rather than reloading.

Two other fork-only options live in that same config, both off by default and neither needed for a
standard setup: `codex.contextManagement` (with `contextManagementThreshold`) manages a long
conversation's context on the Codex side, and `codex.fullLane` puts the lite-lane models on the
full Responses lane. Each has a `CCP_CODEX_`-prefixed environment variable of the same name.

## Why not the built-in Codex provider?

TeamClaude also speaks to Codex natively: an account with `"provider": "codex"` pools a ChatGPT
login with no sidecar at all. It serves a different job.

The native provider is a **passthrough** — the client speaks OpenAI's own protocol and the body is
forwarded untouched, which is what keeps tool calls, streaming events and cache breakpoints exact.
It therefore serves the **Codex CLI**, pointed at `<proxy>/backend-api/codex`, and requests are
matched to it **by path**: `/v1/messages` is Anthropic's, `/backend-api/codex/*` is Codex's.

Claude Code only speaks `/v1/messages`, so it cannot reach a native Codex account directly. The
sidecar exists to translate; the native path deliberately does not.

Use the sidecar to put **GPT models inside a Claude Code session** (`/model gpt-*`, dispatchable GPT
subagents, mixed-model sessions). Use `"provider": "codex"` to pool ChatGPT logins for the **Codex
CLI** — or, as shown below, behind the sidecar too.

> Do not add `"provider": "codex"` to a sidecar account. It marks the account as a foreign
> subscription, so the partition excludes it from the `/v1/messages` traffic it is there to serve,
> and every `gpt-*` request fails to find an account. A sidecar account is reached over the
> Anthropic wire and correctly carries no `provider` field.

## Several ChatGPT accounts behind one sidecar

The sidecar holds one ChatGPT login, so GPT requests do not rotate. Its quota reading also belongs
to a login that TeamClaude does not own.

Point the sidecar's **back leg** at TeamClaude so that the native Codex pool serves its requests:

```
Claude Code ──▶ TC /v1/messages (gpt-*) ──▶ sidecar account (127.0.0.1:18765)
            ──▶ sidecar translates ──▶ TC /backend-api/codex/responses
            ──▶ ChatGPT account pool ──▶ chatgpt.com
```

Each hop is classified by path, so the subscription partition keeps the pools separate: only the
sidecar account is eligible on the way in (it carries no `provider`), and only the ChatGPT accounts
are eligible on the way back. This separation lets one route list both.

1. **Redirect the sidecar and pin its transport** on the `sidecars` entry:

   ```json
   { "name": "codex",
     "command": ["claude-code-proxy", "serve", "--no-monitor", "--port", "18765"],
     "env": {
       "CCP_CODEX_BASE_URL": "http://127.0.0.1:3456/backend-api/codex/responses",
       "CCP_CODEX_TRANSPORT": "http"
     } }
   ```

   `http` is **required** because a WebSocket upgrade is relayed with the caller's own headers and
   draws no account. Without it, the transport cannot use the pool.

2. **Stub the sidecar's own login.** Back up `~/.config/claude-code-proxy/codex/auth.json`, then
   replace it with a placeholder that never expires:

   ```json
   { "access": "delegated-to-teamclaude", "refresh": "", "expires": 4102444800000 }
   ```

   The sidecar refuses to run with an empty store but does not refresh a far-future token.
   TeamClaude replaces both the bearer and the account header on the way out. Leave `accountId`
   unset so the sidecar's identity cannot leak.

3. **Add the accounts** — run `teamclaude login --codex` once for each ChatGPT account. The login
   takes its email as its name. The same person's Anthropic account usually has that name, so the
   Codex name gets a prefix to keep it unambiguous — `codex:you@example.com`. Routes address accounts
   by name, so a shared name admits both.

4. **List them on the `gpt-*` route** alongside the sidecar account, and set a matching
   `headersTimeoutMs` for each one — the 120s fleet default is shorter than a long reasoning turn:

   ```json
   { "name": "codex", "match": ["gpt-*"], "accounts": ["codex", "codex:you@example.com", "codex:you@work.example"] }
   ```

   > **Keep the sidecar account on this route.** It can look removable because it is not a
   > subscription or an account row, but it is the routing target for the way *in*. Without it, every
   > `gpt-*` request fails to find an account while `teamclaude status` still shows two healthy
   > ChatGPT accounts on the route.

5. **Restart the server.** `sidecars[].env` is read only at startup, so a config reload does not
   apply the change — and killing the sidecar only starts it again with the old environment.

Rotation, quota bars, the session-reset countdown and `teamclaude disable` then work for ChatGPT
accounts as they do for Claude accounts. The sidecar no longer appears in the account table. It
appears beneath it as a `⚙` readout line that shows its supervised process state. Two things differ:

- **Each turn appears twice** in the activity list and the request log, once per hop.
- **Tokens are booked against the sidecar account**, not the ChatGPT one. Nothing parses the
  Responses body shape for usage, so a ChatGPT row reads `N req · 0 tok`. Its quota bars are
  unaffected — those come from the `x-codex-*` headers on the second hop.

Read [Terms of service](#terms-of-service) before setting this up.

## Limitations

- Claude Code prints a one-line `[claude-code:unrecognized_model]` stderr diagnostic per custom
  model. Silencing it requires `modelOverrides`, which would pin the custom model to the mapped
  Claude model's 200k window; TeamClaude keeps the correct window and accepts the one-line notice.
- The sidecar allow-lists Codex model ids — a `customModels` row alone does not unlock a new
  OpenAI model. It rejects unknown ids until you install a build that lists them (the reference
  sidecar added `gpt-6-astra` on 2026-09-04). Copy each id's `context_window` from
  `~/.codex/models_cache.json` into `contextTokens`.
- The sidecar listens without client authentication — keep it on loopback (the default).

## Terms of service

> This is the maintainer's good-faith reading, **not legal advice**. It is less comfortable than
> the Anthropic case. Read OpenAI's current [Terms of Use](https://openai.com/policies/row-terms-of-use/)
> and decide for yourself. See also [compliance](compliance.md).

**Pooling several ChatGPT accounts is a named prohibition.** Under "What you cannot do", OpenAI's
consumer Terms of Use forbid you to "interfere with or disrupt our Services, including circumvent
any rate limits or restrictions or bypass any protective measures". Rotating to a second
subscription after spending the first one's window plainly does that. This is stronger than a guess
about fraud heuristics, and the likely consequence is account suspension rather than a refused
request.

**The single-account case is a grey area, not a blessed one.** OpenAI staff have publicly described
one person using their own ChatGPT subscription through a third-party client as acceptable. Their
fraud systems also target one subscription serving many consumers. But the same clause list forbids
you to "automatically or programmatically extract data or Output". A literal reading covers any
third-party harness — including a sidecar serving one login. The favourable reading rests on staff
statements, not on a carve-out in the terms.

**There is no Anthropic-style defence here.** Claude Code's own `/extra-usage` flow offers signing
in to a different account when you hit a limit, so TeamClaude automates a move that the first-party
client already offers. OpenAI publishes no equivalent option, so that argument stops at the Codex
boundary. An unreleased "subscription sharing" mechanism has been reported, but nothing is
documented or launched.

**Enforcement is not hypothetical.** Third-party harnesses that use ChatGPT OAuth have reportedly
been cut off. The [openai/codex discussion](https://github.com/openai/codex/discussions/8338) asking
whether a forked CLI is permitted also has no answer from OpenAI. Both reports are secondary, but
they point the same way.

TeamClaude pools ChatGPT accounts only when you configure it to. This is the one feature in the
fork whose documented risk is a suspended subscription rather than a degraded experience, so it
stays off until you wire it up deliberately — see [Several ChatGPT accounts behind one
sidecar](#several-chatgpt-accounts-behind-one-sidecar).

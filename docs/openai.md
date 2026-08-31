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

## Setup

1. Install and authenticate the sidecar (one-time):

   ```bash
   brew install raine/claude-code-proxy/claude-code-proxy
   claude-code-proxy codex auth login
   ```

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
       { "model": "gpt-5.6-luna",  "label": "GPT-5.6 Luna",  "contextTokens": 272000 }
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

Getting the headers that far takes a patch to the sidecar — one module and four call sites, which
keeps the newest snapshot and stamps it onto every Codex response under the names Codex itself
uses. Both transports are covered: the HTTP one carries the headers, the WebSocket one carries the
same numbers as a `codex.rate_limits` event ahead of the first output, so a response reports the
request it answers. Until it lands upstream, build the branch and point `sidecars[].command` at
`target/release/claude-code-proxy` instead of the Homebrew binary. Without the patch the account
still works; its bars just read `unknown`, and exhaustion shows up only as a 429 with
`retry-after`.

## Limitations

- Claude Code prints a one-line `[claude-code:unrecognized_model]` stderr diagnostic per custom
  model. Silencing it requires `modelOverrides`, which would pin the custom model to the mapped
  Claude model's 200k window; TeamClaude keeps the correct window and accepts the one-line notice.
- The sidecar listens without client authentication — keep it on loopback (the default).

## Terms of service

OpenAI staff have publicly described one person using their own ChatGPT subscription through a
third-party client as acceptable. Their fraud systems target one subscription serving many
consumers. Use one codex account yourself; **do not pool multiple ChatGPT accounts for rotation**
as TeamClaude does with Claude accounts. See also [compliance](compliance.md).

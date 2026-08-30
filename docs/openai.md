# OpenAI models via a Codex sidecar

Route `gpt-*` requests to OpenAI's Codex backend (a ChatGPT Plus/Pro subscription) while Claude
requests keep flowing to your Anthropic accounts — in the same session, under **real model names**.
No model faking: `opus` stays Opus, and `gpt-5.6-sol` is requested as `gpt-5.6-sol`.

TeamClaude does not translate the wire format itself. A local **sidecar** — an Anthropic→OpenAI
translating proxy — does that, and TeamClaude supervises it and routes to it like any
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

3. Restart the server. It now spawns and owns the sidecar (respawn with backoff on crash,
   killed on shutdown, stderr tail in `status --json` under `sidecars`).

The **catch-all route matters**: without it, the third-party account joins the automatic
exhaustion-fallback pool, and a spent Claude fleet would silently send Claude-model requests to the
sidecar — which maps `claude-*` names onto GPT models. The exclusive `*` route pins Claude traffic
to Claude accounts, so the only way to reach a GPT model is to ask for one by name.

## What you get

- `claude --model gpt-5.6-sol`, or **`/model gpt-5.6-sol`** typed mid-session, or the picker rows
  `teamclaude run` injects (real ids, your labels).
- Correct context sizing: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set to the largest `contextTokens`,
  so Claude Code compacts at the model's real window instead of assuming 200k.
- **Dispatchable GPT subagents**: `run` injects one agent definition per custom model, named after
  it — "dispatch a `gpt-5.6-terra` subagent" works in any session. (The Agent tool's `model`
  *parameter* is an alias enum and cannot carry a custom id; only an agent definition can.)
- Mixed sessions: a Claude parent freely dispatches GPT subagents and vice versa; the proxy routes
  each request by the model in its body.

`teamclaude env` (for tools that spawn `claude` themselves) carries the env-var subset: window
sizing plus `ANTHROPIC_CUSTOM_MODEL_OPTION` for the **first** custom model — env vars cannot
express picker rows or agent definitions. For GPT subagents under `env`, create
`~/.claude/agents/<name>.md` with `model: gpt-5.6-terra` frontmatter.

## Limitations

- **Quota bars show `unknown`** for the codex account: the sidecar does not yet forward the
  Codex rate-limit telemetry (`x-codex-*` headers / the in-band `codex.rate_limits` event).
  TeamClaude already parses those headers into the 5h/weekly slots if they ever arrive, and a
  429 whose headers show a spent window (≥100%) is classified as durable exhaustion. Until then,
  exhaustion surfaces reactively as a 429 with `retry-after`.
- Claude Code prints a one-line `[claude-code:unrecognized_model]` stderr diagnostic per custom
  model. Silencing it requires `modelOverrides`, which would pin the mapped Claude model's 200k
  window — the wrong trade; we keep the correct window and the one-line notice.
- The sidecar listens without client authentication — keep it on loopback (the default).

## Terms of service

One human using their own ChatGPT subscription through a third-party client is the use OpenAI
staff have publicly described as fine. What their fraud systems target is one subscription
re-served to many consumers. **Do not pool multiple ChatGPT accounts for rotation** the way
TeamClaude rotates Claude accounts — one codex account, used by you. See also
[compliance](compliance.md).

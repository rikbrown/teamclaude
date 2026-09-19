# Running the fleet on a remote host

TeamClaude is usually started next to the client that uses it. It does not have to be. Moving
the server to an always-on box — a mini in a cupboard, a NUC, a VPS — means the fleet keeps its
quota windows warm, the probe keeps running, and every machine you own shares one pool instead
of each holding its own.

This page covers the whole move: reaching the box, moving the accounts onto it, keeping it
running, and pointing clients at it. Commands are given for macOS and Linux.

## One server, never two

The accounts must live on exactly one machine. This is not a preference.

An OAuth refresh may return a **new** refresh token, and TeamClaude stores whichever it gets
back. Two servers holding the same `accounts[]` refresh independently, so one can end up
presenting a token the other has already replaced. TeamClaude records that rejection
(`_deadRefreshToken`) and stops using the account — including skipping it in the probe, since
refreshing a rejected token only rotates the family again — until you log in afresh. With a
quota probe running, a fleet of a dozen accounts can degrade quickly.

So the config is **moved**, not copied:

1. Stop the old server.
2. Copy `teamclaude.json` to the new host.
3. Rename the original the same minute, so nothing can start a second server against it.

```sh
mv ~/.config/teamclaude.json ~/.config/teamclaude.json.moved-to-<host>-$(date +%Y%m%d)
```

Access tokens are unaffected by this: a rotated refresh token does not invalidate an access
token already issued, so a client that is mid-session keeps working until you close it.

If you want to confirm nothing was lost, compare both files before deleting anything — every
`accessToken` and `refreshToken` should be identical if neither server refreshed during the
overlap.

## Reaching the box

The server binds a plain HTTP port. Do not put that on the public internet. Two ways to reach it
that need no port forwarding and survive a dynamic IP:

### Tailscale (recommended)

A WireGuard mesh. Traffic is end-to-end encrypted between your devices, nothing is terminated by
a third party, and there is no request timeout to design around.

```sh
# macOS (the CLI package, not the App Store app: it runs as a system daemon, so
# it does not need anyone logged into the GUI)
brew install tailscale
sudo brew services start tailscale
sudo tailscale up

# Linux
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Turn on MagicDNS in the admin console and the host is reachable as a bare name — `http://<host>:3456`.
`tailscale ip -4` gives the `100.x` address if you would rather not depend on DNS.

### Cloudflare Tunnel

Works, with three caveats that matter for this workload:

- **Cloudflare terminates TLS.** Your prompts and source code pass through their edge in
  plaintext. For a personal fleet that may be fine; decide deliberately.
- **100 s limit to first byte**, after which the request is a 524. A non-streaming reply from a
  [Codex sidecar](openai.md) can take longer.
- **No MITM mode.** `HTTPS_PROXY` relies on `CONNECT`, which a tunnel will not carry, so clients
  are limited to base-URL routing.

If you use one, set `proxy.trustLoopback: false` — `cloudflared` runs on the same host, so every
request arrives from loopback and the key gate would otherwise never run. See
[Configuration](configuration.md).

## Installing the server

```sh
# macOS
brew install node
npm install -g @rikcodes/teamclaude

# Linux (Debian/Ubuntu; any Node >= 20 works)
sudo apt install -y nodejs npm
npm install -g @rikcodes/teamclaude
```

Copy the config over, then edit three things on the new host:

```jsonc
{
  "proxy": {
    "host": "0.0.0.0",              // or the tailnet IP, to bind that interface only
    "port": 3456,
    "apiKey": "tc-…",               // required once the listener is not loopback-only
    "clientKeys": [                 // one per machine: this is what attributes usage
      { "name": "laptop", "key": "tc-…" },
      { "name": "server", "key": "tc-…" }
    ]
  }
}
```

If you run a [Codex sidecar](openai.md), its `sidecars[].command` is an **absolute path** on the
new host, and it must be: a service started by launchd or systemd does not inherit your
interactive `PATH`, so a bare command name will not resolve. Its `env.XDG_STATE_HOME` needs the
new home directory if the username differs.

Reload with **R** in the TUI, or `POST /teamclaude/reload`. A `sidecars` change needs a full
restart — that block is read once at startup.

## Keeping it running

### Headless, supervised by the OS

```sh
teamclaude service install
```

macOS writes `~/Library/LaunchAgents/com.karpeleslab.teamclaude.plist` with `RunAtLoad` and
`KeepAlive`, logging to `~/Library/Logs/teamclaude.log`. Linux writes a systemd **user** unit and
enables it. Check either with `teamclaude service status`, or:

```sh
# macOS
launchctl print gui/$(id -u)/com.karpeleslab.teamclaude | grep -E 'state|pid'
# Linux
systemctl --user status teamclaude
journalctl --user --unit teamclaude.service --follow
```

Two things are easy to miss:

- **macOS: a LaunchAgent needs a GUI session.** On a headless box set the machine to log in
  automatically as the account that owns the agent (`sudo sysadminctl -autologin set -userName
  <user> -password '…'`), otherwise the agent never loads after a reboot. Lock the screen
  immediately to compensate: `sysadminctl -screenLock immediate -password '…'`.
- **Linux: enable lingering**, or the unit stops when your SSH session ends:

  ```sh
  loginctl enable-linger $USER
  ```

### With the live TUI

The installed service runs `server --headless`, which paints nothing. `teamclaude attach` opens a
remote dashboard, but note what it **cannot** show: request traffic never leaves the server
process, so the activity pane is replaced by a "Messages" pane. Accounts, quota and the settings
screen are all there; the live request feed is not.

To get everything — the activity feed, the settings screen, account switching — run the real TUI
inside `tmux` and have the service supervise the session.

`launchd` and `systemd` cannot watch `tmux new-session -d` directly: it returns as soon as the
session exists, so a restart policy would respawn it forever. A small keeper script fixes that —
it creates the session, then blocks while the session lives:

```sh
#!/bin/sh
set -u
TMUX_BIN=$(command -v tmux)
SESSION=teamclaude

if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  # Size matters while detached: tmux assumes 80x24 and the TUI renders truncated.
  "$TMUX_BIN" new-session -d -s "$SESSION" -x 220 -y 60 "$(command -v teamclaude) server"
fi

while "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; do
  sleep 10
done
```

Save it as `~/.local/bin/teamclaude-tmux.sh`, `chmod +x`, and point the service at it instead of
`teamclaude` — on macOS by editing `ProgramArguments` in the plist to
`["/bin/sh", "/home/<user>/.local/bin/teamclaude-tmux.sh"]`, on Linux by replacing `ExecStart` in
`~/.config/systemd/user/teamclaude.service`.

When the server exits, the pane closes, the session ends, the keeper exits, and the service
restarts it — which recreates everything. Attach from anywhere with:

```sh
ssh -t <host> 'tmux attach -t teamclaude'
```

**Detach with `Ctrl-b d`.** Pressing `q` quits the *server*; the service will bring it back, but
that is an outage rather than a detach.

### Just the request feed

`activityLog` writes the same lines the TUI shows to a file, and it works in headless mode:

```jsonc
{ "activityLog": "~/.config/teamclaude-activity.log" }
```

```sh
ssh <host> 'tail -f ~/.config/teamclaude-activity.log'
```

```
14:02:11  [laptop] 38cee1 POST /v1/messages?beta=true (claude-opus-5) → rik@example.com (200, 7.3s)
```

It carries the client name, the outcome and the duration, none of which the TUI's feed shows.

## Pointing clients at it

A client needs two environment variables, and they are **one setting in two halves**:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://<host>:3456` — `http://127.0.0.1:3456` on the server itself |
| `ANTHROPIC_CUSTOM_HEADERS` | `x-api-key: <that machine's client key>` |

Loopback clients are exempt from the key gate by default, so a client on the server host needs
only the base URL — but giving it a key anyway is what makes its usage show up separately.

> **Keep the pair together, in one file.** A base URL with no key is a 401 from the proxy; a key
> with no base URL is sent to `api.anthropic.com`, which never issued it, and *every* session
> fails to authenticate. Splitting them across two files means any edit to one can leave the
> other stranded.

`ANTHROPIC_CUSTOM_HEADERS` keeps Claude Code in OAuth mode — it still sends its own token, which
the proxy strips and replaces with a pooled account's. `ANTHROPIC_API_KEY` also satisfies the
gate, but switches the client into API-key mode and disables claude.ai connectors. Use it only
where that does not matter — in particular on a **headless host that has no Claude Code login at
all**, because API-key mode does not require one.

### Where to put them

`~/.claude/settings.json` is the simplest home:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<host>:3456",
    "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: tc-…"
  }
}
```

If you keep `~/.claude` in version control and share it between machines, these two do not belong
there — each machine has its own client key, and committing one defeats per-machine attribution.
Put them in the shell environment instead, and put them in **`~/.zshenv`, not `~/.zshrc`**:

```sh
# ~/.zshenv — sourced by every zsh, including non-interactive ones
export ANTHROPIC_BASE_URL="http://<host>:3456"
export ANTHROPIC_CUSTOM_HEADERS="x-api-key: tc-…"
```

`.zshrc` is read only by interactive shells, so a launcher that spawns `zsh -lc claude` gets
nothing from it. The bash equivalents are `~/.bash_profile` for login shells and `~/.bashrc` for
interactive ones; `~/.profile` is the closest thing to `.zshenv`, but note that a process started
by systemd reads none of them — use the unit's `Environment=` for those.

There is no per-machine override at user scope: `~/.claude/settings.local.json` is **not** read
for the user-level config, only inside a project.

### What you give up

`teamclaude run` and `teamclaude env` assume the proxy is on `localhost` — `run` refuses to start
when nothing answers there, and `env` emits a hardcoded `http://localhost:<port>`. Neither can
name a remote host today, so remote clients use base-URL routing and lose
[MITM mode](proxy-modes.md). In practice that only matters for tools that hardcode
`api.anthropic.com` rather than honouring `ANTHROPIC_BASE_URL`.

`CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `ANTHROPIC_CUSTOM_MODEL_OPTION`, which `run` would normally
inject from `customModels`, also have to be set by hand — but they are fleet-wide rather than
per-machine, so they are safe to commit in a shared `settings.json`.

## Verifying

```sh
# 1. The key gate is doing its job: 401 without a key, 200 with one.
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:3456/teamclaude/status
curl -s -H "x-api-key: tc-…" http://<host>:3456/teamclaude/status | jq '.accounts | length'

# 2. A real client request. Do NOT test with a bare curl to /v1/messages: a request
#    without Claude Code's identity is rejected on the OAuth path with a generic
#    rate_limit_error, which looks like a fleet problem and is not.
claude -p 'Reply with exactly: OK'

# 3. Usage is attributed to this machine.
curl -s -H "x-api-key: tc-…" http://<host>:3456/teamclaude/status | jq '.clients'
```

```json
{
  "laptop": { "requests": 848, "inputTokens": 19039115, "outputTokens": 453099 },
  "server": { "requests": 3,   "inputTokens": 1187,     "outputTokens": 52 }
}
```

Administer the fleet over SSH. A shell function beats an alias, because `attach` needs a TTY and
the other subcommands do not:

```sh
tc() {
  local t=(); [[ -t 1 ]] && t=(-t)
  case "$1" in
    attach) ssh -t <host> 'tmux attach -t teamclaude' ;;
    feed)   ssh -t <host> 'tail -n 40 -f ~/.config/teamclaude-activity.log' ;;
    *)      ssh "${t[@]}" <host> "teamclaude ${(q)@}" ;;   # ${(q)@} is zsh; bash: \"$@\"
  esac
}
```

## Traps

- **A 429 with no rate-limit headers, on every account at once**, usually means the request is
  the problem rather than the fleet. The log says so: `it is about the request, not the
  accounts`. A hand-rolled `curl` to `/v1/messages` is the common cause.
- **Killing the server orphans the sidecar.** It survives and keeps its port. The next start
  reaps it (`reaped orphan pid … left by a previous run`) after one transient `ECONNREFUSED`.
  Nothing to do.
- **Two servers briefly overlapping is survivable** if nothing refreshes — tokens only rotate
  near expiry or after a 401. Check `expiresAt` before you start, and keep the window short.
- **Probes 429 during an overlap** because both servers poll the same usage endpoint. Harmless,
  and it stops when the old server does.
- **A second tmux window in the supervised session defeats the keeper**, because `has-session`
  stays true when the server's own window dies. Give anything else its own session.

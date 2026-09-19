# Running the fleet on a remote host

TeamClaude usually runs next to its client, but it can run elsewhere. Moving the server to an
always-on box — a mini in a cupboard, a NUC, a VPS — keeps the fleet's quota windows warm and its
probe running. It also lets every machine you own share one pool instead of maintaining its own.

This page covers the full move: how to reach the box, move the accounts to it, keep the server
running and point clients at it. It includes commands for macOS and Linux.

## One server, never two

The accounts must live on exactly one machine. This is not a preference.

An OAuth refresh may return a **new** refresh token, and TeamClaude stores the returned token.
Two servers with the same `accounts[]` refresh independently, so one can present a token that
the other has already replaced. TeamClaude records that rejection (`_deadRefreshToken`) and
stops using the account. It also skips the account in the probe, because refreshing a rejected
token only rotates the family again. The account remains unavailable until you log in again.
With a quota probe running, a fleet of a dozen accounts can degrade quickly.

So the config is **moved**, not copied:

1. Stop the old server.
2. Copy `teamclaude.json` to the new host.
3. Rename the original immediately, so nothing can start a second server with it.

```sh
mv ~/.config/teamclaude.json ~/.config/teamclaude.json.moved-to-<host>-$(date +%Y%m%d)
```

Access tokens are unaffected by this: a rotated refresh token does not invalidate an access
token already issued, so a client that is mid-session keeps working until you close it.

If you want to confirm nothing was lost, compare both files before deleting anything — every
`accessToken` and `refreshToken` should be identical if neither server refreshed during the
overlap.

## Reaching the box

The server binds to a plain HTTP port. Do not expose it to the public internet. The following two
options need no port forwarding and work with a dynamic IP:

### Tailscale (recommended)

A WireGuard mesh. Traffic is encrypted end to end between your devices. No third party terminates
it, and there is no request timeout to design around.

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

Enable MagicDNS in the admin console to reach the host by its bare name: `http://<host>:3456`.
If you prefer not to depend on DNS, `tailscale ip -4` gives the `100.x` address.

### Cloudflare Tunnel

Cloudflare Tunnel works, but this workload has three important caveats:

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

# Linux (Debian/Ubuntu). The engines floor is Node 20, and the distro package is
# older than that on several supported releases, so take it from NodeSource:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
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

If you run a [Codex sidecar](openai.md), set its `sidecars[].command` to an **absolute path** on the
new host. A service started by launchd or systemd does not inherit your interactive `PATH`, so it
cannot resolve a bare command name. If the username differs, its `env.XDG_STATE_HOME` must use the
new home directory.

Reload with **R** in the TUI, or `POST /teamclaude/reload`. A `sidecars` change needs a full
restart — that block is read once at startup.

### Running from a checkout instead

TeamClaude has no runtime dependencies, so a clone runs as-is — useful when the remote host is
also where you try a fix before publishing it:

```sh
git clone --branch rik/main https://github.com/rikbrown/teamclaude.git ~/Code/teamclaude
cd ~/Code/teamclaude
npm uninstall -g @rikcodes/teamclaude   # drop the published copy first
npm link                                # `teamclaude` now resolves to this checkout
```

Point the service at the checkout explicitly — `node <repo>/src/index.js server` — rather than at
`teamclaude` on `PATH`. A service is started with a bare `PATH`, and `npm link` is a convenience
for interactive shells that the service should not depend on.

Treat the checkout as a deploy target, not a place to author changes: push from wherever you
work, then `git fetch && git checkout -B <branch> origin/<branch>` and restart the server.

## Keeping it running

### Headless, supervised by the OS

```sh
teamclaude service install
```

macOS writes `~/Library/LaunchAgents/com.karpeleslab.teamclaude.plist` with `RunAtLoad` and
`KeepAlive`, and logs to `~/Library/Logs/teamclaude.log`. Linux writes and enables a systemd
**user** unit. Use `teamclaude service status` to check either service, or run:

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

The installed service runs `server --headless` and produces no TUI output. `teamclaude attach`
opens a remote dashboard, but it cannot show request traffic. That traffic stays in the server
process, so a "Messages" pane replaces the activity pane. The remote dashboard still includes
accounts, quota and the settings screen.

To retain the activity feed, settings screen and account switching, run the real TUI inside
`tmux` and let the service supervise the session.

`launchd` and `systemd` cannot supervise `tmux new-session -d` directly. The command returns as
soon as the session exists, so a restart policy would respawn it indefinitely. A small keeper
script creates the session and then blocks while it remains active:

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

Save it as `~/.local/bin/teamclaude-tmux.sh`, run `chmod +x`, and make the service call it instead
of `teamclaude`. On macOS, edit `ProgramArguments` in the plist to
`["/bin/sh", "/Users/<user>/.local/bin/teamclaude-tmux.sh"]`. On Linux, replace `ExecStart` in
`~/.config/systemd/user/teamclaude.service`.

When the server exits, the pane closes, the session ends and the keeper exits. The service then
restarts the keeper, which recreates the session. Attach from anywhere with:

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

Each line includes the client name, outcome and duration. The TUI feed shows none of these fields.

## Pointing clients at it

A client needs two environment variables. Together, they form one setting:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://<host>:3456` — `http://127.0.0.1:3456` on the server itself |
| `ANTHROPIC_CUSTOM_HEADERS` | `x-api-key: <that machine's client key>` |

Loopback clients bypass the key gate by default, so a client on the server host needs only the base
URL. Give it a key if you want its usage attributed separately.

> **Keep the pair together in one file.** A base URL with no key gets a 401 from the proxy. A key
> with no base URL goes to `api.anthropic.com`, which never issued it, so *every* session fails to
> authenticate. If you split them across two files, an edit to one can leave the other stranded.

`ANTHROPIC_CUSTOM_HEADERS` keeps Claude Code in OAuth mode. Claude Code still sends its own token,
which the proxy strips and replaces with a pooled account's credential. `ANTHROPIC_API_KEY` also
satisfies the gate, but it switches the client to API-key mode and disables claude.ai connectors.
Use it only where that does not matter, especially on a **headless host with no Claude Code login**,
because API-key mode does not require one.

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

If you keep `~/.claude` in version control and share it between machines, do not put these two
values there. Each machine has its own client key, and committing one defeats per-machine
attribution. Put both values in the shell environment instead. For zsh, use **`~/.zshenv`, not
`~/.zshrc`**:

```sh
# ~/.zshenv — sourced by every zsh, including non-interactive ones
export ANTHROPIC_BASE_URL="http://<host>:3456"
export ANTHROPIC_CUSTOM_HEADERS="x-api-key: tc-…"
```

`.zshrc` is read only by interactive shells, so a launcher that starts `zsh -lc claude` gets
nothing from it. For bash, use `~/.bash_profile` for login shells and `~/.bashrc` for interactive
shells. `~/.profile` is the closest equivalent to `.zshenv`. A process started by systemd reads
none of these files, so use the unit's `Environment=` setting.

There is no user-scope per-machine override. `~/.claude/settings.local.json` is read only inside a
project, not for the user-level configuration.

### What you give up

`teamclaude run` and `teamclaude env` assume that the proxy is on `localhost`. `run` refuses to
start when nothing responds there, and `env` emits a hardcoded `http://localhost:<port>`. Neither
can name a remote host today. Remote clients must therefore use base-URL routing and cannot use
[MITM mode](proxy-modes.md). This limitation affects only tools that hardcode
`api.anthropic.com` instead of honouring `ANTHROPIC_BASE_URL`.

You must also set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `ANTHROPIC_CUSTOM_MODEL_OPTION` manually.
`run` normally injects these values from `customModels`. They apply to the whole fleet, not to one
machine, so you can commit them safely in a shared `settings.json`.

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

Administer the fleet over SSH. Use a shell function instead of an alias, because `attach` needs a
TTY and the other subcommands do not:

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

- **A 429 with no rate-limit headers on every account at once** usually means that the request,
  not the fleet, is the problem. The log says: `it is about the request, not the accounts`. A
  hand-written `curl` request to `/v1/messages` is the common cause.
- **Killing the server orphans the sidecar.** The sidecar keeps running and retains its port. On
  the next start, the server reaps it (`reaped orphan pid … left by a previous run`) after one
  transient `ECONNREFUSED`. No action is necessary.
- **A brief overlap between two servers is survivable** if neither refreshes. Tokens rotate only
  near expiry or after a 401. Check `expiresAt` before you start, and keep the overlap short.
- **Probes return 429 during an overlap** because both servers poll the same usage endpoint. This
  is harmless and stops when the old server stops.
- **A second tmux window in the supervised session defeats the keeper.** `has-session` remains
  true when the server's window closes. Use a separate session for anything else.

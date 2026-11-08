# permission-triage

A `PermissionRequest` hook that decides Bash permission prompts, so no unattended session waits on one. It decides in
sessions that a person watches too: with the plugin on, the only Bash permission dialog you see is the privacy check's
(see below).

## What it allows

An `rm`, or `cd <absolute dir> && rm`, whose every path resolves inside the session's worktree or a temp directory
(`/tmp`, `$TMPDIR`). The worktree is the nearest ancestor of the session's cwd that has a `.git` entry. The options are
`-f`, `-r`, `-R`, `-v`, `-d` and their long forms.

## What it leaves to the person

A command that contains the signed-in user's email address (`oauthAccount.emailAddress` in `~/.claude.json`, in any
case). Claude Code's privacy check raises a permission request for such a command, also in `bypassPermissions` mode,
and only the person can answer it. The hook writes no decision, so Claude Code shows its own prompt. The request input
does not name the check that raised it, so the hook uses the address.

## What it denies

Everything else, with this message to the agent:

> No. Too aggro for an unattended run (_reason_). Split the chained command, use absolute paths, and scope any delete
> to the worktree. If it cannot be done another way, stop and tell your coordinator or the person you work for in text.

Among them:

- any other command, and `sudo rm`;
- a pipe, `;`, `&`, a redirect, `$`, a backtick, `~` or another shell character, also inside quotes;
- more than one `&&`, or a chain that is not `cd <absolute dir> && rm`;
- a path that resolves outside the worktree and the temp directories, also through a symlink or `..`;
- the whole worktree or a whole temp directory, a glob over a whole temp directory, a recursive glob over the whole
  worktree, a glob with a trailing slash, and a dot glob;
- an `rm` in a session whose worktree root contains `$HOME`.

The reason names the first problem it finds. A command that is not `rm` gets "`<command>` is not on the allow list",
whatever the cwd. The hook finds the worktree root only for an `rm`.

When the session's worktree root contains `$HOME`, every deny message ends with: "This session runs from the home
folder: ask the person to `/cd` into the project folder."

A crash or a timeout (10 seconds) also denies: the hook has `"onFailure": "block"`.

## Log

One JSON line per request in `~/.claude/logs/permission-triage.jsonl`: time, session and agent IDs, cwd, the first 200
characters of the command, the decision (`allow`, `deny` or `passthrough`) and the reason.

## Node

The hook is TypeScript that Node runs directly, so it needs Node 22.18 or later. Hooks do not get the interactive
`PATH`, and a version-manager shim on `PATH` (proto's, for example) selects node from the session cwd's `.prototools`.
`hooks/run.sh` runs the first of these that is executable: `$PERMISSION_TRIAGE_NODE`, `/opt/homebrew/bin/node`,
`/usr/local/bin/node`, then `node` on `PATH`.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install permission-triage@rikclaude
```

Pick **user** scope. Remove any copy of the hook in `settings.json`, or each prompt runs it twice.

## Test

`node --test test/plugin-permission-triage.test.js` from the repository root runs 50 commands through `hooks/run.sh`.

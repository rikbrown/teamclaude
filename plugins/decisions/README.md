# decisions

Keeps a ledger of the decisions that Claude asks you to make, so that "D1–D6 are still open" never points 300 turns
up the transcript, and keeps the answers that Claude gives you easy to find.

- Claude records each decision with the `decisions` tool: title, full text, options and a recommendation. The tool
  gives the IDs (`D1`, `D2`, …), so Claude cannot use an ID that the ledger does not have.
- The transcript draws each raised decision in full at the call, with its options as `D3a`, `D3b`.
- The band above the prompt shows the open IDs. Click one to open it in the pane and jump to it.
- The **Decisions** pane lists the open decisions. Ruled and withdrawn decisions are hidden until you click the
  `▸ Ruled` or `▸ Withdrawn` heading. Click a row to scroll the transcript to where Claude last raised or changed it,
  and to show or hide its full text. Click an option to put `D3a ` in the prompt. The pane closes when the last open
  decision is ruled or withdrawn.
- `/decisions` shows or hides the pane. `/decisions D3` shows D3 and jumps to it.

## Replies

Claude often answers a question and then does several screens of other work, so the answer is hard to find.

- The last text of each turn that your prompt starts becomes a reply. The transcript draws it between two cyan rules,
  as bright text on a dark teal background, with no side borders or padding, so a copied line holds only its text. The
  top rule names the reply's ID (`R1`, `R2`, …) and the first line of your prompt. A turn that a notification starts,
  such as a finished agent's, makes no reply.
- A reply draws its own prose: headings, lists, and bold, code and links in a line. Code blocks and tables draw as
  markdown. Italics and nested formatting show as written.
- When Claude answers you and more work follows in the same turn, it calls the `reply` tool. The transcript draws that
  answer in the same way, under a short form of your question that Claude writes.
- The band above the prompt shows `↳ Unread: R2` until you click the ID or send your next prompt. A click jumps to the
  reply.
- The pane lists this session's replies under **Replies**. Unread replies are bold. Click a row to jump to the reply and
  to show or hide its text. `/decisions R2` does the same.
- `ctrl+x r`, or `/next-reply`, jumps to the oldest unread reply. With none unread, it jumps to the newest reply, then
  to each older one in turn, and wraps round. The hint line under the prompt shows `↳ ctrl+x r`, cyan while a reply is
  unread; a click does the same. Claude Code gives a plugin no keybinding action of its own, so the button borrows
  `diff:nextFile`, which only the diff dialog handles. Bind the chord under `Global` in `~/.claude/keybindings.json`:
  `"ctrl+x r": "diff:nextFile"`. While the diff dialog is open, the chord goes to the next file there.
- Text that Claude writes before a tool call in the same turn draws dim. The last text of a turn and the reply boxes
  stay at full brightness.

One ledger for each worktree (the session's project root), kept across sessions, `/clear` and restarts. A ruled or
withdrawn decision stays for 7 days. The IDs start again at `D1` when the ledger is empty.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude Code update can
change the API under it. Tested on Claude Code 2.1.317.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install decisions@rikclaude
```

Pick **user** scope.

## Limits

- The pane docks beside the transcript only in the fullscreen layout (`"tui": "fullscreen"`). Claude opens it when it
  raises a decision only if the terminal is wide enough for a sidebar; otherwise the band shows the IDs and `/decisions`
  opens the pane at any width.
- A jump works only in the fullscreen layout, and only to a row in this session's transcript. A decision that a
  subagent or an earlier session raised has the full text in the pane but no row to jump to.
- Replies belong to the session and its transcript: a restart or `--resume` starts with none. A reply from a subagent
  is refused.
- The dim text and the reply at the end of a turn need the rows from the time that the mod is loaded. A turn that runs
  while the mod loads or reloads keeps its text bright and makes no reply at its end.
- Two sessions in one worktree share the ledger. A session reads the other's changes at its next prompt.

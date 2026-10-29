# copy-quote

Claude often writes a draft for you to send (an email, a reply, a message) as a markdown quote. The terminal draws
each quoted line with a `▎` bar, and a copy from the terminal takes the bars with the text.

This mod adds a dim `[ Copy ]` button under each reply that holds a quote. A click copies the quote without the bars.
A reply with several quotes gets `[ Copy 1 ] [ Copy 2 ]`, one for each quote.

It is a Claude Code **mod**: a plugin of function hooks. Mods are an early-access feature, so a Claude Code update can
change the API under it. Tested on Claude Code 2.1.312.

## Install

```
/plugin marketplace add rikbrown/teamclaude
/plugin install copy-quote@rikclaude
```

Pick **user** scope.

## What it copies

- The text of each run of `>` lines, with the `> ` prefix removed.
- `**bold**`, `__bold__` and `` `code` `` lose their markers, so the copy reads as the terminal draws it. Links and
  lists stay as written.
- A `>` line inside a code fence is not a quote.

## Limits

- The buttons are under the whole reply, not under each quote.
- A click needs the fullscreen layout. The classic layout does not send clicks to a mod.
- The mod changes the drawing only. The stored reply, and what the model reads, stay the same.

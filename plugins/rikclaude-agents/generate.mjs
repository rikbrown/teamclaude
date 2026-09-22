#!/usr/bin/env node
// Regenerates this plugin's effort-pinned subagent definitions in agents/.
//
// Why these exist: the Agent tool's per-call `model` parameter is an alias enum
// (sonnet|opus|haiku|fable) with no effort control, so a direct dispatch silently
// inherits the parent session's effort. An agent DEFINITION can pin both, so each
// model gets one file per effort level and the orchestrator names the agent type.
//
// Why every rule spells a prefix: Claude Code namespaces plugin agents as
// `<plugin>:<agent>`, so the dispatchable name is `rikclaude-agents:fable-medium`
// and not `fable-medium`. A bare name left in a rule names nothing the harness can
// resolve, which lands the caller back on the effort-less direct dispatch these
// files exist to prevent. AGENT_PREFIX is the one place it is spelled; the
// frontmatter `name:` stays bare, because Claude Code adds the prefix itself.
//
// Why routing lives in the descriptions: the orchestrator reads each description
// at the moment it picks a subagent_type, so "when to pick this one" has to be
// there. Policy that spans all the agents cannot ride along in a CLAUDE.md — a
// plugin's own CLAUDE.md is not loaded as context — so it ships as
// hooks/subagents.md and a SessionStart hook prints it into every session.
//
// Claude Code announces agents by name only, so an edited description reaches the
// orchestrator in a NEW session, not the current one.
//
// Why each agent gets a nesting rule: a subagent that reaches the routing policy
// — whether through a CLAUDE.md or through the hook below — used to read
// "delegate liberally" as an instruction to itself, and a two-line task grew a
// tree. That bullet is now scoped to the orchestrator, and each agent prompt says
// what IT may do: none (do the work alone), brief (only if the brief says so) or
// own (its own judgement).
// `disallowedTools: Agent` in the frontmatter would enforce "none" at the harness
// level. Verified to work, deliberately not used yet; prompt first.
//
// Usage:
//   node generate.mjs            write/refresh every file
//   node generate.mjs --check    exit 1 if anything is missing or stale

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(root, 'agents');

/** The namespace Claude Code puts in front of a plugin agent's name. */
const AGENT_PREFIX = 'rikclaude-agents:';

// The roster, and the only source of truth for it. `name` is `<model>-<effort>`:
// everything after the last hyphen is the effort, everything before it is the
// model id the frontmatter carries, which has to match a `customModels` row (or
// be a built-in alias) for the dispatch to reach anything.
//
// `model` overrides that derived id, to pin a version the name does not spell —
// `opus-high` runs `claude-opus-5-5[1m]`, not whatever the `opus` alias points at.
// It also opts into 1M: a bare id or alias runs at 200K, only the `[1m]` spelling
// gets the full window, which is why the Fable rows pin `fable[1m]`.
// The frontmatter emits it unquoted: the parser takes the rest of the line, so
// quotes would come back as part of the id.
//
// `nesting` is one of none | brief | own — see the head comment.
//
// Commented-out rows are efforts that exist but are not worth listing: every row
// costs the orchestrator description text at pick time, so the roster stays the
// set somebody would actually choose between.
/** @type {{ name: string, label: string, model?: string, when: string, nesting: 'none'|'brief'|'own' }[]} */
const AGENTS = [
  { name: 'fable-medium', label: 'Fable', model: 'fable[1m]', nesting: 'none', when: `Engineering sidekick, on par with GPT-6 Astra. Full-branch, architectural or technical design review. Not for coding; use ${AGENT_PREFIX}opus-high or ${AGENT_PREFIX}opus-xhigh.` },
  { name: 'fable-high', label: 'Fable', model: 'fable[1m]', nesting: 'own', when: `Engineering sidekick, on par with GPT-6 Astra. Full-branch, architectural or technical design review for only the most complex or critical challenges. Not for coding; use ${AGENT_PREFIX}opus-high or ${AGENT_PREFIX}opus-xhigh.` },
  { name: 'fable-xhigh', label: 'Fable', model: 'fable[1m]', nesting: 'own', when: `Engineering sidekick, on par with GPT-6 Astra. Adversarial review for the most challenging reviews only, where ${AGENT_PREFIX}fable-high is not enough. Not for coding; use ${AGENT_PREFIX}opus-high or ${AGENT_PREFIX}opus-xhigh.` },
  { name: 'opus-high', label: 'Opus 5.5', model: 'claude-opus-5-5[1m]', nesting: 'brief', when: 'Default for coding tasks that are well defined, e.g. narrow fixes from PR feedback. Also the default for fact-finding.' },
  { name: 'opus-xhigh', label: 'Opus 5.5', model: 'claude-opus-5-5[1m]', nesting: 'brief', when: 'Default for larger, complex or ambiguous coding tasks.' },
  { name: 'gpt-6-astra-medium', label: 'GPT-6 Astra', nesting: 'none', when: 'Engineering sidekick, on par with Fable. Full-branch, architectural or technical design review.' },
  { name: 'gpt-6-astra-high', label: 'GPT-6 Astra', nesting: 'own', when: 'Engineering sidekick, on par with Fable. Full-branch, architectural or technical design review for only the most complex or critical challenges.' },
  // { name: 'gpt-6-astra-xhigh', label: 'GPT-6 Astra', nesting: 'own', when: 'Engineering sidekick, on par with Fable. Full-branch, architectural or technical design review for only the most complex or critical challenges.' },
  { name: 'gpt-5.6-sol-medium', label: 'GPT-5.6 Sol', nesting: 'none', when: 'Prose refinement of docs. Weak at coding. Skip prose refinement if Astra already rewrote most of a doc in its review pass.' },
  { name: 'gpt-5.6-sol-xhigh', label: 'GPT-5.6 Sol', nesting: 'none', when: `Interim or light review of code. Use a ${AGENT_PREFIX}gpt-6-astra-* agent if architectural decisions are needed. Weak at coding.` },
  // { name: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol', nesting: 'none', when: `Use only when the user names it; for prose, prefer ${AGENT_PREFIX}gpt-5.6-sol-medium. Weak at coding.` },
  { name: 'gpt-5.6-luna-medium', label: 'GPT-5.6 Luna', nesting: 'none', when: 'Haiku-level tasks only. Weak at coding.' },
  { name: 'gpt-5.6-terra-medium', label: 'GPT-5.6 Terra', nesting: 'none', when: 'Prose refinement of comments and messages. Use freely without asking for regular touch up. Weak at coding.' },
];

// Named once so an agent prompt and the policy block cannot drift apart on the
// one rule that matters most.
const EFFORT_RULE = `Use only the effort-named agent types (\`${AGENT_PREFIX}fable-*\`, \`${AGENT_PREFIX}opus-*\`, \`${AGENT_PREFIX}gpt-*-*\`) — never dispatch a model directly, which silently inherits this session's effort.`;

/** The paragraph that tells one agent whether it may launch agents of its own. */
function nestingParagraph(nesting) {
  switch (nesting) {
    case 'none':
      return 'Do the work in the brief yourself. Do not launch subagents. If you believe the work needs another agent, say so in your report instead.';
    case 'brief':
      return `Do the work in the brief yourself. Launch a subagent only if the brief tells you to. ${EFFORT_RULE}`;
    case 'own':
      return `Do the work in the brief yourself when you can. You may launch subagents when you judge that the work needs them; report what you delegated and why. Your model was chosen specifically for its ability to execute this task so do not over-delegate back to other classes of models (e.g. Astra to Fable). ${EFFORT_RULE}`;
    default:
      throw new Error(`unknown nesting rule: ${nesting}`);
  }
}

/** One agent file, frontmatter and prompt. */
function render({ name, label, model = name.slice(0, name.lastIndexOf('-')), when, nesting }) {
  const effort = name.slice(name.lastIndexOf('-') + 1);
  return `---
name: ${name}
description: ${label} at ${effort} effort. ${when}
model: ${model}
effort: ${effort}
---

You are an engineering subagent running on ${label} at ${effort} effort. The orchestrator gives you a complete brief. Do the work in the brief and nothing outside it. Use the skills the brief names. Report what you changed, what you verified, and any part of the brief you could not complete, with the reason.

${nestingParagraph(nesting)}
`;
}

const check = process.argv.includes('--check');
const expected = new Map();
let stale = 0;

for (const agent of AGENTS) {
  // `: ` anywhere in the description would end the YAML key early and take the
  // rest of the line with it, so the whole frontmatter stops parsing.
  if (agent.when.includes(': ')) {
    console.error(`description for ${agent.name} contains ': ', which breaks the YAML frontmatter`);
    process.exit(1);
  }
  const file = `${agent.name}.md`;
  const body = render(agent);
  expected.set(file, body);
  if (!check) continue;
  let current = null;
  try {
    current = readFileSync(join(agentsDir, file), 'utf8');
  } catch { /* missing reads as stale */ }
  if (current !== body) {
    console.error(`stale or missing: agents/${file}`);
    stale = 1;
  }
}

if (!check) for (const [file, body] of expected) writeFileSync(join(agentsDir, file), body);

// Flag any other .md in there, so a renamed model does not leave a ghost agent
// behind — a plugin ships what is on disk, not what this roster says.
for (const file of readdirSync(agentsDir)) {
  if (file.endsWith('.md') && !expected.has(file)) console.error(`not generated by this script: agents/${file}`);
}

if (check) {
  if (!stale) console.log(`all ${expected.size} agent files up to date`);
  process.exit(stale);
}
console.log(`wrote ${expected.size} agent files`);
console.log('verify they loaded: run /agents in a new session (a stale file list means a parse error)');

#!/usr/bin/env node
// Regenerates the agent definitions in agents/ and the role table and child session briefs in hooks/routing.md.
//
// An agent definition pins the model and effort. A direct dispatch inherits the
// parent session's effort. Claude Code adds the namespace to the frontmatter name.
//
// The routing table is for the orchestrator. An agent description names its role.
// A SessionStart hook prints the policy because Claude Code does not load a plugin's CLAUDE.md.
// Changes to agent descriptions take effect in a new session.
//
// Each agent prompt has a nesting rule: none (do the work alone), brief (only if
// the brief says so) or own (its own judgement).
// `disallowedTools: Agent` in the frontmatter would enforce "none" at the harness
// level. Verified to work, deliberately not used yet; prompt first.
// Sol prompts add a rule that the brief wins over a harness default.
//
// Usage:
//   node generate.mjs            write/refresh every file
//   node generate.mjs --check    exit 1 if anything is missing or stale

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(root, 'agents');
const routingPath = join(root, 'hooks', 'routing.md');

/** The namespace Claude Code puts in front of a plugin agent's name. */
const AGENT_PREFIX = 'rikclaude-agents:';

// `name` is `<model>-<effort>`. `model` overrides the derived model ID to pin a
// version or the 1M context window. An unpinned ID or alias runs at 200K.
// The frontmatter leaves the model ID unquoted. The parser keeps any quotes.
//
// `byName` limits use to agents named by the user or a local override. `render`
// puts this restriction before the role text.
// `nesting` is one of none | brief | own.
/** @type {{ name: string, label: string, model?: string, when: string, nesting: 'none'|'brief'|'own', byName?: boolean }[]} */
const AGENTS = [
  { name: 'opus-medium', label: 'Opus 5.5', model: 'claude-opus-5-5[1m]', nesting: 'brief', when: 'Settled coding. The default for research.' },
  { name: 'opus-high', label: 'Opus 5.5', model: 'claude-opus-5-5[1m]', nesting: 'brief', when: 'Open coding. Code review. QA and browser checks. Research on how code behaves.' },
  { name: 'opus-xhigh', label: 'Opus 5.5', model: 'claude-opus-5-5[1m]', nesting: 'brief', byName: true, when: 'Research with a wide scope. Never for coding.' },
  { name: 'sonnet-high', label: 'Sonnet 5.5', model: 'claude-sonnet-5-5[1m]', nesting: 'none', when: 'Exploration. Throwaway code that is not committed.' },
  { name: 'sonnet-xhigh', label: 'Sonnet 5.5', model: 'claude-sonnet-5-5[1m]', nesting: 'none', byName: true, when: 'Exploration across many files.' },
  { name: 'fable-medium', label: 'Fable 5.2', model: 'claude-fable-5-2[1m]', nesting: 'none', byName: true, when: 'Research and technical design that need heavy reasoning. Does not code or review code.' },
  { name: 'fable-high', label: 'Fable 5.2', model: 'claude-fable-5-2[1m]', nesting: 'own', when: 'Design or plan review, with Astra. Research with the widest scope. Does not code or review code.' },
  { name: 'fable-xhigh', label: 'Fable 5.2', model: 'claude-fable-5-2[1m]', nesting: 'own', when: 'The hardest design or plan review, with Astra. Does not code or review code.' },
  { name: 'gpt-6.2-astra-medium', label: 'GPT-6.2 Astra', nesting: 'none', when: 'Second reviewer. Never dispatch it alone.' },
  { name: 'gpt-6.2-astra-high', label: 'GPT-6.2 Astra', nesting: 'own', byName: true, when: 'A design or plan review at higher effort.' },
  // { name: 'gpt-6.2-astra-xhigh', label: 'GPT-6.2 Astra', nesting: 'own', byName: true, when: `Otherwise use ${AGENT_PREFIX}gpt-6.2-astra-medium in the review tag-team.` },
  { name: 'haiku-medium', label: 'Haiku 5.5', model: 'claude-haiku-5-5[1m]', nesting: 'none', when: 'Quick, cheap tasks. Not for production code.' },
  { name: 'gpt-6-luna-medium', label: 'GPT-6 Luna', nesting: 'none', byName: true, when: 'Quick, cheap tasks. Weak at coding.' },
  { name: 'gpt-6.2-sol-xhigh', label: 'GPT-6.2 Sol', nesting: 'none', when: 'Small settled coding.' },
  // { name: 'gpt-6.2-sol-high', label: 'GPT-6.2 Sol', nesting: 'none', byName: true, when: 'Light or interim code review. Weak at coding.' },
  { name: 'gpt-6.1-terra-medium', label: 'GPT-6.1 Terra', nesting: 'none', byName: true, when: 'Prose refinement of docs, comments and messages.' },
  // Gemini 4 Neon includes the thinking level in the model ID.
  { name: 'gemini-4-neon-medium', label: 'Gemini 4 Neon', model: 'gemini-4-neon-medium', nesting: 'none', byName: true, when: 'On trial. Coding and research.' },
  { name: 'gemini-4-neon-high', label: 'Gemini 4 Neon', model: 'gemini-4-neon-high', nesting: 'none', byName: true, when: 'On trial. Coding, code review and research.' },
  { name: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon', model: 'gemini-4-neon-xhigh', nesting: 'none', byName: true, when: 'On trial. Hard research and design.' },
];

const ROLES = [
  { role: 'Small settled coding', agents: ['gpt-6.2-sol-xhigh'], applies: 'A fix round with exact findings, a rebase, PR or CI feedback. New code only if the brief lists the files and functions to add, in 5 source files or fewer.' },
  { role: 'Settled coding', agents: ['opus-medium'], applies: 'The brief settles the design and, for a bug, names the cause. Any size: split a large plan into parts.' },
  { role: 'Open coding', agents: ['opus-high'], applies: 'The coder must decide a design question, find the cause of a bug, or write model text or an eval rubric.' },
  { role: 'Throwaway code', agents: ['sonnet-high'], applies: 'Code that is not committed. If a bug in it can reach a user, it is Settled coding.' },
  { role: 'Code review', agents: ['opus-high'], applies: 'A PR, a branch, a commit or a diff, by an agent that did not write the code.' },
  { role: 'Second reviewer', agents: ['gpt-6.2-astra-medium'], applies: 'With the Code review agent, on the first review only: a risky change, or above about 400 source lines.' },
  { role: 'Design or plan review', agents: ['fable-high', 'gpt-6.2-astra-medium'], applies: `Before code exists. For the hardest, name \`${AGENT_PREFIX}fable-xhigh\` in place of fable-high.` },
  { role: 'Research', agents: ['opus-medium'], applies: `Fact-finding. Use \`${AGENT_PREFIX}opus-high\` to reason through how code behaves, and \`${AGENT_PREFIX}fable-high\` for the widest scope.` },
  { role: 'QA and browser checks', agents: ['opus-high'], applies: 'Release QA and browser checks of a change.' },
  { role: 'Exploration', agents: ['sonnet-high'], applies: `Locating code or summarising a module. Or the built-in \`Explore\` agent. Across many files, \`${AGENT_PREFIX}opus-medium\`.` },
  { role: 'Quick, cheap tasks', agents: ['haiku-medium'], applies: 'Not for production code.' },
];

function modelFor({ name, model }) {
  return model ?? name.slice(0, name.lastIndexOf('-'));
}

function renderRoles() {
  const models = new Map(AGENTS.map(agent => [agent.name, modelFor(agent)]));
  const lines = ['| Role | Agent | Model | Applies when |', '| --- | --- | --- | --- |'];
  for (const { role, agents, applies } of ROLES) {
    const types = agents.map(name => `\`${AGENT_PREFIX}${name}\``).join(' + ');
    const ids = agents.map(name => {
      const model = models.get(name);
      if (!model) throw new Error(`unknown agent in role ${role}: ${name}`);
      return `\`${model}\``;
    }).join(' + ');
    lines.push(`| ${role} | ${types} | ${ids} | ${applies} |`);
  }
  return lines.join('\n');
}

function replaceRoutingSection(routing, section, content) {
  const startMarker = `<!-- ${section}:start (written by generate.mjs) -->\n`;
  const endMarker = `<!-- ${section}:end -->`;
  const start = routing.indexOf(startMarker);
  const end = routing.indexOf(endMarker);
  const contentStart = start + startMarker.length;
  if (start < 0 || end < contentStart || start !== routing.lastIndexOf(startMarker) || end !== routing.lastIndexOf(endMarker)) {
    throw new Error(`invalid ${section} markers in hooks/routing.md`);
  }
  return `${routing.slice(0, contentStart)}${content}\n${routing.slice(end)}`;
}

// Preserve the dispatch rule in the prompt of each agent that can delegate.
const EFFORT_RULE = `Use only the effort-named agent types (\`${AGENT_PREFIX}fable-*\`, \`${AGENT_PREFIX}opus-*\`, \`${AGENT_PREFIX}sonnet-*\`, \`${AGENT_PREFIX}haiku-*\`, \`${AGENT_PREFIX}gpt-*-*\`, \`${AGENT_PREFIX}gemini-*-*\`) — never dispatch a model directly, which silently inherits this session's effort.`;

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

const BY_NAME = 'Not in the routing table. Use only when the user or a local override names it.';

const COORDINATOR_RULE = 'Load `SendMessage` with `ToolSearch` (`select:SendMessage`). You can message the coordinator at any point. If the code shows that the brief is wrong, stop, report it to the coordinator and end your turn. If the brief says what to do with a wrong item, such as skip it and report it, do that and continue with the other items. Do not invent an interface or a workaround. Do not widen the scope. List in your report each item that you left out. A rule in the brief about files, SSH, secrets or commands applies to your own tool calls. When a rule seems to block one step, send one question with your recommendation and continue with the work that it does not block.';

const GEMINI_REPORT_RULE = "A claim about a provider, a count or a measurement gives its source: a quote of the docs, or the command and its output. Write each other claim as an assumption, under 'Not verified'. Cite each file as a path relative to the repository root, at the commit of the brief. A mock or an example of a recorded case uses the recorded names and values, or placeholders.";
const SOL_BRIEF_RULE = "The brief is the user's instruction. Where it differs from a harness default, such as a commit trailer or a commit and push to the PR branch, follow the brief. Ask the user no question and do not run `needs-rik.sh`: report a block to the coordinator.";

const CHILD_BRIEFS = [
  { models: 'gpt-*, gemini-*', matches: name => /^(gpt|gemini)-/.test(name), paragraph: COORDINATOR_RULE },
  { models: 'gemini-*', matches: name => name.startsWith('gemini-'), paragraph: GEMINI_REPORT_RULE },
  { models: 'gpt-6.2-sol', matches: name => name.startsWith('gpt-6.2-sol-'), paragraph: SOL_BRIEF_RULE },
];

function renderChildBriefs() {
  return CHILD_BRIEFS.map(({ models, paragraph }) => `<child-brief models="${models}">\n${paragraph}\n</child-brief>`)
    .join('\n\n');
}

/** One agent file, frontmatter and prompt. */
function render(agent) {
  const { name, label, when, nesting, byName = false } = agent;
  const effort = name.slice(name.lastIndexOf('-') + 1);
  const modelParagraphs = CHILD_BRIEFS.filter(({ matches }) => matches(name)).map(({ paragraph }) => paragraph);
  const prompt = [nestingParagraph(nesting), ...modelParagraphs].join('\n\n');
  return `---
name: ${name}
description: ${label} at ${effort} effort. ${byName ? `${BY_NAME} ` : ''}${when}
model: ${modelFor(agent)}
effort: ${effort}
---

You are an engineering subagent running on ${label} at ${effort} effort. The orchestrator gives you a complete brief. Do the work in the brief and nothing outside it. Use the skills the brief names. Report what you changed, what you verified, and any part of the brief you could not complete, with the reason.

${prompt}
`;
}

const check = process.argv.includes('--check');
const routing = readFileSync(routingPath, 'utf8');
const routingWithRoles = replaceRoutingSection(routing, 'roles', renderRoles());
const updatedRouting = replaceRoutingSection(routingWithRoles, 'child-briefs', renderChildBriefs());
const expected = new Map();
let stale = 0;

if (check && routing !== updatedRouting) {
  console.error('stale generated sections: hooks/routing.md');
  stale = 1;
}

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

if (!check) {
  for (const [file, body] of expected) writeFileSync(join(agentsDir, file), body);
  if (routing !== updatedRouting) writeFileSync(routingPath, updatedRouting);
}

// Report agent files that the roster does not define. The plugin ships them too.
for (const file of readdirSync(agentsDir)) {
  if (file.endsWith('.md') && !expected.has(file)) console.error(`not generated by this script: agents/${file}`);
}

if (check) {
  if (!stale) console.log(`all ${expected.size} agent files and generated routing sections are up to date`);
  process.exit(stale);
}
console.log(`wrote ${expected.size} agent files and refreshed the generated routing sections`);
console.log('verify they loaded: run /agents in a new session (a stale file list means a parse error)');

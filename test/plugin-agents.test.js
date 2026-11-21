import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Check the plugin files and run the SessionStart command without Claude Code.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = `${repoRoot}plugins/rikclaude-agents/`;
const agentsDir = `${pluginRoot}agents/`;
const routingPath = `${pluginRoot}hooks/routing.md`;

const AGENT_PREFIX = 'rikclaude-agents:';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const COORDINATOR_PARAGRAPH = 'Load `SendMessage` with `ToolSearch` (`select:SendMessage`). You can message the coordinator at any point. If the code shows that the brief is wrong, stop, report it to the coordinator and end your turn. Do not invent an interface or a workaround. Do not widen the scope. List in your report each item that you left out. A rule in the brief about files, SSH, secrets or commands applies to your own tool calls. When a rule seems to block one step, send one question with your recommendation and continue with the work that it does not block.';
const GEMINI_REPORT_PARAGRAPH = "A claim about a provider, a count or a measurement gives its source: a quote of the docs, or the command and its output. Write each other claim as an assumption, under 'Not verified'. Cite each file as a path relative to the repository root, at the commit of the brief.";
const GEMINI_TURN_PARAGRAPH = 'When you wait on a background job, write one status line and end your turn. The harness sends the notification of the result. Never write a notification, a system reminder, a `user` line or a tool result yourself.';

const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort();

/** `---`-delimited frontmatter as a flat key→value map, plus the prompt below it. */
function parseAgent(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'file does not start with a --- frontmatter block');
  /** @type {Record<string, string>} */
  const front = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2];
  }
  return { front, prompt: m[2] };
}

// ── the generator is the source of truth ─────────────────────────────────────

test('generate.mjs --check passes against the agent files and role table', () => {
  const r = spawnSync(process.execPath, [`${pluginRoot}generate.mjs`, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // The generator reports extra agent files on stderr without setting a nonzero exit code.
  assert.equal(r.stderr, '');
});

test('the roster is not empty', () => {
  assert.ok(agentFiles.length > 0);
});

test('the role table names plugin agents and uses their pinned models', () => {
  const routing = readFileSync(routingPath, 'utf8');
  const table = /<!-- roles:start \(written by generate\.mjs\) -->\n([\s\S]+?)\n<!-- roles:end -->/.exec(routing);
  assert.ok(table, 'role table is missing');
  const [header, separator, ...rows] = table[1].split('\n');
  const cells = line => line.split('|').slice(1, -1).map(cell => cell.trim());
  assert.deepEqual(cells(header), ['Role', 'Agent', 'Model', 'Applies when']);
  assert.deepEqual(cells(separator), ['---', '---', '---', '---']);
  assert.ok(rows.length > 0, 'role table is empty');

  for (const row of rows) {
    const fields = cells(row);
    assert.equal(fields.length, 4, row);
    const [role, agentCell, modelCell] = fields;
    const agents = agentCell.split(' + ');
    const models = modelCell.split(' + ');
    assert.equal(agents.length, models.length, role);
    for (const [index, agent] of agents.entries()) {
      assert.match(agent, /^`[^`]+`$/, role);
      assert.ok(agent.startsWith(`\`${AGENT_PREFIX}`), `${role}: unprefixed agent ${agent}`);
      const file = `${agent.slice(1 + AGENT_PREFIX.length, -1)}.md`;
      assert.ok(agentFiles.includes(file), `${role}: missing agent ${file}`);
      const { front } = parseAgent(readFileSync(`${agentsDir}${file}`, 'utf8'));
      assert.equal(models[index], `\`${front.model}\``, `${role}: model for ${agent}`);
    }
  }
});

// ── manifests ────────────────────────────────────────────────────────────────

test('plugin.json parses and names the plugin the agents are namespaced under', () => {
  const manifest = JSON.parse(readFileSync(`${pluginRoot}.claude-plugin/plugin.json`, 'utf8'));
  assert.equal(manifest.name, 'rikclaude-agents');
  assert.equal(`${manifest.name}:`, AGENT_PREFIX);
  assert.match(manifest.name, /^[a-z0-9-]+$/, 'plugin name must be kebab-case');
  assert.ok(manifest.description);
});

test('marketplace.json parses and every plugin source resolves', () => {
  const market = JSON.parse(readFileSync(`${repoRoot}.claude-plugin/marketplace.json`, 'utf8'));
  assert.equal(market.name, 'rikclaude');
  assert.ok(market.owner?.name);
  assert.ok(Array.isArray(market.plugins) && market.plugins.length > 0);
  for (const entry of market.plugins) {
    assert.match(entry.name, /^[a-z0-9-]+$/);
    // Relative sources only resolve for a marketplace added from git or a local
    // path, which is what docs/agents.md tells people to do.
    assert.ok(entry.source.startsWith('./'), `${entry.name}: source must be a ./ path`);
    assert.ok(existsSync(`${repoRoot}${entry.source.slice(2)}/.claude-plugin/plugin.json`), `${entry.name}: source has no plugin manifest`);
  }
  assert.ok(market.plugins.some(p => p.name === 'rikclaude-agents'));
});

// ── the SessionStart hook ────────────────────────────────────────────────────

test('hooks.json parses and every path it names exists', () => {
  const hooks = JSON.parse(readFileSync(`${pluginRoot}hooks/hooks.json`, 'utf8'));
  const entries = hooks.hooks?.SessionStart;
  assert.ok(Array.isArray(entries) && entries.length > 0, 'no SessionStart hook');
  let commands = 0;
  for (const group of entries) {
    for (const hook of group.hooks) {
      // A `command` hook is the one that runs at launch and whose plain stdout
      // Claude Code adds to the session context.
      assert.equal(hook.type, 'command');
      assert.equal(hook.timeout, 5);
      commands++;
      const paths = [...hook.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"']+)/g)].map(m => m[1]);
      assert.ok(paths.includes('hooks/routing.md'), 'hook command does not name the routing policy');
      for (const p of paths) assert.ok(existsSync(`${pluginRoot}${p}`), `hook points at a missing file: ${p}`);
    }
  }
  assert.equal(commands, 1, 'one hook is enough; every session pays for each');
});

test('SessionStart prints the policy before the local override and skips missing files', () => {
  const hooks = JSON.parse(readFileSync(`${pluginRoot}hooks/hooks.json`, 'utf8'));
  const { command } = hooks.hooks.SessionStart[0].hooks[0];
  const routing = readFileSync(routingPath, 'utf8');
  const override = '# Local trial overrides\n\n| Role | Change | When | Report |\n| --- | --- | --- | --- |\n| Research | Trial another agent | This session | Compare findings |\n';
  const home = mkdtempSync(join(repoRoot, '.rikclaude-agents-test-'));
  const missingPluginRoot = join(home, 'missing-plugin');
  function runHook(root, stdout) {
    const r = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, stdout);
  }

  try {
    runHook(pluginRoot, routing);
    runHook(missingPluginRoot, '');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'rikclaude-agents.local.md'), override);
    runHook(pluginRoot, routing + override);
    runHook(missingPluginRoot, override);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── agent frontmatter ────────────────────────────────────────────────────────

for (const file of agentFiles) {
  test(`${file} has usable frontmatter`, () => {
    const { front } = parseAgent(readFileSync(`${agentsDir}${file}`, 'utf8'));
    // Claude Code can fall back to the filename or a generic description when the frontmatter is invalid.
    assert.equal(front.name, file.replace(/\.md$/, ''));
    assert.ok(front.model, 'no model');
    assert.ok(EFFORTS.has(front.effort), `effort ${JSON.stringify(front.effort)} is not one of ${[...EFFORTS].join('|')}`);
    assert.ok(front.description, 'no description');
    // `: ` breaks the YAML frontmatter.
    assert.ok(!front.description.includes(': '), "description contains ': '");
    assert.ok(front.name.endsWith(`-${front.effort}`), 'name must be <model>-<effort>');
    if (front.name.startsWith('gemini-')) {
      assert.equal(front.model, front.name, 'the Gemini model ID includes the effort');
    } else {
      const family = front.name.slice(0, -`-${front.effort}`.length);
      const model = front.model.replace(/\[1m\]$/, '');
      assert.ok(model === family || model.startsWith(`claude-${family}-`), `model ${front.model} does not match name ${front.name}`);
    }
    assert.ok(!/["']/.test(front.model), 'model must be unquoted');
  });

  test(`${file} has the required prompt paragraphs`, () => {
    const { prompt } = parseAgent(readFileSync(`${agentsDir}${file}`, 'utf8'));
    const paragraphs = prompt.trim().split('\n\n');
    const hasCoordinator = /^(gpt|gemini)-/.test(file);
    const isGemini = file.startsWith('gemini-');
    assert.equal(paragraphs.length, isGemini ? 5 : hasCoordinator ? 3 : 2);
    assert.equal(paragraphs.indexOf(COORDINATOR_PARAGRAPH), hasCoordinator ? 2 : -1);
    assert.equal(paragraphs.indexOf(GEMINI_REPORT_PARAGRAPH), isGemini ? 3 : -1);
    assert.equal(paragraphs.indexOf(GEMINI_TURN_PARAGRAPH), isGemini ? 4 : -1);
  });
}

// ── no bare agent names in any rule text ─────────────────────────────────────

// Anything shaped like an agent name — `<model>-<effort>` or a glob of one, for
// any model family the roster has ever carried — must carry the prefix wherever
// it appears in prose. Matched by shape rather than from the roster, so a name
// that is commented out of the roster (or not in it yet) is still caught.
const BARE_AGENT = /(?<![\w:.-])(?:fable|opus|sonnet|haiku|gpt-(?:\*|[\w.]+?(?:-[a-z]+)?))-(?:low|medium|high|xhigh|max|\*)(?![\w-])/g;

/** Every agent-shaped token in `text` that is not preceded by the namespace. */
function bareUses(text) {
  return [...text.matchAll(BARE_AGENT)].map(m => m[0]);
}

/** Prose only: the frontmatter identity lines carry bare names by design. */
function ruleText(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return text;
  const front = m[1].split('\n').filter(line => !/^(name|model|effort):/.test(line)).join('\n');
  return `${front}\n${m[2]}`;
}

test('bareUses catches names the roster does not carry, and only bare ones', () => {
  const bad = 'use fable-medium or gpt-6-astra-xhigh, haiku-medium, `gpt-5.6-sol-*`, opus-*, sonnet-xhigh or gpt-*-*; model: fable-high';
  assert.deepEqual(bareUses(bad), ['fable-medium', 'gpt-6-astra-xhigh', 'haiku-medium', 'gpt-5.6-sol-*', 'opus-*', 'sonnet-xhigh', 'gpt-*-*', 'fable-high']);
  assert.deepEqual(bareUses('`rikclaude-agents:fable-medium`, rikclaude-agents:gpt-*-*, rikclaude-agents:sonnet-high, gpt-6-astra, Fable, high effort'), []);
});

for (const file of agentFiles) {
  test(`${file} names other agents with the plugin prefix`, () => {
    const text = ruleText(readFileSync(`${agentsDir}${file}`, 'utf8'));
    assert.deepEqual(bareUses(text), [], `bare agent name in ${file}`);
  });
}

test('the injected policy uses the plugin prefix for dispatch targets', () => {
  const text = readFileSync(routingPath, 'utf8');
  // These two bare names are examples of what not to dispatch.
  const dispatchRules = text
    .replace(/a bare name such as\s+`opus-high` resolves to nothing/, '')
    .replace(/in place of fable-high\./, '');
  assert.deepEqual(bareUses(dispatchRules), [], 'bare agent name in hooks/routing.md');
  assert.match(text, /inherits this session's effort/);
  assert.match(text, /`model` parameter with an agent type: it replaces the agent's model and keeps its effort/);
});

test('the routing policy keeps the Gemini effort rule', () => {
  // `--effort` has no effect on a Gemini model, so a child session that passes
  // only the flag runs at the effort its model id names.
  const routing = readFileSync(routingPath, 'utf8');
  assert.match(routing, /A Gemini model takes its effort only from its model id\./);
  for (const file of agentFiles.filter(f => f.startsWith('gemini-'))) {
    const { front } = parseAgent(readFileSync(`${agentsDir}${file}`, 'utf8'));
    assert.equal(front.model, file.slice(0, -'.md'.length), `${file} must pin the effort in its model id`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Covers the `rikclaude-agents` Claude Code plugin (docs/agents.md): the
// effort-pinned subagent definitions this repo ships as a plugin, the
// marketplace entry that makes them installable, and the SessionStart hook that
// carries the routing policy a plugin cannot ship as a CLAUDE.md.
//
// These are file-shape assertions, not behaviour: nothing here runs Claude Code.
// What they protect is the part that fails silently — a stale generated file, a
// manifest that stopped parsing, a hook pointing at a path that moved, or an
// agent reference written WITHOUT the `rikclaude-agents:` prefix. The last one
// is the whole point of the plugin: plugin agents are namespaced, so a bare name
// in a rule names nothing, and the caller falls back to dispatching a model
// directly at whatever effort the session is on.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = `${repoRoot}plugins/rikclaude-agents/`;
const agentsDir = `${pluginRoot}agents/`;

const AGENT_PREFIX = 'rikclaude-agents:';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

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

test('generate.mjs --check passes against the committed agent files', () => {
  const r = spawnSync(process.execPath, [`${pluginRoot}generate.mjs`, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // Any .md the roster did not produce is reported on stderr and would ship as
  // a ghost agent, so treat it as a failure here even though --check does not.
  assert.equal(r.stderr.trim(), '', r.stderr);
});

test('the roster is not empty', () => {
  assert.ok(agentFiles.length > 0);
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
      commands++;
      const paths = [...hook.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"']+)/g)].map(m => m[1]);
      assert.ok(paths.length > 0, 'hook command names no plugin file');
      for (const p of paths) assert.ok(existsSync(`${pluginRoot}${p}`), `hook points at a missing file: ${p}`);
    }
  }
  assert.equal(commands, 1, 'one hook is enough; every session pays for each');
});

// ── agent frontmatter ────────────────────────────────────────────────────────

for (const file of agentFiles) {
  test(`${file} has usable frontmatter`, () => {
    const { front } = parseAgent(readFileSync(`${agentsDir}${file}`, 'utf8'));
    // Claude Code falls back to the filename when `name` is missing, and to a
    // generic description when the frontmatter does not parse — both silently,
    // so assert rather than rely on it.
    assert.equal(front.name, file.replace(/\.md$/, ''));
    assert.ok(front.model, 'no model');
    assert.ok(EFFORTS.has(front.effort), `effort ${JSON.stringify(front.effort)} is not one of ${[...EFFORTS].join('|')}`);
    assert.ok(front.description, 'no description');
    // `: ` would close the YAML key early and take the rest of the frontmatter
    // with it.
    assert.ok(!front.description.includes(': '), "description contains ': '");
    assert.ok(front.name.startsWith(`${front.model}-`), 'name must be <model>-<effort>');
    assert.equal(front.name, `${front.model}-${front.effort}`);
  });
}

// ── no bare agent names in any rule text ─────────────────────────────────────

// Anything shaped like an agent name — `<model>-<effort>` or a glob of one, for
// any model family the roster has ever carried — must carry the prefix wherever
// it appears in prose. Matched by shape rather than from the roster, so a name
// that is commented out of the roster (or not in it yet) is still caught.
const BARE_AGENT = /(?<![\w:.-])(?:fable|opus|gpt-(?:\*|[\w.]+?(?:-[a-z]+)?))-(?:low|medium|high|xhigh|max|\*)(?![\w-])/g;

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
  const bad = 'use fable-medium or gpt-6-astra-xhigh, `gpt-5.6-sol-*`, opus-* or gpt-*-*; model: fable-high';
  assert.deepEqual(bareUses(bad), ['fable-medium', 'gpt-6-astra-xhigh', 'gpt-5.6-sol-*', 'opus-*', 'gpt-*-*', 'fable-high']);
  assert.deepEqual(bareUses('`rikclaude-agents:fable-medium`, rikclaude-agents:gpt-*-*, gpt-6-astra, Fable, high effort'), []);
});

for (const file of agentFiles) {
  test(`${file} names other agents with the plugin prefix`, () => {
    const text = ruleText(readFileSync(`${agentsDir}${file}`, 'utf8'));
    assert.deepEqual(bareUses(text), [], `bare agent name in ${file}`);
  });
}

test('the injected policy block names every agent with the plugin prefix', () => {
  const text = readFileSync(`${pluginRoot}hooks/subagents.md`, 'utf8');
  assert.deepEqual(bareUses(text), [], 'bare agent name in hooks/subagents.md');
  // The two rules the block exists for. Losing either silently restores the
  // effort-less dispatch.
  assert.match(text, /inherits this session's effort/);
  assert.match(text, /`model` parameter/);
});

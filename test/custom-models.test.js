import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeEnvLines, buildCustomModelSettings, buildCustomModelVars } from '../src/claude-env.js';

// Covers custom-model registration (codex-proxy feature): `config.customModels`
// entries surfaced to Claude Code so third-party models (e.g. gpt-5.6-sol via
// the codex sidecar) are pickable in /model under their REAL names, accepted
// when typed, and sized to their real context window.

const models = [
  { model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI via codex sidecar', contextTokens: 272_000 },
  { model: 'gpt-5.6-luna', contextTokens: 200_000 },
];

// ── --settings JSON (run mode: /model picker rows) ───────────────────────────

test('buildCustomModelSettings emits modelPicker rows in order, without contextTokens', () => {
  const parsed = JSON.parse(buildCustomModelSettings(models));
  assert.deepEqual(parsed, {
    modelPicker: {
      options: [
        { model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI via codex sidecar' },
        { model: 'gpt-5.6-luna' }, // absent label/description omitted, not null
      ],
    },
  });
});

test('buildCustomModelSettings returns null when nothing is configured', () => {
  assert.equal(buildCustomModelSettings([]), null);
  assert.equal(buildCustomModelSettings(undefined), null);
});

// ── env vars (env mode: typed /model + window sizing) ────────────────────────

test('buildCustomModelVars registers the first model and sizes to the largest window', () => {
  assert.deepEqual(buildCustomModelVars(models), {
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'gpt-5.6-sol',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'GPT-5.6 Sol',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'OpenAI via codex sidecar',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000',
  });
});

test('buildCustomModelVars omits vars it has no data for', () => {
  assert.deepEqual(buildCustomModelVars([{ model: 'gpt-5.6-terra' }]), {
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'gpt-5.6-terra',
  });
  assert.deepEqual(buildCustomModelVars([]), {});
  assert.deepEqual(buildCustomModelVars(undefined), {});
});

// ── env command lines ────────────────────────────────────────────────────────

test('buildClaudeEnvLines appends shell-quoted custom model exports', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: true, customModels: models });
  assert.ok(lines.includes("export ANTHROPIC_CUSTOM_MODEL_OPTION='gpt-5.6-sol'"));
  assert.ok(lines.includes("export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='GPT-5.6 Sol'")); // space survives eval
  assert.ok(lines.includes("export CLAUDE_CODE_MAX_CONTEXT_TOKENS='272000'"));
});

test('buildClaudeEnvLines is unchanged without customModels', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: true });
  assert.ok(!lines.some(l => l.includes('CUSTOM_MODEL')));
});

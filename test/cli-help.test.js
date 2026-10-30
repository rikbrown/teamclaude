import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--help` after a subcommand, driven as a subprocess against a throwaway
// TEAMCLAUDE_CONFIG. Before the guard in index.js, `teamclaude login --help`
// started a real OAuth login: the browser approved whichever account it was
// signed in to, and the config was rewritten. The port is one nothing listens
// on, so `run` cannot find a proxy.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-help-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));
  return path;
}

function runCli(configPath, cliArgs) {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const child = spawn(process.execPath, [cliPath, ...cliArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 60_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

for (const cliArgs of [['login', '--help'], ['login', '--codex', '-h'], ['remove', 'a@example.com', '--help']]) {
  test(`${cliArgs.join(' ')} prints the help and runs nothing`, async () => {
    const configPath = await writeConfig();
    const before = await readFile(configPath, 'utf8');
    const res = await runCli(configPath, cliArgs);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Usage: teamclaude \[command\] \[options\]/);
    assert.doesNotMatch(res.stdout + res.stderr, /Starting OAuth login|Removed/);
    assert.equal(await readFile(configPath, 'utf8'), before);
  });
}

test('run -- --help passes --help to claude instead of printing the help', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['run', '--', '--help']);
  assert.doesNotMatch(res.stdout, /Usage: teamclaude \[command\] \[options\]/);
  assert.notEqual(res.code, 0, 'no proxy listens on the configured port, so run refuses');
});

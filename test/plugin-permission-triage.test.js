import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Covers the `permission-triage` Claude Code plugin: each case pipes one PermissionRequest input into
// hooks/run.sh, as Claude Code does, and reads the decision from stdout.
//
// The fixture home holds the worktree, so a path that leaves the worktree is outside the temp directories too.
// HOME points at it, so the log goes there and `$HOME` checks see it. The temp fixture is under /tmp.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = `${repoRoot}plugins/permission-triage/`;
// Node strips types from 22.18 and 23.6. CI also runs Node 20.
const canRun = Boolean(/** @type {{ typescript?: unknown }} */ (process.features).typescript);

const home = realpathSync(mkdtempSync(join(homedir(), '.ptriage-test-')));
const wt = join(home, 'wt');
const outside = join(home, 'outside');
const tmp = realpathSync(mkdtempSync('/tmp/ptriage-test-'));
const tmpdirX = join(tmpdir(), 'x.txt');
mkdirSync(join(wt, 'scripts'), { recursive: true });
mkdirSync(join(wt, 'apps'), { recursive: true });
writeFileSync(join(wt, '.git'), 'gitdir: /nowhere\n');
mkdirSync(outside);
mkdirSync(join(tmp, 'sub'));
writeFileSync(join(tmp, 'sub', 'a.log'), '');
symlinkSync(outside, join(tmp, 'escape'));

/** @param {string} cwd @param {string} command */
function decide(cwd, command) {
  const input = {
    session_id: 'test-session',
    agent_id: 'test-agent',
    cwd,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command },
  };
  const r = spawnSync('sh', [`${pluginRoot}hooks/run.sh`], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PERMISSION_TRIAGE_NODE: process.execPath },
  });
  assert.equal(r.status, 0, r.stderr);
  const { decision } = JSON.parse(r.stdout).hookSpecificOutput;
  return decision;
}

// [cwd, command, expected]: an allow, or a deny with a fragment of its reason.
/** @type {[string, string, 'allow' | RegExp][]} */
const cases = [
  [wt, 'rm -f scripts/nonexistent.txt', 'allow'],
  [wt, `rm -rf ${wt}/apps/nonexistent-dir`, 'allow'],
  [`${wt}/apps`, 'rm -rf ../scripts/nonexistent', 'allow'],
  [wt, `rm -f ${tmp}/sub/a.log`, 'allow'],
  [wt, `rm -rf ${tmp}/sub`, 'allow'],
  [wt, `rm -f ${tmpdirX}`, 'allow'],
  [wt, `cd ${wt}/scripts && rm -f *`, 'allow'],
  [wt, `cd ${tmp}/sub && rm -f *.log`, 'allow'],
  [wt, 'rm -f *', 'allow'],
  [wt, "rm -rf -- 'scripts/odd name.txt'", 'allow'],
  [wt, 'rm -rf *', /recursive glob over the whole worktree/],
  [wt, 'rm -rf ~', /shell character "~"/],
  [wt, 'rm -rf $HOME/foo', /shell character "\$"/],
  [wt, 'rm -rf $(pwd)/foo', /shell character "\$"/],
  [wt, 'rm -rf ../../foo', /outside the worktree and temp directories/],
  [wt, 'rm -rf /', /names a directory by \. or \.\./],
  // On macOS /tmp is a symlink to /private/tmp, so the reason names the unresolved path instead.
  [wt, 'rm -rf /tmp', /whole worktree or temp directory|resolves to \/tmp, outside/],
  [wt, 'rm -rf /tmp/*', /glob over a whole shared temp directory/],
  [wt, `rm -rf ${wt}`, /whole worktree or temp directory/],
  [wt, `rm -rf ${wt}/`, /whole worktree or temp directory/],
  [wt, 'rm -rf .*', /dot glob/],
  [wt, `rm -rf ${tmp}/escape/`, /outside the worktree and temp directories/],
  [wt, `rm -rf ${tmp}/escape`, 'allow'],
  [wt, `rm -rf ${tmp}/escape/../Documents`, /outside the worktree and temp directories/],
  [wt, 'rm -rf /etc/*/foo', /glob in a directory part/],
  [wt, 'rm --no-preserve-root -rf /tmp/x', /rm option --no-preserve-root/],
  [wt, 'rm /tmp/x -rf', /rm option -rf after a path/],
  [wt, 'cd scripts && rm -f foo', /relative `cd` directory/],
  [wt, 'cd /etc && rm -f hosts', /outside the worktree and temp directories/],
  [wt, `cd ${wt} && rm -f a && rm -f b`, /more than one `&&`/],
  [wt, 'rm -f a; rm -f b', /shell character ";"/],
  [wt, 'rm -f a | cat', /shell character "\|"/],
  [wt, 'rm -f a &', /background `&`/],
  [wt, 'ls -la && rm -f a', /chain that is not `cd <dir> && rm …`/],
  [wt, 'git push --force origin main', /`git` is not on the allow list/],
  [wt, 'sudo rm -rf /tmp/x', /`sudo` is not on the allow list/],
  [wt, `cat .e${'nv'}`, /`cat` is not on the allow list/],
  [home, 'rm -rf Documents', /contains \$HOME/],
  ['/', 'rm -rf tmp/x', /contains \$HOME/],
  [wt, "rm -f 'unclosed", /unclosed quote/],
];

test('permission-triage decides each Bash command', { skip: !canRun && 'node cannot strip types' }, async (t) => {
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
  for (const [cwd, command, expected] of cases) {
    await t.test(command, () => {
      const decision = decide(cwd, command);
      if (expected === 'allow') {
        assert.deepEqual(decision, { behavior: 'allow' });
      } else {
        assert.equal(decision.behavior, 'deny');
        assert.match(decision.message, /^No\. Too aggro for an unattended run \(/);
        assert.match(decision.message, expected);
      }
    });
  }
  await t.test('logs one line per decision', () => {
    const lines = readFileSync(join(home, '.claude', 'logs', 'permission-triage.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, cases.length);
    const first = JSON.parse(lines[0]);
    assert.equal(first.session_id, 'test-session');
    assert.equal(first.decision, 'allow');
  });
});

test('hooks.json registers run.sh for Bash with a timeout and a fail-closed block', () => {
  const { hooks } = JSON.parse(readFileSync(`${pluginRoot}hooks/hooks.json`, 'utf8'));
  assert.deepEqual(Object.keys(hooks), ['PermissionRequest']);
  const [entry] = hooks.PermissionRequest;
  assert.equal(entry.matcher, 'Bash');
  const [hook] = entry.hooks;
  assert.equal(hook.command, 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"');
  assert.equal(hook.onFailure, 'block');
  assert.equal(typeof hook.timeout, 'number');
});

test('the marketplace lists the plugin', () => {
  const marketplace = JSON.parse(readFileSync(`${repoRoot}.claude-plugin/marketplace.json`, 'utf8'));
  const entry = marketplace.plugins.find((/** @type {{ name: string }} */ p) => p.name === 'permission-triage');
  assert.equal(entry?.source, './plugins/permission-triage');
});

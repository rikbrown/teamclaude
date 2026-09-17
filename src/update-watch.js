// What tells a running proxy that a newer build is waiting for it.
//
// The signal is not the same on every install, and picking only one of them
// would leave the primary user with dead code:
//
//   global npm install — `npm install -g` replaces the files under the running
//     process, so the version in the package's own package.json stops matching
//     the version this process loaded. That difference, not the registry, is
//     the signal: a published release nothing has installed yet is not
//     something a restart can apply. autoUpdate (updater.js) does the
//     installing; this only notices that it landed.
//   git checkout — npm refuses to touch one by design, so there is no installed
//     version to compare. The deploy clone's HEAD moving is the signal, read
//     with one cheap `git rev-parse` on a timer.
//
// Both answer the same question — "would restarting run something else?" — so
// both feed the same drain-and-restart, and the install kind picks which is
// asked.
//
// Detecting a new build is not permission to apply it. A restart costs every
// live session its connection, so it waits for the fleet to go quiet; a fleet
// that never does gets restarted anyway, because a proxy that updates only
// when nobody is using it never updates at all.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersions, currentVersion, installKind, isReleaseVersion, packageRoot } from './updater.js';

const pexec = promisify(execFile);

// How often the source is asked. A git checkout costs one `rev-parse` and a
// global install one small file read, so this is cheap enough to be frequent
// and slow enough to be invisible.
export const UPDATE_POLL_MS = 60_000;

// How long the fleet must stay quiet before a pending build is applied. The
// session tracker already calls a session inactive after two idle minutes
// (SESSION_ACTIVE_TTL_MS), so this is the quiet period ON TOP of that — proof
// that the lull held rather than a gap between two turns of one conversation.
export const FLEET_IDLE_MS = 60_000;

// ...and how long a pending build waits for that quiet before going anyway. A
// busy fleet must not be able to postpone an update forever; at this point the
// drain is what protects the sessions, not the wait.
export const RESTART_DEADLINE_MS = 30 * 60_000;

// Bounded like every other git call in this package: a checkout on a stalled
// network mount must cost the proxy a skipped check, not a stuck timer.
const GIT_TIMEOUT_MS = 2000;

/**
 * @typedef {Object} VersionSource
 * @property {string} kind          the install shape this reads
 * @property {string} describes     what it names, for the log line
 * @property {() => Promise<string|null>} read  the build a restart would run, or null when that is the one already running
 */

/**
 * A git checkout: HEAD's sha, compared against the sha this process started on.
 *
 * The baseline is taken on the first successful read rather than in the
 * constructor, because reading is asynchronous and a watcher that had no
 * baseline yet would read the first pull as "nothing changed". A first read
 * that fails (no git binary, a broken checkout) leaves the baseline unset, so
 * the next successful one becomes it — one missed pull rather than a watcher
 * that never works again.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root]
 * @param {(file: string, args: string[], options: { cwd: string, encoding: 'utf8', timeout: number }) => Promise<{ stdout: string }>} [opts.exec]
 * @returns {VersionSource}
 */
export function gitHeadSource({ root = packageRoot(), exec = pexec } = {}) {
  let baseline = null;
  return {
    kind: 'git',
    describes: 'the checkout HEAD',
    async read() {
      let head = null;
      try {
        /** @type {{ cwd: string, encoding: 'utf8', timeout: number }} */
        const opts = { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS };
        head = String((await exec('git', ['rev-parse', 'HEAD'], opts)).stdout).trim();
      } catch { return null; } // no git, no repository, or it took too long
      // Shape-checked before it is compared: anything else is git reporting a
      // problem on stdout, and treating that as a sha would restart the proxy
      // on every poll for as long as the problem lasted.
      if (!/^[0-9a-f]{7,64}$/.test(head)) return null;
      baseline ||= head;
      return head === baseline ? null : head;
    },
  };
}

/**
 * A global npm install: the version on disk at the package root.
 *
 * `currentVersion` is re-read every time on purpose — that file is what
 * `npm install -g` rewrites under a running process, and the whole signal is
 * that it stopped matching what this process loaded. Only a newer release
 * counts: a reinstall of the same version changes nothing worth a restart, and
 * a downgrade or a version string that is not a release is not something to
 * relaunch into.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root]
 * @param {string|null} [opts.running]  the version this process is executing
 * @returns {VersionSource}
 */
export function npmVersionSource({ root = packageRoot(), running = currentVersion(root) } = {}) {
  return {
    kind: 'global',
    describes: 'the installed package',
    async read() {
      const installed = currentVersion(root);
      if (!installed || !running || !isReleaseVersion(installed)) return null;
      return compareVersions(installed, running) > 0 ? installed : null;
    },
  };
}

/**
 * The source for how this copy was installed, or null when a restart could not
 * pick anything up: a local dependency or an npx copy is nobody's deployment,
 * and nothing rewrites it under us.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root]
 * @param {Function} [opts.kind]
 * @param {Function} [opts.exec]
 * @param {string|null} [opts.running]
 * @returns {Promise<VersionSource|null>}
 */
export async function createVersionSource({ root = packageRoot(), kind = installKind, exec = pexec, running = currentVersion(root) } = {}) {
  const how = await kind({ root });
  if (how === 'git') return gitHeadSource({ root, exec: /** @type {any} */ (exec) });
  if (how === 'global') return npmVersionSource({ root, running });
  return null;
}

/**
 * Polls a source and asks for a restart once a new build is waiting AND the
 * fleet is quiet enough to lose its connections cheaply.
 *
 * Fires exactly once: the restart it asks for ends the process, and a second
 * request during the drain would be noise at best.
 */
export class UpdateWatcher {
  /**
   * @param {Object} opts
   * @param {VersionSource|null} opts.source
   * @param {() => boolean} opts.isIdle       is the fleet serving nothing right now
   * @param {(info: { build: string, forced: boolean, waitedMs: number }) => void} opts.onRestart
   * @param {number} [opts.pollMs]
   * @param {number} [opts.idleMs]
   * @param {number} [opts.deadlineMs]
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   */
  constructor({
    source, isIdle, onRestart, pollMs = UPDATE_POLL_MS, idleMs = FLEET_IDLE_MS,
    deadlineMs = RESTART_DEADLINE_MS, now = Date.now, log = console.log,
  }) {
    this.source = source;
    this.isIdle = isIdle;
    this.onRestart = onRestart;
    this.pollMs = pollMs;
    this.idleMs = idleMs;
    this.deadlineMs = deadlineMs;
    this.now = now;
    this.log = log;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    /** @type {string|null} the build waiting to be picked up */
    this._build = null;
    // Timestamps, and null rather than 0 for "not yet": a clock can legitimately
    // read 0, and a falsy check would then re-stamp both of these on every poll
    // — the deadline would never arrive and the quiet period never accumulate.
    /** @type {number|null} when the build was first seen, for the deadline */
    this._pendingSince = null;
    /** @type {number|null} when the fleet last went quiet, for the wait */
    this._idleSince = null;
    this._fired = false;
    this._busy = false;        // a read is outstanding; never overlap them
  }

  /** No-op without a source, so the caller needs no second condition. */
  start() {
    if (!this.source || this.timer) return;
    // Primes the baseline (see gitHeadSource) rather than waiting a full poll
    // to learn what is already running.
    this.check();
    this.timer = setInterval(() => { this.check(); }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One poll. Public so a test can drive the decision without spending the
   *  interval, the idle wait and the deadline in real time. */
  async check() {
    if (this._fired || this._busy || !this.source) return null;
    this._busy = true;
    try {
      const build = await this.source.read();
      if (build) this._build = build;
      // Nothing waiting: whatever idleness was accumulating is not evidence
      // about a build, so it starts again with the next one.
      if (!this._build) { this._idleSince = null; return null; }

      const now = this.now();
      if (this._pendingSince === null) {
        this._pendingSince = now;
        this.log(`[TeamClaude] A newer build is waiting (${this._build}) — restarting once the fleet is idle, or in ${Math.round(this.deadlineMs / 60_000)} min regardless.`);
      }
      if (this.isIdle()) this._idleSince ??= now; else this._idleSince = null;

      const settled = this._idleSince !== null && now - this._idleSince >= this.idleMs;
      const overdue = now - this._pendingSince >= this.deadlineMs;
      if (!settled && !overdue) return null;

      this._fired = true;
      this.stop();
      this.onRestart({ build: this._build, forced: !settled, waitedMs: now - this._pendingSince });
      return this._build;
    } finally {
      this._busy = false;
    }
  }
}

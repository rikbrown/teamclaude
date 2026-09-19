// Sidecar supervisor (codex-proxy feature).
//
// TeamClaude is the controller: when a third-party backend account points at a
// local translating proxy (e.g. raine/claude-code-proxy for the ChatGPT/Codex
// backend), the server owns that process rather than asking the user to run it
// by hand or via brew services. Each `config.sidecars[]` entry is spawned on
// server start, respawned with exponential backoff when it dies, and killed on
// shutdown. Supervision is process-level only — routing to the sidecar is
// unchanged (a normal `accounts[].upstream` + route).
//
// stdout is ignored (sidecars keep their own log files); stderr's last few
// lines are kept in a ring buffer so `getStatus()` can say WHY a sidecar is
// crash-looping without anyone hunting for its logs.
//
// One failure mode earned its own handling. A sidecar binds a fixed port, so a
// copy that outlives its server keeps that port and every later server fails to
// bind — reported, before this, as a bare "code 1" retried forever, while the
// old process quietly went on serving. Two halves: name the conflict instead of
// guessing at it, and reap a leftover this server can prove is its own.

import { spawn, spawnSync } from 'node:child_process';

// How long each caller of stop() waits for a child to go, and why the two
// differ. The sidecar (claude-code-proxy v0.1.40 and later) reads the FIRST
// SIGTERM as "begin a graceful shutdown", which an in-flight request holds
// open, and only forces exit on a second signal. Measured against that build:
// idle it exits in ~30ms, even with an idle keep-alive socket still attached;
// with one request in flight it was still serving 3s after the first signal and
// died 4ms after the second.
//
// So the wait is not about the sidecar being slow — it is about whether the
// caller has already decided to interrupt work in flight.
//
//   SHUTDOWN — ctrl-c. The caller destroys live client connections and
//   hard-exits 2s later, so the sidecar's remaining work has nowhere to go
//   anyway. Long enough for the idle exit by a wide margin, short enough that
//   the escalation below still completes inside that 2s budget.
//
//   DRAIN — the restart path, which waits for the fleet to go idle first. There
//   is nothing left in flight to interrupt and nothing is watching, so the
//   number only has to be larger than an unhurried exit; it exists to bound the
//   wait, not to ration it. No escalation goes with it (see stop()).
export const SIDECAR_SHUTDOWN_GRACE_MS = 500;
export const SIDECAR_DRAIN_GRACE_MS = 5_000;

// Allowed to the forcing signal, and again to SIGKILL. Both end the process
// where it stands — upstream's second signal is a bare process::exit(130) — so
// this is a scheduling allowance for the exit to be observed, not a shutdown
// budget of its own.
const FORCE_STEP_MS = 250;

/** Delay before restart attempt N (0-based): base, doubled per consecutive
 *  crash, capped. Pure so the schedule is testable without timers. */
export function restartDelayMs(restarts, { baseRestartMs, maxRestartMs }) {
  return Math.min(baseRestartMs * 2 ** restarts, maxRestartMs);
}

/** Does this stderr line say the port is already taken? The wording is the
 *  runtime's, not ours — Rust prints the OS string, Node prints EADDRINUSE —
 *  so match the phrasings rather than one library's spelling. */
export function isBindConflict(line) {
  return /address already in use|address in use|EADDRINUSE/i.test(String(line));
}

export class Sidecar {
  constructor(entries, {
    spawnFn = defaultSpawn,
    baseRestartMs = 1000,
    maxRestartMs = 30_000,
    stableMs = 30_000,
    stderrTailLines = 20,
    log = console.log,
    savedPids = null,
    onPids = null,
    readProcess = defaultReadProcess,
    killFn = (pid, signal) => process.kill(pid, signal),
  } = {}) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.spawnFn = spawnFn;
    this.baseRestartMs = baseRestartMs;
    this.maxRestartMs = maxRestartMs;
    this.stableMs = stableMs;
    this.stderrTailLines = stderrTailLines;
    this.log = log;
    // Pids this server recorded on a previous run, by entry name. Only ever
    // used to recognise our own leftovers; see _reapOrphan.
    this.savedPids = (savedPids && typeof savedPids === 'object') ? { ...savedPids } : {};
    this.onPids = onPids;
    this.readProcess = readProcess;
    this.killFn = killFn;
    this.stopping = false;
    // Per-entry runtime state, keyed by entry (parallel array to this.entries).
    this.states = this.entries.map(entry => ({
      entry,
      child: null,
      startedAt: null,
      restarts: 0,
      lastExit: null,
      timer: null,
      stderrTail: [],
      blocked: null,   // stderr line proving the port is held, else null
    }));
  }

  start() {
    for (const state of this.states) {
      this._reapOrphan(state);
      this._spawn(state);
    }
  }

  /** Stop every supervised child, and resolve once they are gone or the grace
   *  runs out — whichever happens first.
   *
   *  A caller that does not await this gets what stop() always did: the signal
   *  is sent synchronously and the promise is nobody's business. A caller that
   *  DOES await it is saying the thing it is about to do next — exit — must not
   *  happen while a child is still holding its port.
   *
   *  `force` is for a caller that has already chosen to be abrupt with
   *  everything else. It escalates when the grace expires: a second SIGTERM,
   *  which is the forcing signal for this sidecar, then SIGKILL, so this keeps
   *  working if that ever changes again. Anything that wants the sidecar to
   *  finish its work leaves it off and simply waits.
   *
   *  @param {{graceMs?: number, force?: boolean}} [opts]
   *  @returns {Promise<void>}
   */
  async stop({ graceMs = 0, force = false } = {}) {
    // Both of these before a single signal goes out: a child killed while its
    // respawn timer is pending would be replaced by the very timer it was
    // killed to cancel.
    this.stopping = true;
    const gone = [];
    for (const state of this.states) {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      if (state.child) gone.push(this._stopChild(state.child, graceMs, force));
    }
    await Promise.all(gone);
  }

  /** Signal one child and wait it out, escalating when asked.
   *  @param {any} child
   *  @param {number} graceMs
   *  @param {boolean} force
   */
  async _stopChild(child, graceMs, force) {
    // Subscribed BEFORE the signal, or a child that dies instantly resolves
    // nothing and every wait below runs to its full length.
    const gone = childGone(child);
    signalChild(child, 'SIGTERM');
    if (await settledWithin(gone, graceMs)) return;
    if (!force) return;
    signalChild(child, 'SIGTERM');
    if (await settledWithin(gone, FORCE_STEP_MS)) return;
    signalChild(child, 'SIGKILL');
    await settledWithin(gone, FORCE_STEP_MS);
  }

  getStatus() {
    return this.states.map(state => ({
      name: state.entry.name,
      running: !!state.child,
      pid: state.child?.pid ?? null,
      restarts: state.restarts,
      lastExit: state.lastExit,
      // A held port is not a crash: it says nothing is wrong with the binary
      // and everything is wrong with the port, which is a different fix.
      blocked: !!state.blocked,
      blockedReason: state.blocked,
      stderrTail: [...state.stderrTail],
    }));
  }

  /** Last known pid per entry name, for the owner to persist.
   *
   *  Deliberately the last pid rather than only a live one. A sidecar that is
   *  down — crashed, or blocked because something else holds its port — is
   *  exactly when the pid is worth keeping, and a record that emptied itself
   *  the moment the child exited would be absent whenever it was needed.
   */
  exportPids() {
    return { ...this.savedPids };
  }

  /** Kill a sidecar this server started that outlived it.
   *
   *  A server killed with SIGKILL never reaches stop(), and the child does not
   *  die with it (see defaultSpawn), so the sidecar keeps running and holding
   *  its port. Three things must all hold before anything is signalled: the pid
   *  was recorded by us, it is now reparented to init (nothing else supervises
   *  it), and it is still running the same program. A recycled pid fails the
   *  last test, and a sidecar belonging to another live server fails the second,
   *  so neither is touched. The port may take a moment to free after this; the
   *  ordinary restart backoff covers that.
   *
   *  One SIGTERM is still the right signal, and now for two reasons rather than
   *  one. An orphan of a SIGKILLed server was never signalled, so this is its
   *  first: idle, it goes at once. An orphan that outran stop()'s escalation
   *  already has one, so this is its SECOND — the forcing signal — which is
   *  precisely what a leftover still clinging to the port has earned.
   */
  _reapOrphan(state) {
    const pid = Number(this.savedPids[state.entry.name]?.pid);
    if (!Number.isInteger(pid) || pid <= 1) return;
    let info = null;
    try { info = this.readProcess(pid); } catch { return; }
    if (!info) return;                 // not running: already gone
    if (info.ppid !== 1) return;       // still has a parent, so not ours to reap
    const program = state.entry.command?.[0];
    if (!program || !String(info.command || '').includes(program)) return; // pid recycled
    try {
      this.killFn(pid, 'SIGTERM');
      this.log(`[TeamClaude] Sidecar "${state.entry.name}": reaped orphan pid ${pid} left by a previous run`);
    } catch { /* exited between the check and the signal, which is the goal anyway */ }
  }

  _spawn(state) {
    const { entry } = state;
    const [command, ...args] = entry.command;
    let child;
    try {
      child = this.spawnFn({
        name: entry.name,
        command,
        args,
        env: { ...process.env, ...(entry.env || {}) },
      });
    } catch (err) {
      this._onDown(state, `spawn failed: ${err?.message || err}`);
      return;
    }
    state.child = child;
    state.startedAt = Date.now();
    state.blocked = null;   // a fresh attempt: whatever the last one hit is history
    // Recorded now, while the pid is known. The record has to outlive the child
    // itself: the case it exists for is this server being killed outright, and
    // by then there is nobody left to write anything down.
    this.savedPids[entry.name] = { pid: child.pid, command: entry.command?.[0] ?? null };
    this._publishPids();
    child.stderr?.on('data', (chunk) => this._recordStderr(state, chunk));
    child.once('error', (err) => {
      if (state.child !== child) return;
      this._onDown(state, `spawn error: ${err?.message || err}`);
    });
    child.once('exit', (code, signal) => {
      if (state.child !== child) return;
      this._onDown(state, signal ? `signal ${signal}` : `code ${code}`);
    });
  }

  _onDown(state, lastExit) {
    // A run that survived long enough resets the backoff: the next crash is a
    // fresh incident, not a continuation of a crash loop.
    if (state.startedAt && Date.now() - state.startedAt >= this.stableMs) state.restarts = 0;
    state.child = null;
    state.lastExit = lastExit;
    if (this.stopping) return;
    const delay = restartDelayMs(state.restarts, this);
    // Retrying still makes sense while blocked — a port held by a process we
    // did not start frees when that process ends, and this is the only thing
    // watching for it — but saying "down (code 1)" about it does not.
    this.log(state.blocked
      ? `[TeamClaude] Sidecar "${state.entry.name}" cannot bind: ${state.blocked}; retrying in ${Math.round(delay / 1000)}s`
      : `[TeamClaude] Sidecar "${state.entry.name}" down (${lastExit}); restarting in ${Math.round(delay / 1000)}s`);
    state.restarts += 1;
    state.timer = setTimeout(() => {
      state.timer = null;
      this._spawn(state);
    }, delay);
    state.timer.unref?.();
  }

  _publishPids() {
    if (!this.onPids) return;
    // Persistence is the owner's business and best-effort: failing to record a
    // pid costs a manual reap later, never this start.
    try { this.onPids(this.exportPids()); } catch { /* not worth failing a spawn over */ }
  }

  _recordStderr(state, chunk) {
    const lines = String(chunk).split('\n').map(s => s.trim()).filter(Boolean);
    for (const line of lines) if (isBindConflict(line)) state.blocked = line;
    state.stderrTail.push(...lines);
    if (state.stderrTail.length > this.stderrTailLines) {
      state.stderrTail.splice(0, state.stderrTail.length - this.stderrTailLines);
    }
  }
}

/** A promise for "this child is no longer running".
 *
 *  'exit' is the event that answers the question stop() is really asking — the
 *  port is free from that moment — but a child whose stdio outlives it emits
 *  only 'close' afterwards, so both are taken and the first one wins.
 *  @param {any} child
 *  @returns {Promise<void>}
 */
function childGone(child) {
  return new Promise(resolve => {
    const done = () => resolve();
    child.once?.('exit', done);
    child.once?.('close', done);
  });
}

/** True when `promise` settles within `ms`, false when the wait runs out.
 *
 *  The timer is deliberately NOT unref'd. Every caller here is on its way to a
 *  specific exit code, and an unref'd wait would let an emptied event loop end
 *  the process at 0 instead — silently turning a restart (75) into a stop. It
 *  is bounded and cleared on the fast path, so it holds nothing open.
 *  @param {Promise<void>} promise
 *  @param {number} ms
 *  @returns {Promise<boolean>}
 */
function settledWithin(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

/** Signal a child, never throwing. A child that has already exited, or whose
 *  handle no longer accepts the signal, IS the outcome being asked for.
 *  @param {any} child
 *  @param {NodeJS.Signals} signal
 */
function signalChild(child, signal) {
  try { child.kill(signal); } catch { /* already gone, which is the point */ }
}

// Real spawner: stdout ignored (sidecars log to their own files), stderr piped
// for the ring buffer.
//
// The child stays in our process group (`detached` defaults to false), so an
// interactive ctrl-c reaches it too. That is NOT the same as dying with us:
// there is no PDEATHSIG on macOS, and a server killed with SIGKILL leaves the
// sidecar running and holding its port. stop() is the ordinary path out;
// Sidecar._reapOrphan covers the rest.
/** @param {{name?: string, command: string, args: string[], env: Record<string, string|undefined>}} spec */
function defaultSpawn({ command, args, env }) {
  return spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Parent pid and command line for a pid, or null when it is not running.
 *
 *  `ps` rather than /proc, which macOS does not have. This runs once per
 *  sidecar at startup, never on a request path.
 *  @param {number} pid
 *  @returns {{ppid: number, command: string}|null}
 */
function defaultReadProcess(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
  const out = r.status === 0 ? String(r.stdout || '').trim() : '';
  const m = out.match(/^(\d+)\s+(.*)$/s);
  return m ? { ppid: Number(m[1]), command: m[2].trim() } : null;
}

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

import { spawn } from 'node:child_process';

/** Delay before restart attempt N (0-based): base, doubled per consecutive
 *  crash, capped. Pure so the schedule is testable without timers. */
export function restartDelayMs(restarts, { baseRestartMs, maxRestartMs }) {
  return Math.min(baseRestartMs * 2 ** restarts, maxRestartMs);
}

export class Sidecar {
  constructor(entries, {
    spawnFn = defaultSpawn,
    baseRestartMs = 1000,
    maxRestartMs = 30_000,
    stableMs = 30_000,
    stderrTailLines = 20,
    log = console.log,
  } = {}) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.spawnFn = spawnFn;
    this.baseRestartMs = baseRestartMs;
    this.maxRestartMs = maxRestartMs;
    this.stableMs = stableMs;
    this.stderrTailLines = stderrTailLines;
    this.log = log;
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
    }));
  }

  start() {
    for (const state of this.states) this._spawn(state);
  }

  stop() {
    this.stopping = true;
    for (const state of this.states) {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      state.child?.kill('SIGTERM');
    }
  }

  getStatus() {
    return this.states.map(state => ({
      name: state.entry.name,
      running: !!state.child,
      pid: state.child?.pid ?? null,
      restarts: state.restarts,
      lastExit: state.lastExit,
      stderrTail: [...state.stderrTail],
    }));
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
    this.log(`[TeamClaude] Sidecar "${state.entry.name}" down (${lastExit}); restarting in ${Math.round(delay / 1000)}s`);
    state.restarts += 1;
    state.timer = setTimeout(() => {
      state.timer = null;
      this._spawn(state);
    }, delay);
    state.timer.unref?.();
  }

  _recordStderr(state, chunk) {
    const lines = String(chunk).split('\n').map(s => s.trim()).filter(Boolean);
    state.stderrTail.push(...lines);
    if (state.stderrTail.length > this.stderrTailLines) {
      state.stderrTail.splice(0, state.stderrTail.length - this.stderrTailLines);
    }
  }
}

// Real spawner: stdout ignored (sidecars log to their own files), stderr piped
// for the ring buffer. detached:false so the child dies with us as a backstop.
function defaultSpawn({ command, args, env }) {
  return spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
}

// Drain-and-restart: applying a new build without cutting a live session.
//
// Restarting the proxy used to mean ctrl-c and a fast re-run, which breaks
// every Claude Code session going through it, for two separate reasons:
//
//   1. shutdown() calls server.closeAllConnections(), which DESTROYS in-flight
//      streaming responses. That abruptness is deliberate — a person holding
//      ctrl-c wants out now — so it is left exactly as it is, and the graceful
//      path lives here instead.
//   2. A restart kills idle keep-alive sockets the client still holds pooled.
//      The client finds out by writing to a corpse, which is the same failure
//      family as the two keep-alive fixes before this one.
//
// A drain answers both: stop accepting connections, tell every response on the
// way out that its socket is finished (`Connection: close`, set in server.js
// off `hooks.isDraining`), and wait for the requests already running to end.
// Clients retire their pooled sockets cooperatively and reconnect into the
// relaunched process.
//
// The relaunch itself is exit code 75 plus a supervisor, because a foreground
// TUI cannot re-exec itself: the parent exits, the shell prints a prompt, and
// the child fights it for the terminal.

import { spawn } from 'node:child_process';

// "Restart me." Chosen from the sysexits.h range (EX_TEMPFAIL) so it cannot
// collide with the 0/1 a crash or a clean quit already uses, and so a
// supervisor that does not know about it treats it as an ordinary failure.
export const RESTART_EXIT_CODE = 75;

// How long a drain waits for in-flight requests before going anyway. A stuck
// stream — an upstream that stopped sending without closing — must never be
// able to block a restart forever, and the requests that outlive this get the
// abrupt end they would have got from ctrl-c.
export const DRAIN_DEADLINE_MS = 30_000;
const DRAIN_POLL_MS = 100;

// A child that asks to be restarted this many times inside the window is
// looping, not updating: something makes the new build ask for a restart the
// moment it is up, and relaunching it forever would hide that behind a
// flickering terminal.
export const RESTART_LOOP_LIMIT = 5;
export const RESTART_LOOP_WINDOW_MS = 60_000;

// Set on a supervised child. Two things read it: the `u` key and the automatic
// restart, neither of which may exit 75 unless something is actually waiting to
// relaunch this process — otherwise "apply the update" reads as "kill the proxy
// and every session on it". The documented shell one-liner exports it too.
export const SUPERVISED_ENV = 'TEAMCLAUDE_SUPERVISED';
// How many relaunches this process is, so it can say so once it is listening.
export const RESTART_COUNT_ENV = 'TEAMCLAUDE_RESTARTS';

/**
 * Stop taking work and wait for what is running to finish.
 *
 * `server.close()` and NOT `closeAllConnections()`: close stops the listener,
 * while the connections already open keep streaming — and keep serving, which
 * is the point. A client whose pooled socket is still good sends its next
 * request into this window and gets a real answer carrying `Connection: close`,
 * so it retires that socket itself rather than discovering it dead later. Only
 * the sockets that stayed idle through the whole drain are closed, at the end,
 * where the gap between the close and the relaunch is as small as it can be.
 *
 * Every side effect is injectable so the deadline can be tested without
 * spending it.
 *
 * @param {Object} opts
 * @param {{ close?: Function, closeIdleConnections?: Function }} opts.server
 * @param {() => number} opts.inFlight  requests still running, fleet-wide
 * @param {number} [opts.deadlineMs]
 * @param {number} [opts.pollMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ drained: boolean, waitedMs: number, inFlight: number }>}
 */
export async function drainServer({
  server, inFlight, deadlineMs = DRAIN_DEADLINE_MS, pollMs = DRAIN_POLL_MS,
  now = Date.now, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const started = now();
  // No callback: a CONNECT tunnel is not tracked as a connection Node will tell
  // us about, so waiting for close() to call back could wait forever. What we
  // wait on is the request count below, which the deadline bounds.
  server.close?.();
  let open = inFlight();
  while (open > 0 && now() - started < deadlineMs) {
    await sleep(pollMs);
    open = inFlight();
  }
  // The sockets that never carried a response during the drain, and so never
  // got the `Connection: close` that retires them politely. Closing them is
  // unavoidable — the process is going — so it happens here, last, rather than
  // at the start where it would yank a socket the client was about to use.
  server.closeIdleConnections?.();
  return { drained: open <= 0, waitedMs: now() - started, inFlight: Math.max(0, open) };
}

/**
 * Run the real server as a child and relaunch it when it asks (exit 75). Any
 * other exit is the child's answer and ends the supervisor with it.
 *
 * `stdio: 'inherit'` hands over the actual terminal, so the child's TUI owns
 * raw mode, the tty size and the title exactly as it would unsupervised. The
 * supervisor itself must therefore touch neither stdin nor the screen.
 *
 * Resolves with the exit code this process should use.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.argv]  what to run: [script, ...args], `--supervise` removed
 * @param {typeof spawn} [opts.spawnFn]
 * @param {string} [opts.execPath]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(line: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {number} [opts.limit]
 * @param {number} [opts.windowMs]
 * @param {(event: string, handler: Function) => void} [opts.onSignal]
 */
export function superviseServer({
  argv = process.argv.slice(1), spawnFn = spawn, execPath = process.execPath,
  env = process.env, log = console.error, now = Date.now,
  limit = RESTART_LOOP_LIMIT, windowMs = RESTART_LOOP_WINDOW_MS,
  onSignal = (event, handler) => process.on(event, /** @type {any} */ (handler)),
} = {}) {
  const childArgv = argv.filter(a => a !== '--supervise');
  /** @type {number[]} */
  const relaunches = [];
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let stopping = false;

  // SIGTERM is aimed at this pid alone, so it has to be passed on or the child
  // keeps the terminal with nothing supervising it. SIGINT deliberately is NOT:
  // ctrl-c goes to the whole foreground process group, so the child already has
  // it, and a second one tells its shutdown() to stop waiting and exit at once
  // — the graceful teardown skipped by the very key meant to allow it.
  onSignal('SIGTERM', () => { stopping = true; child?.kill('SIGTERM'); });
  onSignal('SIGINT', () => { stopping = true; });

  return new Promise((resolve) => {
    const launch = (/** @type {number} */ restarts) => {
      try {
        child = spawnFn(execPath, childArgv, {
          stdio: 'inherit',
          env: { ...env, [SUPERVISED_ENV]: '1', [RESTART_COUNT_ENV]: String(restarts) },
        });
      } catch (err) {
        log(`[TeamClaude] Could not start the server: ${/** @type {Error} */ (err).message}`);
        resolve(1);
        return;
      }
      if (!child || typeof child.once !== 'function') { resolve(1); return; }
      child.once('error', (err) => {
        log(`[TeamClaude] Could not start the server: ${err.message}`);
        resolve(1);
      });
      child.once('exit', (code, signal) => {
        child = null;
        // Killed rather than exited: the operator or the OS ended it, and there
        // is nothing here to second-guess. 128+n is the shell's convention for
        // reporting which signal it was.
        if (code === null) { resolve(signal ? 128 + (signalNumber(signal) || 0) : 1); return; }
        if (code !== RESTART_EXIT_CODE || stopping) { resolve(code); return; }

        const at = now();
        relaunches.push(at);
        while (relaunches.length && at - relaunches[0] > windowMs) relaunches.shift();
        if (relaunches.length > limit) {
          log(`[TeamClaude] The server asked to restart ${relaunches.length} times in ${Math.round(windowMs / 1000)}s — it is looping, not updating. Giving up; start it again by hand once you know why.`);
          resolve(1);
          return;
        }
        launch(restarts + 1);
      });
    };
    launch(0);
  });
}

/** Signal name to number, for the 128+n exit convention. Unknown names report
 *  0, which reads as "killed, we don't know by what" rather than throwing.
 *  @param {NodeJS.Signals|string} name */
function signalNumber(name) {
  const table = /** @type {Record<string, number>} */ ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 });
  return table[String(name)] || 0;
}

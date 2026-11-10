/**
 * Session titles for the activity log.
 *
 * The proxy already knows which Claude Code session a request belongs to: the
 * client sends `x-claude-code-session-id`, and the TUI prints its first six hex
 * characters. That distinguishes concurrent sessions but does not name them.
 *
 * A title comes from one of three places, and the first that has one wins:
 *
 * 1. Pushed. Claude Code's `UserPromptSubmit` hook input carries
 *    `session_title`, the session's `/rename` name, and an http hook posts it to
 *    `POST /teamclaude/session-title` (server.js). This is the only way a
 *    `/rename` reaches a proxy on another machine: the rename itself sends
 *    nothing over the network.
 * 2. Disk. Claude Code stores the name under `~/.claude/projects/<slug>/`. A
 *    `/rename` writes `<session-id>/custom-title.json`; it also appends a
 *    `custom-title` record to the transcript, which is the only copy for a
 *    session renamed before the sidecar existed. Claude Code generates its own
 *    title as well and appends it as an `ai-title` record. This works only when
 *    the proxy runs on the machine the sessions run on.
 * 3. Captured. The generated title comes from one request through the proxy,
 *    on the session's first real prompt. server.js recognises that request
 *    (`isTitleRequest`) and reads the title out of its response
 *    (`TitleCapture`), so a proxy on another machine names the session too.
 *
 * Pushed and captured titles are kept in a small JSON file beside the state
 * file, because the title request runs once per session: without the file a
 * restart would forget every name until the next `/rename`.
 *
 * Lookups are cached and run off the render path: `get` returns what is cached
 * and schedules the read, so a frame never waits on the disk.
 */

import { readdir, readFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SESSION_KNOWN_TTL_MS } from './session-tracker.js';
import { sanitizeText } from './safe-text.js';
import { writeJsonAtomic } from './config.js';

const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** A rename must reach the TUI without a restart, and a re-read costs one
 *  directory scan and one 64 KB read. */
const DEFAULT_TTL_MS = 30_000;

/** An entry that no visible row has refreshed for this long is dropped, so the
 *  cache holds the sessions the tracker still knows and not every id the
 *  process has ever seen. Same window as the tracker's known list. */
const DEFAULT_MAX_AGE_MS = SESSION_KNOWN_TTL_MS;

/** Measured across 218 transcripts: the last title record sits within 32.7 KB
 *  of EOF at p99 and 46.3 KB at the maximum. Reading more would only reach
 *  sessions that have written megabytes since their last title. */
const DEFAULT_TAIL_BYTES = 64 * 1024;

/** Columns the activity log gives the session label. Every row pays this width,
 *  named or not, so the columns after it stay aligned. A typed name fits: the
 *  longest in use is "adv-review-rewrite" at 18. A generated title is a sentence
 *  and is cut. */
const DEFAULT_WIDTH = 18;

/** The activity log falls back to this many hex characters of the session id,
 *  so a label can never be narrower. */
const SHORT_ID_LEN = 6;

/** The session id is a request header, so it is client input. Claude Code sends
 *  a UUID; anything else never reaches the filesystem, where `path.join` would
 *  follow a `..` out of the projects directory. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A pushed or captured title is kept this long after it was last set. A
 *  session resumed within a month keeps its name; one older than that is
 *  unlikely to be resumed, and the file must not grow with every session the
 *  proxy has ever served. */
const DEFAULT_KEPT_MAX_AGE_MS = 30 * DAY_MS;

/** And at most this many sessions, whatever their age: a client that sends
 *  title requests under made-up session ids can fill the file only this far. */
const DEFAULT_KEPT_MAX = 2000;

/** Every prompt pushes the same title again. Re-stamping the entry is what
 *  keeps an active session inside the age window, but a write per prompt for
 *  that would be waste, so an unchanged title is re-stamped at most daily. */
const RESTAMP_MS = DAY_MS;

/** Changes are written this long after the first one, so a burst is one write. */
const DEFAULT_SAVE_DELAY_MS = 2000;

/** On-disk format version. A file with any other version reads as empty. */
const FORMAT_VERSION = 1;

/** The longest title kept. Claude Code asks for two to five words and a
 *  `/rename` is typed, so this only bounds a client that sends something else. */
const TITLE_MAX_CHARS = 200;

/**
 * A title the proxy holds itself, not read from disk.
 * @typedef {{ pushed?: string, captured?: string, at: number }} KeptTitle
 */

export class SessionTitles {
  /**
   * @param {Record<string, any>} [options]  the `sessionTitles` config keys,
   *   plus the tuning below. `storePath` is where pushed and captured titles
   *   persist; without it they live only in this process. Only the server's
   *   store sets it: an attach-mode TUI reads another process's file and must
   *   never write it.
   */
  constructor({
    ttlMs = DEFAULT_TTL_MS, tailBytes = DEFAULT_TAIL_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS,
    storePath = null, saveDelayMs = DEFAULT_SAVE_DELAY_MS,
    keptMaxAgeMs = DEFAULT_KEPT_MAX_AGE_MS, keptMax = DEFAULT_KEPT_MAX,
    ...cfg
  } = {}) {
    this.ttlMs = ttlMs;
    this.tailBytes = tailBytes;
    this.maxAgeMs = maxAgeMs;
    this.sweptAt = 0;
    /** @type {Map<string, {title: string|null, at: number}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    this.inflight = new Map();
    /** Pushed and captured titles, in `at` order, oldest first.
     *  @type {Map<string, KeptTitle>} */
    this.kept = new Map();
    /** @type {string|null} */
    this.storePath = storePath;
    this.saveDelayMs = saveDelayMs;
    this.keptMaxAgeMs = keptMaxAgeMs;
    this.keptMax = keptMax;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._saveTimer = null;
    /** Saves run one after another, so an older document never lands last.
     *  @type {Promise<void>} */
    this._saving = Promise.resolve();
    this.projectsDir = null;
    this.configure(cfg);
  }

  /** Apply a config change in place, so a reload takes effect without a
   *  restart. An absent key returns to its default. Off unless asked for: this
   *  reads the transcripts of every session the proxy sees, and reads titles
   *  out of request traffic, which is further than the proxy reaches for
   *  anything else by default. Off stops all of it, and kept titles stay kept.
   * @param {Record<string, any>|null|undefined} cfg */
  configure(cfg) {
    const { enabled = false, width = DEFAULT_WIDTH, projectsDir = DEFAULT_PROJECTS_DIR } = cfg || {};
    this.enabled = enabled === true;
    // A label narrower than the short id it falls back to would cut the id.
    this.width = Math.max(SHORT_ID_LEN, Math.trunc(width) || DEFAULT_WIDTH);
    // Titles cached from one directory say nothing about another.
    if (projectsDir !== this.projectsDir) this.cache.clear();
    this.projectsDir = projectsDir;
  }

  /** The settings in force, for the status readout. */
  settings() {
    return { enabled: this.enabled, width: this.width, projectsDir: this.projectsDir };
  }

  /** The cached title, or null. Never touches the disk: a miss or a stale entry
   * @param {string} sessionId
   * @param {number} [now]
   *  schedules the read and the caller gets the previous answer until it lands. */
  get(sessionId, now = Date.now()) {
    if (!this.enabled || !isSessionId(sessionId)) return null;
    // A pushed title outranks the disk, so the disk is not read for it.
    const kept = this.kept.get(sessionId);
    if (kept?.pushed) return kept.pushed;
    this._evict(now);
    const hit = this.cache.get(sessionId);
    if (!hit || now - hit.at >= this.ttlMs) this._schedule(sessionId, now);
    return hit?.title ?? kept?.captured ?? null;
  }

  /**
   * Read the title now. Resolves to null when the session has none.
   *
   * @param {string} sessionId
   * @param {number} [now]
   */
  async resolve(sessionId, now = Date.now()) {
    if (!this.enabled || !isSessionId(sessionId)) return null;
    const pushed = this.kept.get(sessionId)?.pushed;
    if (pushed) return pushed;
    const read = await this._schedule(sessionId, now);
    return read ?? this.kept.get(sessionId)?.captured ?? null;
  }

  /**
   * Keep the title a client pushed for a session (its `/rename` name). Returns
   * the title as kept when it differs from the one held before, else null, so
   * the caller logs a change once and not once per prompt.
   *
   * @param {string} sessionId
   * @param {unknown} title
   * @param {number} [now]
   */
  push(sessionId, title, now = Date.now()) {
    return this._keep(sessionId, 'pushed', title, now);
  }

  /**
   * Keep the title read out of Claude Code's own title request. Same answer
   * as `push`.
   *
   * @param {string} sessionId
   * @param {unknown} title
   * @param {number} [now]
   */
  capture(sessionId, title, now = Date.now()) {
    return this._keep(sessionId, 'captured', title, now);
  }

  /**
   * @param {string} sessionId
   * @param {'pushed'|'captured'} kind
   * @param {unknown} title
   * @param {number} now
   */
  _keep(sessionId, kind, title, now) {
    if (!this.enabled || !isSessionId(sessionId)) return null;
    const cleaned = cleanTitle(title);
    if (!cleaned) return null;
    const kept = cleaned.length > TITLE_MAX_CHARS ? cleaned.slice(0, TITLE_MAX_CHARS).trimEnd() : cleaned;
    const entry = this.kept.get(sessionId);
    const changed = entry?.[kind] !== kept;
    if (!changed && entry && now - entry.at < RESTAMP_MS) return null;
    // Re-inserted, so the map stays in `at` order and the cap drops the oldest.
    this.kept.delete(sessionId);
    this.kept.set(sessionId, { ...entry, [kind]: kept, at: now });
    this._prune(now);
    this._scheduleSave();
    return changed ? kept : null;
  }

  /** Drop kept titles past the age window, then the oldest past the cap.
   * @param {number} now */
  _prune(now) {
    for (const [sessionId, { at }] of this.kept) {
      if (now - at >= this.keptMaxAgeMs) this.kept.delete(sessionId);
    }
    for (const sessionId of this.kept.keys()) {
      if (this.kept.size <= this.keptMax) break;
      this.kept.delete(sessionId);
    }
  }

  /**
   * Read the kept titles from `storePath`. A missing, corrupt or foreign file
   * reads as none, and an entry that is not one is skipped: a damaged file
   * costs names, never the start.
   *
   * @param {number} [now]
   */
  async load(now = Date.now()) {
    if (!this.storePath) return;
    let doc;
    try {
      doc = JSON.parse(await readFile(this.storePath, 'utf8'));
    } catch {
      return;
    }
    if (doc?.version !== FORMAT_VERSION || !doc.sessions || typeof doc.sessions !== 'object') return;
    /** @type {Array<[string, KeptTitle]>} */
    const rows = [];
    for (const [sessionId, value] of Object.entries(doc.sessions)) {
      if (!isSessionId(sessionId) || this.kept.has(sessionId)) continue;
      const at = value?.at;
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      const pushed = cleanTitle(value.pushed);
      const captured = cleanTitle(value.captured);
      if (!pushed && !captured) continue;
      rows.push([sessionId, { ...(pushed ? { pushed } : {}), ...(captured ? { captured } : {}), at }]);
    }
    rows.sort((a, b) => a[1].at - b[1].at);
    // Titles set in this process before the load are newer than the file's.
    const live = [...this.kept];
    this.kept = new Map([...rows, ...live]);
    this._prune(now);
  }

  /** The on-disk form. No prototype: a key is client input, and `__proto__`
   *  is one. */
  toJSON() {
    /** @type {Record<string, KeptTitle>} */
    const sessions = Object.create(null);
    for (const [sessionId, entry] of this.kept) sessions[sessionId] = entry;
    return { version: FORMAT_VERSION, sessions };
  }

  _scheduleSave() {
    if (!this.storePath || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, this.saveDelayMs);
    // A pending save must not keep the process alive; shutdown flushes it.
    this._saveTimer.unref?.();
  }

  /** Write now, after any save already running. Never rejects: a failed write
   *  is reported and the titles stay in memory for the next one. */
  _save() {
    const path = this.storePath;
    if (!path) return this._saving;
    this._saving = this._saving
      .then(() => writeJsonAtomic(path, this.toJSON(), { space: 0 }))
      .catch((/** @type {any} */ err) => console.error(`[TeamClaude] Failed to save session titles: ${err?.message ?? err}`));
    return this._saving;
  }

  /** Write a pending change now (shutdown), and wait for every save. */
  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      await this._save();
    }
    await this._saving;
  }

  /** Number of reads in flight. */
  pending() {
    return this.inflight.size;
  }

  /** Settle every scheduled read. A resolve can schedule another, so this loops. */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight.values()]);
  }

  /** Drop entries no row has refreshed within the window. A visible session is
   *  re-read every TTL, which keeps its entry young; one that left the screen
   * @param {number} now
   *  ages out. Runs at most once per TTL, so a frame does not pay for it. */
  _evict(now) {
    if (now - this.sweptAt < this.ttlMs) return;
    this.sweptAt = now;
    for (const [sessionId, { at }] of this.cache) {
      if (now - at >= this.maxAgeMs) this.cache.delete(sessionId);
    }
  }

  /**
   * @param {string} sessionId
   * @param {number} now
   */
  _schedule(sessionId, now) {
    const existing = this.inflight.get(sessionId);
    if (existing) return existing;
    // A missing title is cached like a found one: without that, every frame
    // would rescan the projects directory for a session that has no name.
    const read = this._read(sessionId)
      .catch(() => null)
      .then((title) => {
        this.cache.set(sessionId, { title, at: now });
        return title;
      })
      .finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, read);
    return read;
  }

  /** The project directory is keyed by the session's cwd, which the proxy does
   * @param {string} sessionId
   *  not know, so each directory is tried until one holds the session. */
  async _read(sessionId) {
    const entries = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = join(this.projectsDir, entry.name);
      const renamed = await this._fromSidecar(join(project, sessionId, 'custom-title.json'));
      if (renamed) return renamed;
      const recorded = await this._fromTranscript(join(project, `${sessionId}.jsonl`));
      if (recorded) return recorded;
    }
    return null;
  }

  /**
   * @param {string} path
   */
  async _fromSidecar(path) {
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw == null) return null;
    try {
      return cleanTitle(JSON.parse(raw).customTitle);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} path
   */
  async _fromTranscript(path) {
    const file = await open(path, 'r').catch(() => null);
    if (!file) return null;
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - this.tailBytes);
      const buffer = Buffer.alloc(Math.min(size, this.tailBytes));
      if (buffer.length) await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      // A window that does not start at byte 0 opens mid-line; that fragment is
      // not a JSON record.
      if (start > 0) lines.shift();
      return lastTitle(lines);
    } finally {
      await file.close();
    }
  }
}

/** A typed name wins wherever it sits in the file; otherwise the most recent
 *  generated one. Both are re-appended as a session runs, so the scan reads
 * @param {string[]} lines
 *  backwards and stops at the first match. */
function lastTitle(lines) {
  let generated = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Transcript lines are mostly multi-kilobyte messages; reject those on a
    // substring before paying for JSON.parse.
    if (!line || line[0] !== '{' || !line.includes('-title"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === 'custom-title') {
      const typed = cleanTitle(record.customTitle);
      if (typed) return typed;
    }
    if (record.type === 'ai-title' && !generated) generated = cleanTitle(record.aiTitle);
  }
  return generated;
}

/**
 * @param {unknown} value
 */
function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** A title is printed inside a terminal escape and written to the activity log
 *  file, so a control character in it (an ESC, a newline) is not a title, it
 * @param {unknown} value
 *  is an injection. Each becomes a space and runs of whitespace collapse. */
function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const cleaned = sanitizeText(value);
  return cleaned || null;
}

// ── Claude Code's title request ────────────────────────────────────────────

/** How Claude Code 2.1's `generate_session_title` system prompt opens. The
 *  request also carries Claude Code's billing and identity blocks, so this is
 *  one text block of several, not the first. */
const TITLE_PROMPT_PREFIX = 'You are naming a coding session so the user can pick it out of a long list of sessions.';
const TITLE_PROMPT_BYTES = Buffer.from(TITLE_PROMPT_PREFIX);

/** The answer is `{"title":"…"}`: a few dozen bytes. Text past this is not
 *  that answer, and collecting it would only buffer a response nobody reads. */
const CAPTURE_MAX_CHARS = 4096;

/**
 * Whether a request body is Claude Code's session-title request: a system
 * prompt that opens with the title prompt, and a JSON-schema output format
 * whose schema has a `title` property. Both, so a conversation that merely
 * quotes the prompt is not taken for it.
 *
 * Every Anthropic request pays for the first test, a byte search; only a body
 * that contains the prompt is parsed.
 *
 * @param {Buffer|string} body
 */
export function isTitleRequest(body) {
  if (!body) return false;
  const found = typeof body === 'string' ? body.includes(TITLE_PROMPT_PREFIX) : body.includes(TITLE_PROMPT_BYTES);
  if (!found) return false;
  let json;
  try {
    json = JSON.parse(body.toString());
  } catch {
    return false;
  }
  return opensWithTitlePrompt(json?.system) && schemaHasTitle(json);
}

/** @param {unknown} system */
function opensWithTitlePrompt(system) {
  /** @param {unknown} text */
  const opens = (text) => typeof text === 'string'
    && (text.startsWith(TITLE_PROMPT_PREFIX) || text.includes(`\n${TITLE_PROMPT_PREFIX}`));
  if (typeof system === 'string') return opens(system.trimStart());
  if (!Array.isArray(system)) return false;
  return system.some((block) => block?.type === 'text' && opens(block.text));
}

/** The schema lives at `output_config.format` on the current API and at
 *  `output_format` on the beta that preceded it.
 * @param {any} json */
function schemaHasTitle(json) {
  const format = json?.output_config?.format ?? json?.output_format;
  const properties = format?.type === 'json_schema' ? format.schema?.properties : null;
  return !!properties && typeof properties === 'object' && Object.hasOwn(properties, 'title');
}

/**
 * Collects the assistant text of a title response and reads the title out of
 * it. Fed one SSE line at a time (`line`) for a streamed response; a buffered
 * one goes through `fromBody` instead. Anything that does not parse is no
 * title, silently: a missed name is a hex id in the log, not an error.
 */
export class TitleCapture {
  constructor() {
    this.text = '';
    this.overflowed = false;
  }

  /** @param {string} line */
  line(line) {
    if (this.overflowed || !line.startsWith('data: ') || !line.includes('text_delta')) return;
    let event;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      return;
    }
    if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return;
    this._append(event.delta.text);
  }

  /** @param {unknown} text */
  _append(text) {
    if (typeof text !== 'string') return;
    this.text += text;
    if (this.text.length > CAPTURE_MAX_CHARS) {
      this.overflowed = true;
      this.text = '';
    }
  }

  /** The title, or null. */
  title() {
    return this.overflowed ? null : titleFromAnswer(this.text);
  }

  /**
   * The title in a buffered (non-streamed) Messages response, or null.
   * @param {Buffer|string} body
   */
  static fromBody(body) {
    let json;
    try {
      json = JSON.parse(body.toString());
    } catch {
      return null;
    }
    if (json?.type !== 'message' || !Array.isArray(json.content)) return null;
    const capture = new TitleCapture();
    for (const block of json.content) {
      if (block?.type === 'text') capture._append(block.text);
    }
    return capture.title();
  }
}

/** `{"title":"…"}`, possibly inside a code fence.
 * @param {string} text */
function titleFromAnswer(text) {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const title = JSON.parse(bare)?.title;
    return typeof title === 'string' ? cleanTitle(title) : null;
  } catch {
    return null;
  }
}

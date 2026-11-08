// PermissionRequest hook for Bash: no session waits on a permission prompt.
// Allows an `rm` (optionally after `cd <absolute dir> &&`) whose every target is inside the session's worktree or a temp
// directory. Denies everything else, with a message that tells the agent what to change. Never sets `interrupt`.
// run.sh selects the node binary, which must strip types (Node 22.18 or later). On a crash or timeout,
// `onFailure: "block"` in hooks.json denies the request.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type HookInput = {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
};

type Verdict = { decision: "allow" | "deny"; reason: string };

const home = homedir();
const logFile = join(home, ".claude", "logs", "permission-triage.jsonl");

const denyMessage = (reason: string) =>
  `No. Too aggro for an unattended run (${reason}). Split the chained command, use absolute paths, and scope any ` +
  `delete to the worktree. If it cannot be done another way, stop and tell your coordinator or Rik in text. ` +
  `Do not work around it.`;

// Shell syntax that can run code, redirect, expand or chain. A command with any of these is denied, even inside quotes.
const forbiddenChars = /[\n\r;|<>`$(){}\\#!~[\]=^%]/;
const globChars = /[*?]/;
const rmNames = new Set(["rm", "/bin/rm"]);
const rmLongOptions = new Set(["--force", "--recursive", "--verbose", "--dir"]);
const rmShortOption = /^-[fFrRvd]+$/;

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

const realpath = (path: string) => realpathSync.native(path);

type Word = { text: string } | { operator: "&&" };

function tokenize(command: string): Word[] {
  const forbidden = command.match(forbiddenChars)?.[0];
  if (forbidden !== undefined) refuse(`the shell character ${JSON.stringify(forbidden)}`);
  const words: Word[] = [];
  let current: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current ??= "";
    } else if (char === " " || char === "\t") {
      if (current !== undefined) words.push({ text: current });
      current = undefined;
    } else if (char === "&") {
      if (command[i + 1] !== "&") refuse("a background `&`");
      if (current !== undefined) words.push({ text: current });
      current = undefined;
      words.push({ operator: "&&" });
      i++;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (quote) refuse("an unclosed quote");
  if (current !== undefined) words.push({ text: current });
  return words;
}

function splitCommands(words: Word[]): string[][] {
  const commands: string[][] = [[]];
  for (const word of words) {
    if ("operator" in word) commands.push([]);
    else commands.at(-1)!.push(word.text);
  }
  if (commands.some((command) => command.length === 0)) refuse("an empty command around `&&`");
  return commands;
}

// The worktree is the nearest ancestor of cwd with a `.git` entry, else cwd. A root that contains the home directory
// would allow deletes across all of it, so it is refused.
function worktreeRoot(cwd: string): string {
  let dir = realpath(cwd);
  const start = dir;
  while (!existsSync(join(dir, ".git"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      dir = start;
      break;
    }
    dir = parent;
  }
  const realHome = realpath(home);
  if (dir === "/" || realHome === dir || realHome.startsWith(`${dir}/`)) refuse(`worktree root ${dir} contains $HOME`);
  return dir;
}

function tempRoots(): string[] {
  const candidates = ["/tmp", "/private/tmp", process.env.TMPDIR].filter((path) => path !== undefined);
  return [...new Set(candidates.filter((path) => existsSync(path)).map((path) => realpath(path)))];
}

const isInside = (path: string, root: string) => path.startsWith(`${root}/`);

type Roots = { worktree: string; temp: string[] };

function checkTarget(operand: string, base: string, recursive: boolean, roots: Roots): void {
  if (operand === "") refuse("an empty path");
  const full = operand.startsWith("/") ? operand : `${base}/${operand}`;
  const trimmed = full.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const parentPath = lastSlash > 0 ? trimmed.slice(0, lastSlash) : "/";
  const name = trimmed.slice(lastSlash + 1);
  if (name === "" || name === "." || name === "..") refuse(`\`${operand}\` names a directory by . or ..`);
  if (globChars.test(parentPath)) refuse(`a glob in a directory part of \`${operand}\``);
  // realpath(3) resolves `..` after symlinks, as the kernel does for rm's operand.
  if (!existsSync(parentPath)) refuse(`the parent of \`${operand}\` does not exist`);
  const parent = realpath(parentPath);

  if (globChars.test(name)) {
    // With a trailing slash, rm follows a matched symlink and deletes its target's contents.
    if (full.endsWith("/")) refuse(`a glob with a trailing slash \`${operand}\``);
    if (name.startsWith(".")) refuse(`a dot glob \`${operand}\``);
    if (roots.temp.includes(parent)) refuse(`a glob over a whole shared temp directory \`${operand}\``);
    if (parent === roots.worktree && recursive) refuse(`a recursive glob over the whole worktree \`${operand}\``);
    const allowed = parent === roots.worktree || [roots.worktree, ...roots.temp].some((root) => isInside(parent, root));
    if (!allowed) refuse(`\`${operand}\` is outside the worktree and temp directories`);
    return;
  }

  // With a trailing slash, rm follows a symlink to its target directory.
  const target = full.endsWith("/") && existsSync(trimmed) ? realpath(trimmed) : join(parent, name);
  if ([roots.worktree, ...roots.temp].includes(target)) refuse(`\`${operand}\` is a whole worktree or temp directory`);
  if (![roots.worktree, ...roots.temp].some((root) => isInside(target, root))) {
    refuse(`\`${operand}\` resolves to ${target}, outside the worktree and temp directories`);
  }
}

function checkRm(args: string[], base: string, roots: Roots): string {
  const operands: string[] = [];
  let recursive = false;
  let optionsEnded = false;
  for (const arg of args) {
    // GNU rm reads an option after a path, BSD rm reads it as a path: refuse the ambiguity.
    if (!optionsEnded && operands.length > 0 && arg.startsWith("-") && arg !== "-") refuse(`rm option ${arg} after a path`);
    if (!optionsEnded && arg === "--") optionsEnded = true;
    else if (!optionsEnded && arg.startsWith("--")) {
      if (!rmLongOptions.has(arg)) refuse(`rm option ${arg}`);
      if (arg === "--recursive") recursive = true;
    } else if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      if (!rmShortOption.test(arg)) refuse(`rm option ${arg}`);
      if (/[rR]/.test(arg)) recursive = true;
    } else operands.push(arg);
  }
  if (operands.length === 0) refuse("rm with no path");
  for (const operand of operands) checkTarget(operand, base, recursive, roots);
  return `rm of ${operands.length} path(s) inside the worktree or temp directories`;
}

function decide(input: HookInput): Verdict {
  const command = input.tool_input?.command;
  if (typeof command !== "string") refuse(`no Bash command (tool ${input.tool_name ?? "unknown"})`);
  if (typeof input.cwd !== "string" || !input.cwd.startsWith("/")) refuse("no absolute session cwd");
  const roots: Roots = { worktree: worktreeRoot(input.cwd), temp: tempRoots() };

  const commands = splitCommands(tokenize(command as string));
  let base = realpath(input.cwd);
  let rmCommand = commands[0]!;
  if (commands.length === 2) {
    const [cd, dir, ...extra] = commands[0]!;
    if (cd !== "cd" || dir === undefined || extra.length > 0) refuse("a chain that is not `cd <dir> && rm …`");
    // A relative dir can resolve through CDPATH, so only an absolute dir is accepted.
    if (!dir!.startsWith("/")) refuse("a relative `cd` directory");
    if (globChars.test(dir!)) refuse("a glob in the `cd` directory");
    // cd resolves `..` lexically before it follows symlinks.
    const logical = resolve(dir!);
    if (!existsSync(logical)) refuse(`the \`cd\` directory ${dir} does not exist`);
    base = realpath(logical);
    rmCommand = commands[1]!;
  } else if (commands.length > 2) refuse("more than one `&&`");

  const [name, ...args] = rmCommand;
  if (!rmNames.has(name!)) refuse(`\`${name}\` is not on the allow list`);
  return { decision: "allow", reason: checkRm(args, base, roots) };
}

function output(verdict: Verdict): string {
  const decision =
    verdict.decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: denyMessage(verdict.reason) };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

function log(input: HookInput, verdict: Verdict): void {
  const command = input.tool_input?.command;
  const summary = typeof command === "string" ? command.replace(/\s+/g, " ").slice(0, 200) : null;
  const line = {
    time: new Date().toISOString(),
    session_id: input.session_id ?? null,
    agent_id: input.agent_id ?? null,
    agent_type: input.agent_type ?? null,
    tool: input.tool_name ?? null,
    cwd: input.cwd ?? null,
    command: summary,
    decision: verdict.decision,
    reason: verdict.reason,
  };
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(line)}\n`);
  } catch {
    // A log failure must not change the decision.
  }
}

let input: HookInput = {};
let verdict: Verdict;
try {
  input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  verdict = decide(input);
} catch (error) {
  const reason = error instanceof Refusal ? error.message : `hook error: ${(error as Error).message}`;
  verdict = { decision: "deny", reason };
}
log(input, verdict);
process.stdout.write(`${output(verdict)}\n`);

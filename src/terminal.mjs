// Reaching the terminal a session is running in: bringing its tab to the front so you can answer
// it, typing one line into it, or opening a new window to carry on a finished goal.
//
// Claude writes ~/.claude/sessions/<pid>.json for every running session. From the pid, `ps` gives
// the chain of processes above it and the terminals they hold; AppleScript turns a terminal into a
// Terminal.app tab. Nothing here ever starts a session.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ANSWER = 2000;
const MAX_HOPS = 32; // a process chain deeper than this is a loop, not a terminal

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM: alive, not ours
};

// --- which sessions are running ------------------------------------------------------------------
/**
 * Claude's registry of running sessions: sessionId -> pid, for processes still alive.
 *
 * Returns null when there is no registry to ask — missing directory, or no files in it — rather
 * than an empty map, because "nothing is running" and "I cannot tell" must not look alike: the
 * first hides every session from the map, and the second has to fall back to recency instead.
 */
export function liveSessions(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  if (!names.length) return null;

  const live = new Map();
  for (const name of names) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (typeof record?.sessionId !== 'string' || !Number.isInteger(record.pid)) continue;
    // a stale file for an id can sit beside a live one, so only a running pid may claim it
    if (isAlive(record.pid)) live.set(record.sessionId, record.pid);
  }
  return live;
}

/** the pid running `sessionId`, or null */
export const findPid = (sessionId, dir) => (UUID_RE.test(sessionId ?? '') && liveSessions(dir)?.get(sessionId)) || null;

// --- the terminals a session sits under ----------------------------------------------------------
/**
 * The terminals a session's input would pass through, innermost first.
 *
 * A process with no terminal is skipped rather than treated as the end of the chain: Claude Code
 * can run a session under a background helper that has no tty, below the claude you can actually
 * see in a Terminal tab. `fg` is whether the first process found on a terminal is that terminal's
 * foreground process (`ps` marks it `+`).
 *
 * @param {Array<{tty?: string, stat?: string}>} rows ps rows, innermost first
 */
export function chainTtys(rows) {
  const out = [];
  for (const { tty, stat } of rows) {
    if (!/^ttys\d+$/.test(tty ?? '')) continue;
    if (out.some((x) => x.tty === `/dev/${tty}`)) continue; // already met: this one is further out
    out.push({ tty: `/dev/${tty}`, fg: String(stat ?? '').includes('+') });
  }
  return out;
}

/** ps rows for a pid and its ancestors, innermost first */
async function chainOf(pid) {
  const rows = [];
  for (let current = pid, hops = 0; current > 1 && hops < MAX_HOPS; hops++) {
    let stdout;
    try { ({ stdout } = await run('ps', ['-o', 'ppid=,tty=,stat=', '-p', String(current)])); } catch { break; } // exited mid-walk
    const [ppid, tty, stat] = stdout.trim().split(/\s+/);
    rows.push({ pid: current, tty, stat });
    current = Number(ppid);
  }
  return rows;
}

// --- AppleScript ---------------------------------------------------------------------------------
// Apple's Terminal only, which is what is in use here; iTerm2 would want its own branch.
const RAISE_TAB = `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if argv contains (tty of t) then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// `do script` sends the text and a Return to the tab, exactly as if you had typed it there. It
// cannot press arrow keys, which is why a picker cannot be answered this way.
const TYPE_INTO_TAB = `on run argv
  set answer to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (rest of argv) contains (tty of t) then
          do script answer in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// A new window carrying on a session. The command is typed once the shell is up, because a `script`
// wrapper in a shell rc swallows input sent before it starts. The folder and id go in as arguments
// and are quoted by AppleScript, never spliced into the string.
const RESUME_IN_WINDOW = `on run argv
  tell application "Terminal"
    activate
    set t to do script ""
    delay 3
    do script ("cd " & quoted form of (item 1 of argv) & " && claude --resume " & quoted form of (item 2 of argv)) in t
  end tell
  return "ok"
end run`;

const AUTOMATION_REFUSED = 'macOS refused: allow Automation > Terminal for node.';

// --- the actions ---------------------------------------------------------------------------------
/**
 * The one line we would type, or why we would not.
 *
 * A newline would submit the answer early, so whitespace is collapsed. A leading `!` is Claude
 * Code's shell mode, which would run the rest of the line as a shell command, so it is refused
 * outright rather than typed and hoped about.
 */
export function typeable(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER);
  if (!line) return { ok: false, error: 'Nothing to send.' };
  if (line.startsWith('!')) return { ok: false, error: 'Answers starting with ! run as shell commands; type it in the terminal.' };
  return { ok: true, line };
}

/** type one line into the Terminal tab running a session, then Return */
export async function typeInto(sessionId, dir, text) {
  const answer = typeable(text);
  if (!answer.ok) return answer;

  const pid = findPid(sessionId, dir);
  if (!pid) return { ok: false, error: 'Not open in any terminal.' };

  // `do script` types into whatever currently holds the tab, so only send while our own chain is in
  // front at every terminal along the way — never into a shell left behind by an exited or
  // suspended Claude, where the text would be run as a command.
  const chain = chainTtys(await chainOf(pid));
  if (!chain.length) return { ok: false, error: 'Answer it in its terminal.' };
  if (!chain.every((x) => x.fg)) return { ok: false, error: 'Its terminal is not showing Claude right now.' };
  if (process.platform !== 'darwin') return { ok: false, error: 'Answer it in its terminal.' };

  try {
    const { stdout } = await run('osascript', ['-e', TYPE_INTO_TAB, answer.line, ...chain.map((x) => x.tty)]);
    return stdout.trim() === 'ok' ? { ok: true } : { ok: false, error: 'Not a Terminal.app tab.' };
  } catch (e) {
    console.error(`answer: osascript failed: ${e.message}`);
    return { ok: false, error: AUTOMATION_REFUSED };
  }
}

/** bring the Terminal tab running a session to the front */
export async function focusSession(sessionId, dir) {
  const pid = findPid(sessionId, dir);
  if (!pid) return { ok: false, error: 'Not open in any terminal.' };

  const ttys = chainTtys(await chainOf(pid)).map((x) => x.tty);
  if (!ttys.length) return { ok: false, error: 'Not attached to a terminal.' };
  if (process.platform !== 'darwin') return { ok: false, error: `Open the terminal on ${ttys.at(-1)}.` };

  try {
    const { stdout } = await run('osascript', ['-e', RAISE_TAB, ...ttys]);
    return stdout.trim() === 'ok' ? { ok: true } : { ok: false, error: `Not a Terminal.app tab (${ttys.at(-1)}).` };
  } catch (e) {
    console.error(`focus: osascript failed: ${e.message}`);
    return { ok: false, error: AUTOMATION_REFUSED };
  }
}

/** open a new Terminal window carrying on `sessionId` in `dir` */
export async function resumeInTerminal(dir, sessionId) {
  if (!UUID_RE.test(sessionId ?? '')) return { ok: false, error: 'Nothing to continue.' };
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'Nothing to continue.' };
  if (process.platform !== 'darwin') return { ok: false, error: `Run: cd ${dir} && claude --resume ${sessionId}` };

  try {
    await run('osascript', ['-e', RESUME_IN_WINDOW, dir, sessionId], { timeout: 20_000 });
    return { ok: true };
  } catch (e) {
    console.error(`resume: osascript failed: ${e.message}`);
    return { ok: false, error: AUTOMATION_REFUSED };
  }
}

/** bring the Claude desktop app forward: its sessions have no tab to jump to or type into */
export async function openClaudeApp() {
  if (process.platform !== 'darwin') return { ok: false, error: 'Open the Claude app yourself.' };
  try {
    await run('open', ['-a', 'Claude']);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The Claude app is not installed.' };
  }
}

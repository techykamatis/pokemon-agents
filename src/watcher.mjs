// Follows ~/.claude/projects/**/*.jsonl as it is written. Each file is read from the byte offset we
// stopped at last time, and only up to its last complete line, so a half-written line is read once,
// whole, on a later pass. Those offsets are saved in the same JSON as progression and written with
// it, so restarting the bridge never counts a line twice and never skips one.
//
// It also decides, every second, which sessions belong on the map and what each one is doing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newCursor, readLine, stationOf, storable } from './transcript.mjs';

const CHUNK = 4 * 1024 * 1024;

export const WORKING_MS = 90_000; // touched this recently: it is working
export const AWAKE_MS = 30 * 60_000; // quiet longer than this and it goes back in its ball
export const LONG_TOOL_MS = 15 * 60_000; // a tool still out (a long build) keeps a session working
export const PROMPT_STALL_MS = 60_000; // a tool that is never slow, out this long, is a permission prompt
export const STALE_MS = 2 * 3600_000; // quiet this long and it leaves the map, even if still open

/** sessions you can talk to, as opposed to automated runs (hooks, crons, the SDK) */
export const APPS = { cli: 'TERMINAL', 'claude-desktop': 'CLAUDE APP' };

/** temp dirs and agent scratchpads: real sessions run there, but they are not projects worth a Pokémon */
export const isThrowaway = (dir) => /^(\/private)?\/(tmp|var\/folders)\//.test(`${dir}/`) || /\/scratchpad(\/|$)/.test(dir);

/** a decision put to you directly: these are a question by definition, the moment they appear */
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** tools that never legitimately take a minute, so one left out that long is sitting on a prompt.
 *  Bash, MCP calls and subagents genuinely can run for minutes, so their prompts go unnoticed. */
const QUICK_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

const safeReaddir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

/**
 * Decide what a session is doing from its cursor and how long ago it was touched. Split out of
 * sessions() because the order of these rules is the whole behaviour, and it reads better alone.
 * @returns {'waiting'|'working'|'done'|'idle'|'resting'}
 */
export function statusOf({ cursor, age, interactive, hasSubagents }) {
  const working = age < WORKING_MS || (cursor.inFlight > 0 && age < LONG_TOOL_MS) || hasSubagents;
  const blocked = interactive && [...cursor.pending.values()]
    .some((call) => ASK_TOOLS.has(call.name) || (QUICK_TOOLS.has(call.name) && age > PROMPT_STALL_MS));

  if (blocked && age < AWAKE_MS) return 'waiting';
  if (working && !cursor.waiting) return 'working';
  // the turn ended: it either asked you something, or handed back a finished report
  if (cursor.waiting && age < AWAKE_MS && interactive) return cursor.asks ? 'waiting' : 'done';
  if (age < AWAKE_MS) return 'idle';
  return 'resting';
}

export class Watcher {
  /**
   * @param {object} opts
   * @param {string} opts.root  ~/.claude/projects
   * @param {Record<string, {offset: number, cursor: object}>} [opts.scan]  saved read position per file
   * @param {(events: object[], meta: {backfill: boolean}) => void} opts.onEvents
   * @param {() => number} [opts.now]
   * @param {() => Map<string, number>|null} [opts.live]  running sessions (id -> pid) from Claude's
   *   registry, or null when there is no registry to ask, in which case recency decides instead
   * @param {() => Set<string>} [opts.pinned]  session ids to show like your own (the goals you started)
   */
  constructor({ root, scan = {}, onEvents, now = Date.now, live = () => null, pinned = () => new Set() }) {
    this.root = root;
    this.scan = scan;
    this.onEvents = onEvents;
    this.now = now;
    this.live = live;
    this.pinned = pinned;
    this.cursors = new Map(); // file -> live cursor
    this.repos = new Map(); // cwd -> { project, name }
    this.backfilling = false;
    this.progress = { files: 0, done: 0 };
  }

  /** every transcript under the root: each session's, and its subagents' */
  list() {
    const out = [];
    for (const entry of safeReaddir(this.root)) {
      if (entry.isDirectory()) this.listProject(path.join(this.root, entry.name), out);
    }
    return out;
  }

  /** one project folder: its session transcripts, plus anything under their subagents/ trees */
  listProject(dir, out) {
    for (const entry of safeReaddir(dir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(dir, entry.name));
      else if (entry.isDirectory()) collectJsonl(path.join(dir, entry.name, 'subagents'), out); // incl. subagents/workflows/<run>/
    }
  }

  /** read whatever is new in one file; events come back tagged with their project */
  readFile(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return []; }

    const seen = this.scan[file] ?? { offset: 0, cursor: { isSub: file.includes(`${path.sep}subagents${path.sep}`) } };
    if (stat.size < seen.offset) seen.offset = 0; // truncated or rewritten: start over
    if (stat.size === seen.offset && this.cursors.has(file)) { this.touch(file, stat); return []; }

    const cursor = this.cursors.get(file) ?? newCursor(seen.cursor);
    this.cursors.set(file, cursor);

    const events = [];
    const fd = fs.openSync(file, 'r');
    try {
      let offset = seen.offset;
      let carry = Buffer.alloc(0);
      const buf = Buffer.alloc(CHUNK);
      while (offset < stat.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - offset), offset);
        if (!n) break;
        offset += n;
        // split on the newline *byte*: a multi-byte character cut by the chunk edge must stay whole
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline < 0) { carry = Buffer.from(chunk); continue; }
        for (const line of chunk.toString('utf8', 0, lastNewline).split('\n')) events.push(...readLine(cursor, line));
        carry = Buffer.from(chunk.subarray(lastNewline + 1));
      }
      seen.offset = offset - carry.length; // a partial last line is re-read, whole, next time
    } finally {
      fs.closeSync(fd);
    }

    seen.cursor = storable(cursor);
    this.scan[file] = seen;
    this.touch(file, stat);
    return events
      .map((e) => ({ ...e, ...this.repoOf(e.cwd ?? cursor.cwd) }))
      .filter((e) => !isThrowaway(e.project));
  }

  touch(file, stat) {
    const cursor = this.cursors.get(file);
    if (cursor) cursor.mtime = stat.mtimeMs;
  }

  /** cwd -> the project it belongs to: its git repo (worktrees fold into the main one), else the folder */
  repoOf(cwd) {
    if (!cwd) return { project: 'unknown', name: 'UNKNOWN' };
    const known = this.repos.get(cwd);
    if (known) return known;

    let root = cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
    try {
      const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (common.endsWith(`${path.sep}.git`)) root = path.dirname(common);
    } catch { /* gone, or not a repo: the folder itself is the project */ }

    const found = { project: root, name: root === os.homedir() ? 'HOME' : path.basename(root) };
    this.repos.set(cwd, found);
    return found;
  }

  /** the first pass over all of your history; yields between files so the page stays live */
  async backfill() {
    this.backfilling = true;
    const files = this.list().sort((a, b) => mtimeOf(a) - mtimeOf(b)); // oldest first: progression in order
    this.progress = { files: files.length, done: 0 };
    for (const file of files) {
      const events = this.readFile(file);
      if (events.length) this.onEvents(events, { backfill: true });
      this.progress.done++;
      await new Promise((resume) => setImmediate(resume));
    }
    this.backfilling = false;
  }

  /** the every-two-seconds pass: only files whose size has moved */
  poll() {
    for (const file of this.list()) {
      const seen = this.scan[file];
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (seen && seen.offset === size && this.cursors.has(file)) continue;
      const events = this.readFile(file);
      if (events.length) this.onEvents(events, { backfill: false });
    }
  }

  /** how many subagents each session has working for it right now */
  subagentCounts(now) {
    const counts = new Map();
    for (const cursor of this.cursors.values()) {
      if (cursor.isSub && now - (cursor.mtime ?? 0) < WORKING_MS) {
        counts.set(cursor.sessionId, (counts.get(cursor.sessionId) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** the sessions to put on the map, most recently active first */
  sessions() {
    const now = this.now();
    const live = this.live();
    const pinned = this.pinned();
    const subagents = this.subagentCounts(now);
    const out = [];

    for (const [file, cursor] of this.cursors) {
      if (cursor.isSub || !cursor.sessionId) continue;
      const age = now - (cursor.mtime ?? cursor.lastTs);
      if (age > STALE_MS) continue;
      if (cursor.cwd && isThrowaway(this.repoOf(cursor.cwd).project)) continue;
      // its Claude exited, or /clear gave it a new id: either way that session is over
      if (cursor.entry === 'cli' && live && !live.has(cursor.sessionId)) continue;

      const isGoal = pinned.has(cursor.sessionId);
      const interactive = Object.hasOwn(APPS, cursor.entry) || isGoal;
      const status = statusOf({ cursor, age, interactive, hasSubagents: subagents.has(cursor.sessionId) });
      if (!interactive && status !== 'working') continue; // automated runs show only while they run

      const { project, name } = this.repoOf(cursor.cwd);
      out.push({
        id: cursor.sessionId,
        project,
        name,
        branch: cursor.branch,
        title: cursor.title,
        entry: cursor.entry,
        app: APPS[cursor.entry] ?? (isGoal ? 'GOAL' : 'AUTOMATED'),
        model: cursor.model,
        status,
        goal: isGoal,
        activity: cursor.activity,
        station: placeFor(status, cursor, isGoal),
        subagents: subagents.get(cursor.sessionId) ?? 0,
        lastTs: cursor.mtime ?? cursor.lastTs,
        since: cursor.turnStart || cursor.firstTs,
        file: path.basename(file),
      });
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }
}

/** where on the map this session stands: with you, at work, or resting */
function placeFor(status, cursor, isGoal) {
  if (status === 'waiting') return 'user'; // it walks up to you
  if (status === 'working') return stationOf(cursor.activity);
  return isGoal ? 'tower' : 'lounge'; // a finished goal reports at Sprout Tower
}

function collectJsonl(dir, out) {
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

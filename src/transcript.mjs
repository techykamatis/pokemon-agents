// Claude Code writes one JSONL file per session under ~/.claude/projects. This module turns those
// lines into two things: progression events (a session started, a tool ran, the tests went green, a
// commit landed) and the handful of live facts the map needs (who is working, on what, and whether
// the last turn put a question to you).
//
// It is pure — no I/O, no clock. One cursor per transcript; feed it lines in order with readLine().
// Only derived metadata ever leaves here: tool names, a short target, a title, counters. Prompts,
// file contents and tool output do not.
import path from 'node:path';

// --- what a shell command was doing -------------------------------------------------------------
export const TEST_RE = /\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|npx (vitest|jest|mocha|playwright test)|vitest( run)?|jest|pytest|py\.test|go test|cargo test|mvn test|gradle test|rspec|phpunit|make test|node --test)\b/;
export const COMMIT_RE = /\bgit\s+(-C\s+\S+\s+)?(-c\s+\S+\s+)*commit\b/;
export const MERGE_RE = /\bgh\s+pr\s+merge\b|\bgit\s+(-C\s+\S+\s+)?merge\s+(?!--abort)\S/;

/** you turning a tool down is a decision, not a failure: it must not count as an error or a red test */
const DECLINED_RE = /doesn't want to proceed|tool use was rejected|user declined|permission (to use|for) .* (denied|was denied)/i;

/** a reply that puts something to you, rather than just reporting. A keyword guess: it cannot catch
 * a question phrased as a statement, and only the tail of a reply is weighed, where asks live. */
const ASKS_RE = /\?(?=[\s*_)`"']*$|\s)|\b(needs? your (decision|call|input|approval|go-ahead|ok)|want me to|should I|shall I|let me know|your call|which (one|option|do you))\b/i;
export const asksYou = (text) => ASKS_RE.test(String(text).slice(-400));

/** tool calls in one session with no errors at all: a clean run, worth the GLACIERBADGE */
export const CLEAN_RUN_TOOLS = 25;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// --- the cursor ----------------------------------------------------------------------------------
/**
 * A transcript read so far. `pending` and `inFlight` are rebuilt from the lines after a restart, so
 * storable() drops them; everything else is carried across in the saved scan.
 * @param {object} [seed] the stored half of a cursor, when resuming a transcript
 */
export function newCursor(seed = {}) {
  return {
    // identity, learned from the first line that carries it
    isSub: !!seed.isSub,
    cwd: seed.cwd ?? null,
    sessionId: seed.sessionId ?? null,
    entry: seed.entry ?? null,
    branch: seed.branch ?? null,
    model: seed.model ?? null,
    title: seed.title ?? null,
    started: !!seed.started,

    // where the turn stands
    waiting: !!seed.waiting, // the last turn ended and no new prompt followed
    asks: seed.asks ?? !!seed.waiting, // ...and that last reply asked you something
    pending: new Map(), // tool_use id -> { name, test, commit, merge }
    inFlight: 0,
    activity: seed.activity ?? null, // { tool, target }: what it is touching now

    // counters and times
    tools: seed.tools ?? 0,
    errors: seed.errors ?? 0,
    cleanDone: !!seed.cleanDone,
    lastTestFailed: !!seed.lastTestFailed,
    dirty: seed.dirty ?? 0, // edits since its last commit
    firstTs: seed.firstTs ?? 0,
    turnStart: seed.turnStart ?? 0, // when your last prompt came in
    lastTs: seed.lastTs ?? 0,
  };
}

/** the part of a cursor worth saving next to the file's byte offset */
export const storable = ({ pending, inFlight, ...keep }) => keep;

/** most lines (attachments, queue bookkeeping, plain prompts) carry nothing we count */
const WORTH_PARSING = /"type":"(assistant|ai-title)"|"tool_result"|"stop_reason"/;

const stamp = (c, ts) => {
  if (!ts) return;
  c.lastTs = Math.max(c.lastTs, ts);
  c.firstTs ||= ts;
};

/**
 * Read one line into `cursor` (mutated in place: it is this module's cursor over the file).
 * @returns {Array<{kind: string, ts: number, cwd: string|null, sessionId: string|null}>} events
 */
export function readLine(cursor, line) {
  if (!line) return [];
  // written when a session exits: there is nobody left at that terminal to answer
  if (line.includes('"type":"cost-state"')) cursor.waiting = false;

  // Fast path. A backfill reads millions of lines, and most of them say nothing; parsing the JSON
  // of every one costs more than the whole rest of this module. Identity has to be known first.
  if (cursor.cwd && cursor.started && !WORTH_PARSING.test(line)) {
    const found = /"timestamp":"([^"]+)"/.exec(line);
    const ts = found ? Date.parse(found[1]) || 0 : 0;
    stamp(cursor, ts);
    if (line.includes('"type":"user"') && !line.includes('"tool_result"')) {
      cursor.waiting = false; // a new prompt: the ball is back with Claude
      if (ts) cursor.turnStart = ts;
    }
    return [];
  }

  let d;
  try { d = JSON.parse(line); } catch { return []; }
  // valid JSON that is not a record (`null`, a bare string, a number) carries nothing and must not throw
  if (!d || typeof d !== 'object') return [];
  const ts = d.timestamp ? Date.parse(d.timestamp) || cursor.lastTs : cursor.lastTs;
  stamp(cursor, ts);

  if (d.cwd) cursor.cwd = d.cwd;
  if (d.sessionId) cursor.sessionId = d.sessionId;
  if (d.gitBranch) cursor.branch = d.gitBranch;
  if (d.entrypoint) cursor.entry = d.entrypoint;
  if (d.isSidechain) cursor.isSub = true;
  if (d.type === 'ai-title' && d.aiTitle) cursor.title = String(d.aiTitle).slice(0, 80);

  const events = [];
  const emit = (kind, extra) => events.push({ kind, ts, cwd: cursor.cwd, sessionId: cursor.sessionId, ...extra });

  // a summary line can open a file without a session really starting there
  if (!cursor.started && cursor.cwd && !cursor.isSub && d.type !== 'summary') {
    cursor.started = true;
    emit('session', { entry: cursor.entry });
  }

  const content = Array.isArray(d.message?.content) ? d.message.content : [];
  if (d.type === 'assistant') readAssistant(cursor, d, content, emit);
  if (d.type === 'user') readUser(cursor, d, content, emit, ts);

  if (!cursor.cleanDone && !cursor.isSub && cursor.tools >= CLEAN_RUN_TOOLS && cursor.errors === 0) {
    cursor.cleanDone = true;
    emit('clean');
  }
  return events;
}

function readAssistant(cursor, d, content, emit) {
  if (d.requestedModel) cursor.model = d.requestedModel;
  for (const c of content) {
    if (c.type !== 'tool_use') continue;
    cursor.tools++;
    cursor.inFlight++;
    cursor.activity = { tool: c.name, target: toolLabel(c.name, c.input ?? {}) };
    if (EDIT_TOOLS.has(c.name)) cursor.dirty++;
    emit('tool', { name: c.name });
    const cmd = c.name === 'Bash' ? String(c.input?.command ?? '') : '';
    cursor.pending.set(c.id, { name: c.name, test: TEST_RE.test(cmd), commit: COMMIT_RE.test(cmd), merge: MERGE_RE.test(cmd) });
    if (SUBAGENT_TOOLS.has(c.name)) emit('subagent');
  }
  if (content.some((c) => c.type === 'text')) {
    cursor.asks = asksYou(content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'));
  }
  const stop = d.message?.stop_reason;
  if (stop) cursor.waiting = stop === 'end_turn' && !cursor.isSub;
  if (stop === 'tool_use') cursor.waiting = false;
}

function readUser(cursor, d, content, emit, ts) {
  let sawResult = false;
  for (const c of content) {
    if (c.type !== 'tool_result') continue;
    sawResult = true;
    cursor.inFlight = Math.max(0, cursor.inFlight - 1);
    const call = cursor.pending.get(c.tool_use_id);
    cursor.pending.delete(c.tool_use_id);
    const text = resultText(c.content);
    if (c.is_error && DECLINED_RE.test(text)) continue;
    if (c.is_error) cursor.errors++;
    if (!call) continue;
    if (call.test) {
      if (c.is_error) cursor.lastTestFailed = true;
      else {
        emit('test', { ok: true });
        if (cursor.lastTestFailed) { emit('fix'); cursor.lastTestFailed = false; }
      }
    }
    if (!c.is_error && call.commit) { emit('commit'); cursor.dirty = 0; }
    if (!c.is_error && call.merge) emit('merge');
  }
  // a line with your words in it, rather than a tool's answer, is a new prompt
  const typed = typeof d.message?.content === 'string' || content.some((c) => c.type === 'text');
  if (!sawResult && typed) {
    cursor.waiting = false;
    if (ts) cursor.turnStart = ts;
  }
}

const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x) => x.text ?? '').join(' ');
  return '';
};

// --- labels --------------------------------------------------------------------------------------
/** a short, non-sensitive label for what a tool is touching: a basename, a host, two words */
export function toolLabel(name, input) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return base(input.file_path ?? input.notebook_path);
    case 'Bash': {
      const cmd = String(input.command ?? '').replace(/^\s*(cd\s+\S+\s*&&\s*)+/, '').trim();
      return cmd.split(/\s+/).slice(0, 2).join(' ').slice(0, 24);
    }
    case 'Grep': case 'Glob':
      return String(input.pattern ?? '').slice(0, 20);
    case 'WebFetch':
      try { return new URL(input.url).hostname; } catch { return 'web'; }
    case 'WebSearch':
      return 'search';
    case 'Agent': case 'Task':
      return String(input.subagent_type ?? input.description ?? 'subagent').slice(0, 20);
    case 'Skill':
      return String(input.skill ?? '').slice(0, 20);
    default:
      return '';
  }
}

// --- where in Violet City the work happens -------------------------------------------------------
// Every building stands for a kind of work, so the map alone tells you what a session is doing.
// Anything unrecognised shops at the Mart with the rest of the shell work.
const STUDY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'Skill', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode']);
const HANDOFF_TOOLS = new Set([...SUBAGENT_TOOLS, 'Workflow', 'SendMessage', 'ListAgents']);
const READING_CMD_RE = /^(cat|head|tail|less|grep|rg|ag|ls|find|fd|tree|wc|sed -n|jq|diff)\b/;
const REACHING_OUT_CMD_RE = /^(curl|wget|http|ssh|scp|rsync)\b/;
const TESTING_CMD_RE = /^(npm|pnpm|yarn) (run )?test|^(pytest|vitest|jest)/;
const VERSIONING_CMD_RE = /^(git|gh)\b/;

/** @param {{tool: string, target?: string}|null} activity -> a station id in web/js/city.mjs */
export function stationOf(activity) {
  const tool = activity?.tool ?? '';
  if (EDIT_TOOLS.has(tool)) return 'desk'; // the house: writing things down
  if (STUDY_TOOLS.has(tool)) return 'library'; // Earl's Academy: reading and planning
  if (HANDOFF_TOOLS.has(tool)) return 'meeting'; // the trade house: work handed to subagents
  if (tool === 'WebFetch' || tool === 'WebSearch' || tool.startsWith('mcp__')) return 'gate'; // out of town
  if (tool !== 'Bash') return 'terminal';

  const cmd = activity.target ?? '';
  if (TEST_RE.test(cmd) || TESTING_CMD_RE.test(cmd)) return 'testbench'; // the Gym: the trial
  if (VERSIONING_CMD_RE.test(cmd)) return 'mergestation'; // the Center: save and heal
  if (READING_CMD_RE.test(cmd)) return 'library'; // reading through a shell is still reading
  if (REACHING_OUT_CMD_RE.test(cmd)) return 'gate';
  return 'terminal';
}

// Goals: the one place the game starts anything.
//
// A goal is a headless `claude -p` run in one of your folders, with its session id fixed up front
// so the watcher can show it as that project's Pokémon and the game can answer it later with
// `claude -p --resume <id>` — the same session, so the same Pokémon.
//
// The prompt goes in on stdin and never in argv, so no goal text can smuggle in a CLI flag. Runs
// are detached, so they outlive a bridge restart; the bridge cannot then hear their exit code, and
// marks such a run `ended` rather than claiming it knows how it went.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_GOAL = 4000; // Claude Code's own limit for a prompt like this
const REMEMBERED = 50; // finished goals kept in the list
const ORPHAN_CHECK_MS = 5000;

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * @param {object} opts
 * @param {string} opts.home  where goals.json and the run logs live
 * @param {string} [opts.bin] the claude CLI: CLAUDE_BIN, or `claude` on PATH
 * @param {number} [opts.maxRunning]
 * @param {() => void} [opts.onChange] called whenever any goal changes, so the page can be told
 */
export function createRuns({ home, bin = process.env.CLAUDE_BIN ?? 'claude', maxRunning = 4, onChange = () => {} }) {
  const file = path.join(home, 'goals.json');
  const logDir = path.join(home, 'goals');
  const ourPids = new Set(); // pids this bridge spawned: we hear their exit, so polling can skip them
  let goals = load();

  function load() {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`goals.json unreadable (${e.message}); starting with none`);
    }
    if (!Array.isArray(saved)) return [];
    // anything still marked running whose process has gone died with the last bridge
    return saved.map((g) => (g.status === 'running' && !isAlive(g.pid) ? { ...g, status: 'ended', pid: null } : g));
  }

  function save() {
    try {
      fs.mkdirSync(home, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(goals));
      fs.renameSync(temp, file);
    } catch (e) {
      console.error(`could not save goals: ${e.message}`);
    }
    onChange();
  }

  const update = (id, fields) => { goals = goals.map((g) => (g.id === id ? { ...g, ...fields } : g)); save(); };
  const runningCount = () => goals.filter((g) => g.status === 'running').length;

  /** start one `claude -p` with `prompt` on stdin, reporting its end against `goalId` */
  function spawnClaude(args, cwd, prompt, goalId) {
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, `${goalId ?? 'reply'}.log`), 'a');
    const child = spawn(bin, args, { cwd, detached: true, stdio: ['pipe', log, log], env: process.env });
    fs.closeSync(log);

    child.on('error', (e) => {
      console.error(`goal ${goalId}: ${e.message}`);
      if (goalId) update(goalId, { status: 'failed', pid: null, ended: Date.now(), error: e.message });
    });

    ourPids.add(child.pid);
    child.on('exit', (code, signal) => {
      ourPids.delete(child.pid);
      if (!goalId) return;
      const goal = goals.find((g) => g.id === goalId);
      // an older run of this goal: the newer one owns the status now
      if (goal?.pid !== child.pid) return;
      const status = goal?.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
      update(goalId, { status, pid: null, ended: Date.now(), exitCode: code ?? signal, stopping: undefined });
      sendQueued(goalId);
    });

    child.stdin.on('error', () => {}); // it may exit before it ever reads
    child.stdin.end(prompt);
    child.unref();
    return child.pid;
  }

  /** a run just ended: if you answered while it was still alive, send that answer now */
  function sendQueued(goalId) {
    const goal = goals.find((g) => g.id === goalId);
    if (!goal?.queued) return;
    const pid = spawnClaude(['-p', '--resume', goal.sessionId], goal.project, goal.queued, goal.id);
    update(goal.id, { status: 'running', pid, ended: null, queued: undefined });
  }

  // A run from before a bridge restart is not our child, so there is no exit event to wait for.
  // Notice it finishing by checking whether its pid is still there.
  const orphanWatch = setInterval(() => {
    for (const goal of goals) {
      if (goal.status !== 'running' || !goal.pid || ourPids.has(goal.pid) || isAlive(goal.pid)) continue;
      update(goal.id, { status: 'ended', pid: null, ended: Date.now() });
      sendQueued(goal.id);
    }
  }, ORPHAN_CHECK_MS);
  orphanWatch.unref();

  return {
    /** @returns {{ok: true, goal: object} | {ok: false, error: string}} */
    start({ project, text }) {
      const prompt = typeof text === 'string' ? text.trim() : '';
      if (!prompt) return { ok: false, error: 'The goal is empty.' };
      if (prompt.length > MAX_GOAL) return { ok: false, error: `Keep the goal under ${MAX_GOAL} characters.` };
      if (typeof project !== 'string' || !isDir(project)) return { ok: false, error: 'That project folder is gone.' };
      if (runningCount() >= maxRunning) return { ok: false, error: `${maxRunning} goals are already running. Wait or STOP one.` };

      const goal = {
        id: randomUUID().slice(0, 8),
        sessionId: randomUUID(), // fixed up front, so the watcher and the game agree on who this is
        project,
        text: prompt,
        started: Date.now(),
        status: 'running',
      };
      goals = [goal, ...goals].slice(0, REMEMBERED);
      const pid = spawnClaude(['-p', '--session-id', goal.sessionId], project, prompt, goal.id);
      update(goal.id, { pid });
      return { ok: true, goal: goals.find((g) => g.id === goal.id) };
    },

    /**
     * Answer a headless session by resuming it — the same session id, so the same Pokémon.
     *
     * A goal whose run is still alive (watching CI in the background, say, having asked you
     * something on the way) cannot be resumed underneath itself, so the answer is queued and sent
     * the moment that run ends. `now` stops the run so it goes out at once.
     */
    resume(sessionId, cwd, text, { now = false } = {}) {
      const answer = typeof text === 'string' ? text.trim() : '';
      if (!UUID_RE.test(sessionId ?? '') || !answer || answer.length > MAX_GOAL || !isDir(cwd)) {
        return { ok: false, error: 'Nothing to send.' };
      }
      const goal = goals.find((g) => g.sessionId === sessionId);
      if (goal?.status === 'running') {
        update(goal.id, { queued: answer });
        if (now && goal.pid) endProcess(goal.pid);
        return { ok: true, queued: true };
      }
      const pid = spawnClaude(['-p', '--resume', sessionId], cwd, answer, goal?.id);
      if (goal) update(goal.id, { status: 'running', pid, ended: null });
      return { ok: true };
    },

    stop(id) {
      const goal = goals.find((g) => g.id === id);
      if (!goal || goal.status !== 'running' || !goal.pid) return { ok: false, error: 'Not running.' };
      // you stopped it on purpose, so a queued answer must not then be sent to it
      update(id, { stopping: true, queued: undefined });
      endProcess(goal.pid);
      return { ok: true };
    },

    list: () => goals,

    /** the session ids of every goal we remember: the watcher keeps these on the map after the run ends */
    sessionIds: () => new Set(goals.map((g) => g.sessionId)),
  };
}

/** the run is detached, so it leads its own process group: signal the group, then just the leader */
function endProcess(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

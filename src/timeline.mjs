// The timeline: everything that happened, so a sound you heard while looking the other way can be
// found again. The bridge already sends the page a picture of the world every second, so rather
// than instrumenting every code path, this diffs one picture against the last and writes down what
// changed — plus the progression milestones, which arrive as events of their own.
//
// Entries are kept in <home>/timeline.json, newest last and capped, and pushed to the page as they
// are added. Every sound the game plays has an entry here.
import fs from 'node:fs';
import path from 'node:path';

/** statuses worth writing down. Idle is just quiet, and nobody needs a record of quiet. */
const LOGGED = new Set(['working', 'waiting', 'done', 'resting']);

/**
 * Pure: what changed between two looks at the world.
 * @param {null | {sessions: Map, goals: Map, alerts: Set}} before  null on the first look, when
 *   nothing is news yet: everything already on screen when the bridge started is not an event.
 * @param {{sessions: object[], goals: object[], legends: Record<string, object>}} now
 * @returns {{state: object, entries: object[]}} entries carry the kind, ids and names; the caller
 *   adds the time and the words.
 */
export function diffWorld(before, { sessions, goals, legends }) {
  const state = {
    sessions: new Map(sessions.map((s) => [s.id, { status: s.status, name: s.name, project: s.project, app: s.app, title: s.title }])),
    goals: new Map(goals.map((g) => [g.id, g.status])),
    alerts: new Set(Object.entries(legends).filter(([, l]) => l.alert).map(([id]) => id)),
  };
  if (!before) return { state, entries: [] };

  const entries = [];
  for (const s of sessions) {
    const was = before.sessions.get(s.id)?.status;
    if (was !== s.status && LOGGED.has(s.status)) {
      entries.push({ kind: s.status, id: s.id, name: s.name, project: s.project, app: s.app, title: s.title });
    }
  }
  // a session that has left the map keeps the name it had, so the entry still reads as something
  for (const [id, was] of before.sessions) {
    if (!state.sessions.has(id)) entries.push({ kind: 'left', id, name: was.name, project: was.project, app: was.app, title: was.title });
  }
  for (const g of goals) {
    if (before.goals.get(g.id) !== g.status) {
      entries.push({ kind: `goal-${g.status}`, id: g.sessionId, project: g.project, name: path.basename(g.project), text: g.text });
    }
  }
  // only a legendary that has *started* pointing at something is news; one still pointing is not
  for (const id of state.alerts) {
    if (!before.alerts.has(id)) entries.push({ kind: 'legend', legend: Number(id), name: legends[id].name, text: legends[id].lines[0] ?? '' });
  }
  return { state, entries };
}

/**
 * @param {object} opts
 * @param {string} opts.file
 * @param {number} [opts.max]
 * @param {(entries: object[]) => void} [opts.onAdd]
 * @param {() => number} [opts.now]
 */
export function createTimeline({ file, max = 300, onAdd = () => {}, now = Date.now }) {
  let entries = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved)) entries = saved.slice(-max);
  } catch { /* nothing written yet, or unreadable: start a fresh log rather than refuse to boot */ }

  let timer = null;

  // written to a temp file and renamed, so a crash mid-write cannot leave a half-written log behind
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(entries));
      fs.renameSync(temp, file);
    } catch (e) {
      console.error(`could not save the timeline: ${e.message}`);
    }
  };

  return {
    add(added) {
      if (!added.length) return;
      const stamped = added.map((e) => ({ ts: now(), ...e }));
      entries = [...entries, ...stamped].slice(-max);
      onAdd(stamped);
      if (!timer) timer = setTimeout(flush, 2000); // batched: statuses can change every second
    },
    list: () => entries,
    flush,
  };
}

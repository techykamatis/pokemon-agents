// The bridge. It follows your Claude Code transcripts, turns them into Pokémon progression, serves
// the game, and pushes the live picture to the page over a WebSocket.
//
//   ~/.claude/projects/**/*.jsonl -> watcher -> progression -> <home>/progress.json (+ byte offsets)
//                                          `-> live sessions --- WebSocket ---> the browser
//
// It listens on 127.0.0.1 only, and answers only its own page: both the Origin and the Host header
// are checked, which also shuts the door on DNS rebinding. What it sends is derived metadata; the
// text of a reply leaves only when you open that session yourself. It never touches a repository.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';

import { legendsReport } from './legends.mjs';
import { createProgression } from './progression.mjs';
import { recapOf } from './recap.mjs';
import { assignLooks } from './roster.mjs';
import { createRuns } from './runs.mjs';
import { focusSession, liveSessions, openClaudeApp, resumeInTerminal, typeInto } from './terminal.mjs';
import { createTimeline, diffWorld } from './timeline.mjs';
import { Watcher, isThrowaway } from './watcher.mjs';
import { chooseFolder, goalFolder, newFolder } from './workspaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: opt } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PKMN_PORT ?? '7880' },
    home: { type: 'string', default: process.env.PKMN_HOME ?? path.join(os.homedir(), '.pokemon-agents') },
    projects: { type: 'string', default: process.env.PKMN_PROJECTS ?? path.join(os.homedir(), '.claude', 'projects') },
    sessions: { type: 'string', default: process.env.PKMN_SESSIONS ?? path.join(os.homedir(), '.claude', 'sessions') },
    dev: { type: 'boolean', default: false },
  },
});

const PORT = Number(opt.port);
const ASSETS = path.join(ROOT, '.cache', 'assets');
const WEB = path.join(ROOT, 'web');
const STATE_FILE = path.join(opt.home, 'progress.json');
const STATE_VERSION = 1;
const MAX_FRAME = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

const pokedexFile = path.join(ASSETS, 'pokedex.json');
if (!fs.existsSync(pokedexFile)) {
  console.error('Pokémon assets missing: run `npm run setup` first. It fetches them into .cache/, which is never committed.');
  process.exit(1);
}
const pokedex = JSON.parse(fs.readFileSync(pokedexFile, 'utf8'));

// --- state: progression and the read offsets, one file, written atomically together -------------
const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const saved = JSON.parse(raw);
    if (saved?.version === STATE_VERSION && isRecord(saved.progress?.mons) && isRecord(saved.progress?.team) && isRecord(saved.scan)) return saved;
    throw new Error('not the shape we write');
  } catch (e) {
    // never silently discard someone's progress: start fresh, but keep the file we could not read
    console.error(`progress.json unreadable (${e.message}); starting fresh, the old file kept as .bad`);
    try { fs.renameSync(STATE_FILE, `${STATE_FILE}.bad`); } catch (err) { console.error(`could not keep a .bad copy: ${err.message}`); }
    return {};
  }
}

const saved = loadState();
const progression = createProgression({ pokedex, state: saved.progress });
const speciesName = (id) => pokedex.species.find((s) => s.id === id)?.name ?? `#${id}`;

const forgotten = progression.forget(isThrowaway);
if (forgotten.length) {
  const backup = `${STATE_FILE}.bak-${Date.now()}`;
  try { fs.copyFileSync(STATE_FILE, backup); } catch (e) { console.error(`could not back up before forgetting: ${e.message}`); }
  console.log(`forgot ${forgotten.length} throwaway folders, backup at ${backup}: ${forgotten.join(', ')}`);
}
for (const change of progression.rerollSharedFamilies()) {
  console.log(`re-rolled ${change.project}: ${speciesName(change.from)} -> ${speciesName(change.to)} (it shared a family with an older project)`);
}

const runs = createRuns({ home: opt.home, onChange: () => pushSessions() });
const watcher = new Watcher({
  root: opt.projects,
  scan: saved.scan ?? {},
  onEvents,
  live: () => liveSessions(opt.sessions),
  pinned: () => runs.sessionIds(),
});

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: STATE_VERSION, progress: progression.state, scan: watcher.scan }));
    fs.renameSync(temp, STATE_FILE);
  } catch (e) {
    console.error(`could not save progress: ${e.message}`);
  }
}
const saveSoon = (ms = 1000) => { if (!saveTimer) saveTimer = setTimeout(saveNow, ms); };

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { saveNow(); timeline.flush(); process.exit(0); });
}
// a single bad line in one transcript must not take the whole bridge down with it
process.on('uncaughtException', (e) => console.error(`bridge: ${e.stack}`));

// --- what the page is sent ----------------------------------------------------------------------
const browsers = new Set();
const sendJson = (ws, message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
const toAll = (message) => { for (const ws of browsers) sendJson(ws, message); };

const stateMessage = () => ({ v: 1, type: 'state', state: progression.state, dev: opt.dev });

const sessionsMessage = () => {
  const live = watcher.sessions();
  const team = progression.state.team;
  return {
    v: 1,
    type: 'sessions',
    sessions: assignLooks(live, progression.state.mons, pokedex),
    // the pid is ours to manage, not the page's business
    goals: runs.list().map(({ pid, ...goal }) => goal),
    legends: legendsReport({
      unlocked: team.legendaries,
      cursors: [...watcher.cursors.values()],
      sessions: live,
      team,
      goals: runs.list(),
      now: Date.now(),
    }),
    scanning: watcher.backfilling ? watcher.progress : null,
  };
};

function onEvents(events, { backfill }) {
  const milestones = progression.apply(events);
  saveSoon(backfill ? 5000 : 1000); // a backfill writes once in a while; live work writes promptly
  if (backfill) return; // the first pass is history, not news: no sounds, no popups, no timeline
  if (milestones.length) {
    toAll({ v: 1, type: 'milestones', events: milestones });
    timeline.add(milestones.map(milestoneEntry).filter(Boolean));
  }
  toAll(stateMessage());
}

// --- the timeline -------------------------------------------------------------------------------
const timeline = createTimeline({
  file: path.join(opt.home, 'timeline.json'),
  onAdd: (entries) => toAll({ v: 1, type: 'timeline.add', entries }),
});

const speciesCaps = (id) => pokedex.species.find((s) => s.id === id)?.name.toUpperCase() ?? `#${id}`;
const nicknameOf = (project) => progression.state.mons[project]?.nickname ?? path.basename(project ?? '').toUpperCase();
const firstSentence = (text) => (text ?? '').match(/^.{0,140}?[.!?](\s|$)/)?.[0].trim() ?? (text ?? '').slice(0, 140);

const MILESTONE_WORDS = {
  level: (e) => `grew to level ${e.level}`,
  evolve: (e) => `evolved: ${speciesCaps(e.from)} became ${speciesCaps(e.to)}`,
  badge: (e) => `earned the ${e.name} (${e.why})`,
  achievement: (e) => (e.egg ? `found an EGG (${e.why})` : `${e.name} (${e.why})`),
  join: (e) => `a wild ${speciesCaps(e.species)} appeared${e.shiny ? ', SHINY' : ''}`,
  hatch: (e) => `the EGG hatched into ${speciesCaps(e.species)}`,
};

function milestoneEntry(e) {
  if (!MILESTONE_WORDS[e.kind]) return null;
  const appeared = e.legendary ? `; ${speciesCaps(e.legendary)} appeared in VIOLET CITY` : '';
  return { kind: e.kind, project: e.agentId, name: nicknameOf(e.agentId), text: `${MILESTONE_WORDS[e.kind](e)}${appeared}` };
}

/** a session entry gets its words from the transcript: the question it asked, or the report it gave */
function withWords(entry) {
  if (entry.text !== undefined) return entry;
  if (entry.kind === 'working') return { ...entry, text: entry.title ?? '' };
  if (entry.kind !== 'waiting' && entry.kind !== 'done') return { ...entry, text: '' };
  const file = transcriptOf(entry.id);
  const recap = file ? recapOf(file) : {};
  const words = entry.kind === 'waiting'
    ? recap.question ?? recap.cta
    : recap.recap ?? firstSentence(recap.reply);
  return { ...entry, text: words ?? entry.title ?? '' };
}

let lastWorld = null; // null until the startup scan is done: nothing before that is news
function recordChanges(message) {
  if (watcher.backfilling) return;
  const { state, entries } = diffWorld(lastWorld, message);
  lastWorld = state;
  timeline.add(entries.map(withWords));
}

let lastSessionsJson = '';
function pushSessions() {
  const message = sessionsMessage();
  recordChanges(message);
  const json = JSON.stringify(message);
  if (json === lastSessionsJson) return; // nothing moved: do not wake the page for it
  lastSessionsJson = json;
  for (const ws of browsers) if (ws.readyState === WebSocket.OPEN) ws.send(json);
}

// --- HTTP ---------------------------------------------------------------------------------------
const allowedOrigin = (origin) => origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
const allowedHost = (host) => host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;

function serveFile(res, base, relative) {
  if (relative.includes('\0')) { res.writeHead(400).end(); return; }
  const file = path.resolve(base, `.${path.posix.normalize(`/${relative}`)}`);
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; } // outside what we serve
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(body);
  });
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_FRAME) throw new Error('body too large');
  }
  return JSON.parse(body || '{}');
}

// --- the actions the game can ask for -----------------------------------------------------------
// A session living in the Claude desktop app has no tab to type into, so TERMINAL and answering
// bring the app forward instead and you finish there.
const IN_APP = new Set(['claude-desktop']);

const sessionById = (id) => watcher.sessions().find((s) => s.id === id);
const entryOf = (id) => sessionById(id)?.entry;
const transcriptOf = (id) => [...watcher.cursors].find(([, c]) => c.sessionId === id && !c.isSub)?.[0];

const ROUTES = {
  '/focus': ({ id }) => {
    if (IN_APP.has(entryOf(id))) return openClaudeApp();
    return runs.sessionIds().has(id) ? continueGoal(id) : focusSession(id, opt.sessions);
  },
  '/goal': ({ project, text }) => {
    const folder = goalFolder(project);
    return folder.ok ? runs.start({ project: folder.dir, text }) : folder;
  },
  '/goal/stop': ({ id }) => runs.stop(id),
  '/folder/choose': () => chooseFolder(),
  '/folder/new': ({ name }) => newFolder(name),
  '/answer': ({ id, text, now }) => answer(id, text, now === true),
  '/recap': ({ id }) => {
    const file = typeof id === 'string' && transcriptOf(id);
    return file ? { ok: true, ...recapOf(file) } : { ok: false, error: 'No such session.' };
  },
};

/** a goal runs headless, so there is no tab to jump to while it works; once it stops, carry it on */
function continueGoal(id) {
  const goal = runs.list().find((g) => g.sessionId === id);
  if (goal?.status === 'running') {
    return { ok: false, error: 'It works in the background, with no terminal. RECAP shows its last reply; STOP ends it; once it stops this continues it in a terminal.' };
  }
  return resumeInTerminal(goal?.project ?? watcher.cursors.get(transcriptOf(id))?.cwd, id);
}

async function answer(id, text, now = false) {
  const session = typeof id === 'string' && sessionById(id);
  if (!session) return { ok: false, error: 'No such session.' };
  if (IN_APP.has(session.entry)) return { ok: false, error: 'Answer it in the Claude app: OPEN APP.' };

  const file = transcriptOf(id);
  const isGoal = runs.sessionIds().has(id);
  if (session.status === 'working' && !isGoal) return { ok: false, error: 'It is still working.' };
  // anything not at a terminal of its own is headless, so it is answered by being resumed
  if (session.entry !== 'cli') return runs.resume(id, watcher.cursors.get(file)?.cwd, text, { now });
  if (recapOf(file).picker) return { ok: false, error: 'That is a picker: answer it in its terminal.' };
  return typeInto(id, opt.sessions, text);
}

async function handleRoute(req, res, route) {
  if (req.method !== 'POST' || !allowedOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
  try {
    const out = await route(await readBody(req));
    res.writeHead(out.ok ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(out));
  } catch (e) {
    console.error(`${req.url}: ${e.message}`);
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Bad request.' }));
  }
}

/** dev only, for the e2e and demo runs: push made-up events, force a species, hand out items */
async function handleDevRoute(req, res) {
  if (!opt.dev || req.method !== 'POST' || !allowedOrigin(req.headers.origin)) { res.writeHead(404).end(); return; }
  try {
    const body = await readBody(req);
    let events = [];
    if (req.url === '/dev/apply') events = progression.apply(body.events);
    else if (req.url === '/dev/patch') progression.patch(body.agentId, body.fields);
    else if (req.url === '/dev/give') events = progression.give(body.items);
    else { res.writeHead(404).end(); return; }
    saveSoon();
    toAll({ v: 1, type: 'milestones', events });
    toAll(stateMessage());
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, events }));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  try {
    if (!allowedHost(req.headers.host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (Object.hasOwn(ROUTES, url.pathname)) { handleRoute(req, res, ROUTES[url.pathname]); return; }
    if (url.pathname.startsWith('/dev/')) { handleDevRoute(req, res); return; }
    if (url.pathname.startsWith('/assets/')) {
      serveFile(res, ASSETS, decodeURIComponent(url.pathname.slice('/assets/'.length)));
      return;
    }
    serveFile(res, WEB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  } catch {
    // a malformed path can throw while being decoded: answer it, do not fall over
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_FRAME,
  verifyClient: ({ req }) => allowedOrigin(req.headers.origin) && allowedHost(req.headers.host),
});

wss.on('connection', (ws) => {
  browsers.add(ws);
  sendJson(ws, stateMessage());
  sendJson(ws, sessionsMessage());
  sendJson(ws, { v: 1, type: 'timeline', entries: timeline.list() });
  ws.on('error', () => {}); // a browser going away is not an error worth logging
  ws.on('close', () => browsers.delete(ws));
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`pokemon-agents on http://127.0.0.1:${PORT}  (watching ${opt.projects}, progress in ${STATE_FILE}${opt.dev ? ', dev hooks on' : ''})`);
  const started = Date.now();

  setInterval(pushSessions, 1000);
  await watcher.backfill();
  saveNow();

  const projects = Object.keys(progression.state.mons).length;
  console.log(`read ${watcher.progress.files} transcripts in ${((Date.now() - started) / 1000).toFixed(1)}s: ${projects} projects`);
  toAll(stateMessage());
  toAll({ v: 1, type: 'milestones', events: [{ kind: 'scanned', files: watcher.progress.files, projects }] });

  setInterval(() => watcher.poll(), 2000);
});

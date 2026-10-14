#!/usr/bin/env node
// End to end, in a real browser, against a synthetic ~/.claude/projects that is written while the
// game watches. It screenshots each step, forces one evolution on screen, drives a goal from typing
// it to answering the question it asks, and finally restarts the bridge to check that replaying the
// same transcripts changes nothing.
//
// It never reads your real sessions: its own port, its own temp directories, its own fake `claude`.
//   npm run e2e           -> artifacts/e2e/<when>/
//   npm run e2e -- --real -> also screenshots your real sessions, read-only
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALSO_REAL = process.argv.includes('--real');
const PORT = 7990;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(ROOT, 'artifacts', 'e2e', STAMP);
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-projects-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-home-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// --- a world to watch ----------------------------------------------------------------------------
let clock = Date.now() - 60_000;
const nextTime = () => new Date((clock += 500)).toISOString();

const transcript = (repo, sessionId, entry = 'cli', cwd = `/e2e/${repo}`) => {
  const dir = path.join(PROJECTS, `-tmp-${repo}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const base = { cwd, sessionId, gitBranch: 'main', entrypoint: entry };
  const put = (line) => fs.appendFileSync(file, `${JSON.stringify({ ...base, timestamp: nextTime(), ...line })}\n`);
  let n = 0;
  return {
    prompt: (text) => put({ type: 'user', message: { content: text } }),
    title: (title) => put({ type: 'ai-title', aiTitle: title }),
    tool: (name, input, { ok = true, leaveOpen = false } = {}) => {
      const id = `${sessionId}-${n++}`;
      put({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
      if (leaveOpen) return;
      put({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? 'ok' : 'Exit code 1' }] } });
    },
    reply: (text = 'Done.') => put({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } }),
  };
};

// a session that ends on a question: it should come and find you
const shop = transcript('pocket-shop', 'aaaa1111');
shop.prompt('add a cart');
shop.title('Shopping cart feature');
for (let i = 0; i < 6; i++) shop.tool('Read', { file_path: `/e2e/pocket-shop/src/f${i}.ts` });
shop.tool('Bash', { command: 'npm test' }, { ok: false });
shop.tool('Edit', { file_path: '/e2e/pocket-shop/src/cart.ts' });
shop.tool('Bash', { command: 'npm test' });
shop.tool('Bash', { command: 'git commit -m "cart"' });
shop.reply('Committed the cart. Want me to open a PR?');

// one still working
const api = transcript('billing-api', 'bbbb2222');
api.prompt('fix invoices');
api.title('Invoice rounding bug');
api.tool('Grep', { pattern: 'round(' });

// one that finished with a plain report: done, not needing you
const docs = transcript('team-docs', 'cccc3333');
docs.prompt('summarize');
docs.title('Weekly notes');
docs.tool('WebSearch', { query: 'x' });
docs.reply('Summarized the week in NOTES.md.');

// an automated run, which should show only while it is working
const hook = transcript('pocket-shop', 'dddd4444', 'sdk-py');
hook.prompt('security review');
hook.title('Security review');
hook.tool('Read', { file_path: '/e2e/pocket-shop/src/cart.ts' }, { leaveOpen: true });

// A goal needs a real folder inside home that is neither a temp dir nor this repository. It is made
// a repository of its own, so it is a project in its own right rather than part of this one.
const GOAL_LAB = path.join(ROOT, 'artifacts', 'e2e-goal-lab');
fs.mkdirSync(GOAL_LAB, { recursive: true });
if (!fs.existsSync(path.join(GOAL_LAB, '.git'))) execFileSync('git', ['init', '-q', GOAL_LAB]);
const lab = transcript('goal-lab', 'eeee5555', 'cli', GOAL_LAB);
lab.prompt('set up');
lab.reply('Set up.');

const goalCalls = () => {
  try {
    return fs.readFileSync(path.join(PROJECTS, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch { return []; }
};

// --- run it --------------------------------------------------------------------------------------
const startBridge = () => spawn(process.execPath, [
  path.join(ROOT, 'src/server.mjs'),
  '--port', String(PORT), '--home', HOME, '--projects', PROJECTS,
  '--sessions', path.join(HOME, 'no-registry'), '--dev',
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_BIN: path.join(ROOT, 'scripts', 'fake-claude.mjs'), E2E_PROJECTS: PROJECTS },
});

async function waitForBridge() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(ORIGIN)).ok) return; } catch { /* still starting */ }
    await sleep(200);
  }
  throw new Error('the bridge did not start');
}

const dev = async (route, body) => (await fetch(`${ORIGIN}/dev/${route}`, {
  method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify(body),
})).json();

const report = { steps: [], checks: {} };
let bridge = startBridge();
let browser;
let shotNumber = 0;

try {
  await waitForBridge();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 700, height: 680 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`));

  const shot = async (name) => {
    await page.locator('.screen').screenshot({ path: path.join(OUT, `${String(++shotNumber).padStart(2, '0')}-${name}.png`) });
    report.steps.push(name);
  };
  const press = async (key, ms = 150) => { await page.keyboard.press(key); await sleep(ms); };
  const look = () => page.evaluate(() => {
    const app = window.__pokemonAgents;
    if (!app) return {};
    return {
      top: app.ui.top?.constructor.name,
      sessions: app.bridge.sessions.map((s) => ({ name: s.name, status: s.status, station: s.station })),
      projects: Object.keys(app.bridge.progress?.mons ?? {}).length,
      badges: app.bridge.progress?.team.badges.map((b) => b.id) ?? [],
    };
  });
  // a milestone can pop up whenever the page is idle: clear anything open before a scripted sequence
  const clear = async () => { for (let i = 0; i < 10 && (await look()).top; i++) await press('Escape', 200); };

  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__pokemonAgents?.bridge.sessions.length >= 3 && !window.__pokemonAgents.bridge.scanning, null, { timeout: 30_000 });
  await sleep(1500);
  for (let i = 0; i < 20 && (await look()).top; i++) await press('z', 200); // dismiss the scan's badges

  const first = await look();
  report.checks.sessions = first.sessions;
  report.checks.waitingComesToYou = first.sessions.some((s) => s.name === 'pocket-shop' && s.status === 'waiting' && s.station === 'user');
  report.checks.reportIsDoneNotNeedsYou = first.sessions.some((s) => s.name === 'team-docs' && s.status === 'done' && s.station === 'lounge');
  report.checks.automatedShownWhileWorking = first.sessions.filter((s) => s.name === 'pocket-shop').length === 2;
  report.checks.badgesFromTheScan = first.badges;
  await sleep(2500);
  await shot('overworld');

  // live work: billing-api keeps going, then hands off to a subagent, which is a trade
  await dev('patch', { agentId: '/e2e/billing-api', fields: { species: 64 } }); // Kadabra
  for (let i = 0; i < 3; i++) { api.tool('Edit', { file_path: '/e2e/billing-api/src/invoice.ts' }); await sleep(300); }
  api.tool('Agent', { subagent_type: 'Explore', description: 'find the callers' });
  await page.waitForFunction(() => window.__pokemonAgents.ui.top?.constructor.name === 'EvolutionScene', null, { timeout: 15_000 });
  await sleep(2200);
  await shot('evolution-flashing');
  await sleep(3600);
  await shot('evolution-revealed');
  for (let i = 0; i < 10 && (await look()).top; i++) await press('z', 250);
  report.checks.handoffEvolved = (await page.evaluate(() => window.__pokemonAgents.bridge.progress.mons['/e2e/billing-api'].species)) === 65;

  await press('m', 800); await shot('town-map'); await press('Escape');
  await press('d', 600); await shot('needs-you');
  await press('z', 1200); await shot('summary');
  const summaryRows = await page.evaluate(() => window.__pokemonAgents.ui.top?.list?.map((r) => r.text.trim()) ?? []);
  report.checks.summaryShowsAskAndNeed = summaryRows.includes('YOU ASKED')
    && summaryRows.includes('add a cart')
    && summaryRows.includes('Want me to open a PR?');
  await press('Escape'); await press('Escape');

  // walk to it: you walk there yourself, and talk once you arrive
  await clear();
  await press('Enter'); await press('z', 600); await shot('sessions');
  await press('z', 400); await shot('session-menu'); await press('z', 200);
  await page.waitForFunction(() => window.__pokemonAgents.ui.top?.constructor.name === 'TextBox', null, { timeout: 20_000 });
  report.checks.walkToArrives = await page.evaluate(() => {
    const { overworld } = window.__pokemonAgents;
    const dirs = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
    const [dx, dy] = dirs[overworld.player.facing];
    return [...overworld.walkers.values()].some((w) => w.x === overworld.player.x + dx && w.y === overworld.player.y + dy);
  });
  await shot('walked-to');
  await clear();

  // the cards
  await press('Enter'); for (let i = 0; i < 3; i++) await press('ArrowDown', 60);
  await press('z', 600); await press('z', 400); await press('ArrowDown', 60); await press('z', 800);
  await shot('pokedex-card');
  await clear();
  await press('Enter'); for (let i = 0; i < 5; i++) await press('ArrowDown', 60);
  await press('z', 600); await shot('trainer-card'); await press('Escape');
  await clear();
  await press('Enter'); for (let i = 0; i < 4; i++) await press('ArrowDown', 60);
  await press('z', 600); await shot('pc-box'); await press('Escape');

  // a goal, start to finish: type it, it asks, you answer on screen
  await clear();
  await press('Enter'); for (let i = 0; i < 6; i++) await press('ArrowDown', 60);
  await press('z', 600); await shot('goals');
  await press('z', 500); await shot('goal-where');
  const typePathRow = await page.evaluate(() => window.__pokemonAgents.ui.top.list.filter((r) => r.onPick).findIndex((r) => r.text === 'TYPE A PATH'));
  for (let i = 0; i < typePathRow; i++) await press('ArrowDown', 40);
  await press('z', 400);
  await page.keyboard.type(GOAL_LAB); await press('Enter', 400);
  await page.keyboard.type('Pick a database for the app'); await press('Enter', 600);
  await shot('goal-started');
  await clear();

  await page.waitForFunction(
    () => String(window.__pokemonAgents.ui.top?.title ?? '').includes('ASKS')
      && window.__pokemonAgents.ui.top.list.some((r) => r.text.includes('SQLite')),
    null, { timeout: 20_000 },
  );
  await shot('its-question');
  const firstCall = goalCalls()[0];
  report.checks.goalRunsHeadlessAndAsks = firstCall?.args[0] === '-p'
    && firstCall?.args[1] === '--session-id'
    && firstCall?.stdin === 'Pick a database for the app';

  await press('z', 400); await shot('confirm-option'); await press('z', 1200); await shot('answer-sent');
  for (let i = 0; i < 50 && goalCalls().length < 2; i++) await sleep(100);
  const secondCall = goalCalls()[1];
  report.checks.answeredOnScreen = secondCall?.args[1] === '--resume'
    && secondCall?.args[2] === firstCall?.args[2]
    && secondCall?.stdin === 'Option 1: Postgres';
  await clear();

  // the timeline keeps what happened, including the question
  await sleep(1500);
  report.checks.timelineKeptTheQuestion = await page.evaluate(() => window.__pokemonAgents.bridge.timeline.some((e) => e.kind === 'waiting' && /Which do you want/.test(e.text ?? '')));
  await press('h', 600); await shot('timeline');
  report.checks.timelineOpens = await page.evaluate(() => String(window.__pokemonAgents.ui.top?.title?.() ?? '').startsWith('TIMELINE'));
  await press('Escape', 200);

  // the sounds really synthesize to audio, rather than merely loading
  report.checks.soundsPlay = (await page.evaluate(async () => {
    const audio = window.__pokemonAgents.game.audio;
    for (let i = 0; i < 50 && !audio.data; i++) await new Promise((r) => setTimeout(r, 100));
    const events = ['waiting', 'done', 'working', 'resting', 'level', 'badge', 'egg', 'join', 'evolving', 'evolved', 'goal', 'sent', 'legend', 'wrong'];
    if (!audio.data || !events.every((e) => audio.data[e]?.channels.length)) return 'sounds.json is missing events';

    // render one offline and measure it: a silent buffer would mean the player is wrong
    const offline = new OfflineAudioContext(1, 44100 * 2, 44100);
    const player = Object.assign(Object.create(Object.getPrototypeOf(audio)), { ctx: offline });
    player.master = offline.createGain();
    player.master.connect(offline.destination);
    player.pulses = [0.125, 0.25, 0.5, 0.75].map((d) => player.pulseWave(d));
    player.noise = player.noiseBuffer();
    for (const channel of audio.data.level.channels) for (const note of channel.notes) player.note(channel.kind, note, 0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    let energy = 0;
    for (const s of samples) energy += s * s;
    const rms = Math.sqrt(energy / samples.length);
    const live = audio.play('done');
    live?.stop();
    return rms > 0.01 && !!live ? true : `rms ${rms.toFixed(4)}, live ${!!live}, ctx ${audio.ctx?.state}`;
  })) === true;

  await clear();
  await press('Enter'); for (let i = 0; i < 7; i++) await press('ArrowDown', 60);
  await press('z', 600); await shot('sound-test');
  report.checks.soundTestListsEvery = await page.evaluate(() => {
    const top = window.__pokemonAgents.ui.top;
    return String(top?.title?.() ?? '').startsWith('SOUND TEST') && top.list.filter((r) => r.onPick).length === 14;
  });
  await press('z', 300); await press('Escape', 200);
  await clear();

  // milestones wait for you: away they queue and the title counts them, then they play on return
  await page.evaluate(() => { document.hasFocus = () => false; });
  await dev('apply', { events: [{ kind: 'session', ts: Date.now(), project: '/e2e/away-project', name: 'away-project', cwd: '/e2e/away-project' }] });
  await sleep(2500);
  const whileAway = await page.evaluate(() => ({ top: window.__pokemonAgents.ui.top?.constructor.name ?? null, title: document.title }));
  await page.evaluate(() => { delete document.hasFocus; });
  await page.waitForFunction(() => window.__pokemonAgents.ui.top?.constructor.name === 'TextBox', null, { timeout: 5000 }).catch(() => {});
  await sleep(1500);
  const onReturn = await page.evaluate(() => ({ top: window.__pokemonAgents.ui.top?.constructor.name ?? null, title: document.title }));
  await shot('milestone-on-return');
  const stars = (title) => Number(/★(\d+)/.exec(title)?.[1] ?? 0);
  report.checks.milestonesWaitForYou = whileAway.top === null
    && stars(whileAway.title) >= 1
    && onReturn.top === 'TextBox'
    && stars(onReturn.title) < stars(whileAway.title);
  if (!report.checks.milestonesWaitForYou) report.checks.milestoneDetail = { whileAway, onReturn };
  await clear();

  // a legendary has a job, a report and a card
  const raikou = await page.evaluate(() => window.__pokemonAgents.bridge.legends?.[243]);
  report.checks.legendHasAJob = raikou?.job === 'TEST WATCHER' && raikou?.home === 'testbench';
  await page.evaluate(async () => {
    const { legendScreen } = await import('/js/panels.mjs');
    legendScreen(window.__pokemonAgents.game, 243);
  });
  await sleep(600); await shot('legend-report');
  await press('z', 600); await shot('legend-card');
  report.checks.legendCardOpens = await page.evaluate(() => window.__pokemonAgents.ui.top?.constructor.name === 'LegendCard');
  await clear();

  await press('Enter'); for (let i = 0; i < 8; i++) await press('ArrowDown', 60);
  await press('z', 600); await shot('help');
  report.checks.helpExplains = await page.evaluate(() => {
    const top = window.__pokemonAgents.ui.top;
    return top?.title === 'HELP - WHAT THIS CAN DO' && top.list.some((r) => r.text === 'GOALS') && top.list.length > 30;
  });
  await press('Escape', 200);
  report.checks.pageErrors = pageErrors;

  // replay: restarting on the same home and transcripts must not change the progression
  const before = fs.readFileSync(path.join(HOME, 'progress.json'), 'utf8');
  bridge.kill('SIGTERM'); await new Promise((r) => bridge.once('exit', r));
  bridge = startBridge(); await waitForBridge(); await sleep(1500);
  bridge.kill('SIGTERM'); await new Promise((r) => bridge.once('exit', r));
  const after = fs.readFileSync(path.join(HOME, 'progress.json'), 'utf8');
  // which Pokémon a project wears can legitimately change on a restart, because the species forced
  // above may share a family with a random roll; the counters and badges must not
  const withoutSpecies = (json) => {
    const state = JSON.parse(json);
    const mons = Object.fromEntries(Object.entries(state.progress.mons).map(([id, { species, rerolled, ...rest }]) => [id, rest]));
    return JSON.stringify({ mons, team: state.progress.team });
  };
  report.checks.replayChangesNothing = withoutSpecies(before) === withoutSpecies(after);

  if (ALSO_REAL) {
    const real = spawn(process.execPath, [
      path.join(ROOT, 'src/server.mjs'), '--port', String(PORT),
      '--home', fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-real-')),
    ], { stdio: 'ignore' });
    bridge = real;
    await waitForBridge();
    await page.goto(ORIGIN);
    await page.waitForFunction(() => window.__pokemonAgents?.bridge.progress && !window.__pokemonAgents.bridge.scanning && window.__pokemonAgents.bridge.sessions.length, null, { timeout: 120_000 });
    await sleep(2000);
    for (let i = 0; i < 40 && (await look()).top; i++) await press('z', 150);
    await sleep(3000);
    await shot('real-overworld');
    await press('m', 800); await shot('real-town-map'); await press('Escape');
    await press('Enter'); await press('z', 600); await shot('real-sessions'); await press('Escape');
    report.checks.realSessions = (await look()).sessions.length;
  }

  const c = report.checks;
  report.ok = c.waitingComesToYou && c.reportIsDoneNotNeedsYou && c.automatedShownWhileWorking
    && c.handoffEvolved && c.summaryShowsAskAndNeed && c.walkToArrives
    && c.goalRunsHeadlessAndAsks && c.answeredOnScreen
    && c.timelineKeptTheQuestion && c.timelineOpens
    && c.soundsPlay && c.soundTestListsEvery && c.milestonesWaitForYou
    && c.legendHasAJob && c.legendCardOpens && c.helpExplains
    && c.replayChangesNothing && !c.pageErrors.length;
} catch (e) {
  report.error = e.message;
} finally {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  bridge.kill('SIGTERM');
  console.log(JSON.stringify({ ok: report.ok, error: report.error, checks: report.checks, out: path.relative(ROOT, OUT) }, null, 1));
  process.exit(report.ok ? 0 : 1);
}

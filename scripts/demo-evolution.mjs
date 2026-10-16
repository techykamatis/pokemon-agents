#!/usr/bin/env node
// Records a short, evolution-focused demo from the same made-up world demo.mjs and demo-badges.mjs
// use. A project's Pokémon is staged one level short of its evolution, then real merge events are
// applied through the normal pipeline until the XP crosses the threshold — so the evolution you
// see is the game's own rule firing, not a scripted animation.
//
// Everything is synthetic — temp transcripts, an empty session registry, a fake `claude`, its own
// port — so it never touches or shows your real sessions. Needs ffmpeg.
//
//   node scripts/demo-evolution.mjs  ->  artifacts/demo/pokemon-agents-evolution.gif
//
// Like the other demos, the recording is a screen capture of Nintendo's artwork and is NOT
// committed; run it and you have your own copy on your own machine.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7994; // its own port, clear of demo.mjs (7992) and demo-badges.mjs (7993)
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'artifacts', 'demo');
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-evo-projects-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-evo-home-'));
const VIEW = { width: 700, height: 680 };

// Charmeleon -> Charizard at 36: a level evolution, which is the one the site leads with, and
// the most recognisable one in the series.
const HERO = { repo: 'pocket-shop', species: 5, level: 35, evolvesAt: 36 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// --- a made-up world (same shape as demo.mjs) ----------------------------------------------------
let past = Date.now() - 3 * 86_400_000;
const transcript = (repo, sessionId, cwd = `/demo/${repo}`) => {
  const dir = path.join(PROJECTS, `-demo-${repo}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  let calls = 0;
  const put = (line, ts) => fs.appendFileSync(file, `${JSON.stringify({
    cwd, sessionId, gitBranch: 'main', entrypoint: 'cli', timestamp: new Date(ts ?? (past += 400)).toISOString(), ...line,
  })}\n`);
  return {
    prompt: (text, ts) => put({ type: 'user', message: { content: text } }, ts),
    title: (title, ts) => put({ type: 'ai-title', aiTitle: title }, ts),
    tool: (name, input, { ok = true, ts } = {}) => {
      const id = `${sessionId}-${calls++}`;
      put({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } }, ts);
      put({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? 'ok' : 'Exit code 1' }] } }, ts);
    },
    reply: (text, ts) => put({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } }, ts),
  };
};

// enough history that the town is a going concern rather than a blank slate
const history = transcript('pocket-shop', 'past-0001');
history.prompt('add a cart');
history.title('Shopping cart');
for (let i = 0; i < 8; i++) history.tool('Bash', { command: 'npm test' });
history.tool('Bash', { command: 'git commit -m "cart"' });
history.reply('Cart is in.');

// four projects at work right now, so the town is alive behind the scene
const LIVE = [
  { repo: 'pocket-shop', title: 'Checkout flow', species: HERO.species, tools: [['Bash', { command: 'npm test' }], ['Edit', { file_path: 'src/checkout.ts' }], ['Bash', { command: 'git commit -m checkout' }]] },
  { repo: 'billing-api', title: 'Invoice rounding', species: 64, tools: [['Edit', { file_path: 'src/invoice.ts' }], ['Grep', { pattern: 'round(' }], ['Bash', { command: 'npm test' }]] },
  { repo: 'team-docs', title: 'Onboarding guide', species: 153, tools: [['Read', { file_path: 'docs/guide.md' }], ['WebFetch', { url: 'https://example.com/style' }], ['Edit', { file_path: 'docs/guide.md' }]] },
  { repo: 'mobile-app', title: 'Push notifications', species: 156, tools: [['Bash', { command: 'git pull' }], ['Read', { file_path: 'app/push.ts' }], ['Bash', { command: 'pod install' }]] },
].map((project) => ({ ...project, writer: transcript(project.repo, `live-${project.repo}`) }));

for (const project of LIVE) {
  project.writer.prompt(project.title.toLowerCase(), Date.now());
  project.writer.title(project.title, Date.now());
  project.writer.tool(...project.tools[0], { ts: Date.now() });
}

let beat = 0;
const keepWorking = setInterval(() => {
  beat++;
  for (const [i, project] of LIVE.entries()) {
    if ((beat + i) % 2 === 0) project.writer.tool(...project.tools[(beat + i) % project.tools.length], { ts: Date.now() });
  }
}, 1500);

// --- record it -----------------------------------------------------------------------------------
const bridge = spawn(process.execPath, [
  path.join(ROOT, 'src/server.mjs'),
  '--port', String(PORT), '--home', HOME, '--projects', PROJECTS,
  '--sessions', path.join(HOME, 'no-registry'), '--dev',
], {
  stdio: 'ignore',
  env: { ...process.env, CLAUDE_BIN: path.join(ROOT, 'scripts', 'demo-claude.mjs'), DEMO_PROJECTS: PROJECTS },
});

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(ORIGIN)).ok) break; } catch { /* still starting */ }
  await sleep(200);
}

const dev = async (route, body) => (await fetch(`${ORIGIN}/dev/${route}`, {
  method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify(body),
})).json();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: OUT, size: VIEW } });
const page = await context.newPage();
const openedAt = Date.now();

const press = async (key, ms = 200) => { await page.keyboard.press(key); await sleep(ms); };
const topName = () => page.evaluate(() => window.__pokemonAgents?.ui.top?.constructor.name ?? null);
const clear = async () => { for (let i = 0; i < 10 && (await topName()); i++) await press('Escape', 200); };

let video;
try {
  await page.addInitScript(() => {
    Date.prototype.getHours = function () { return 20; };        // dusk palette
    // Milestones only play while the page is being WATCHED (visible and focused), which is right
    // for a real player and false in headless Chromium -- the evolution would queue forever.
    document.hasFocus = () => true;
  });
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__pokemonAgents?.bridge.sessions.length >= 4 && !window.__pokemonAgents.bridge.scanning, null, { timeout: 30_000 });

  // stage the cast, and put the hero one level short of evolving
  // patch() raises xp to match the level but never lowers it (Math.max), so the hero must never
  // be staged high first -- and evolution is only checked when a level actually CHANGES, so a mon
  // sitting above its threshold just stays there.
  for (const project of LIVE) {
    if (project.repo === HERO.repo) continue;
    await dev('patch', { agentId: `/demo/${project.repo}`, fields: { species: project.species, level: 30 } });
  }
  await dev('patch', { agentId: `/demo/${HERO.repo}`, fields: { species: HERO.species, level: HERO.level } });
  await sleep(2000);
  await clear();
  await press('Shift', 300); // SELECT: hide the LIVE counter HUD for a clean capture

  // a milestone only plays while the page is actually being watched
  await page.bringToFront();
  await page.evaluate(() => window.focus());

  const takeStart = (Date.now() - openedAt) / 1000;
  await sleep(1800); // the town at work for a beat before anything happens

  // Real events through the normal pipeline. Tool calls, not merges: a merge is worth 100 XP but
  // also earns FOGBADGE and the SUN STONE, and those milestones queue AHEAD of the evolution, so
  // the capture opened on a badge TextBox instead. A tool call is 2 XP and earns nothing, so the
  // only thing that can play is the evolution.
  //   level 35 = 42875 XP (xpForLevel is n^3); level 36 = 46656; 2000 x 2 XP clears it with room
  //   to spare, and stops well short of level 37 (50653) so the evolution is the only milestone.
  // Sent in chunks: 2000 events in one POST trips the server's body limit.
  const fired = [];
  for (let sent = 0; sent < 2000; sent += 250) {
    const chunk = Array.from({ length: 250 }, () => ({ project: `/demo/${HERO.repo}`, kind: 'tool' }));
    const out = await dev('apply', { events: chunk }); // the route reads body.events
    if (!out?.ok) throw new Error(`apply failed: ${JSON.stringify(out).slice(0, 200)}`);
    fired.push(...(out.events ?? []));                 // and answers { ok, events }
    if (fired.some((e) => e.kind === 'evolve')) break;
  }
  const evolve = fired.find((e) => e.kind === 'evolve');
  if (!evolve) throw new Error(`no evolve event fired; saw ${fired.map((e) => e.kind).join(',') || 'nothing'}`);
  console.log(`evolved ${evolve.from} -> ${evolve.to}`);
  if (fired.some((e) => e.kind !== 'evolve' && e.kind !== 'level')) {
    console.warn(`note: other milestones queued too: ${fired.map((e) => e.kind).join(', ')}`);
  }

  // EvolutionScene: flash from frame 61, fanfare at 261, dismissible after 300 (~5s at 60fps)
  // Levelling up is itself a milestone, so "grew to L16" queues AHEAD of the evolution and each
  // milestone waits for A. Read it, then press on -- which is what a player does, and it sets the
  // evolution up rather than hiding it.
  for (let i = 0; i < 8 && (await topName()) !== 'EvolutionScene'; i++) {
    await sleep(1500);   // long enough to read the box
    await press('z', 500);
  }
  const top = await topName();
  if (top !== 'EvolutionScene') throw new Error(`EvolutionScene never opened (top was ${top})`);
  await sleep(7000);            // the whole flash-and-fanfare, then "Congratulations!"
  await press('z', 900);        // A: dismiss the scene
  await sleep(1600);            // back to the town, now with an evolved Pokémon in it

  const takeEnd = (Date.now() - openedAt) / 1000 - 0.3;

  const box = await page.locator('.screen').boundingBox();
  video = page.video();
  await context.close();
  const webm = await video.path();
  const gif = path.join(OUT, 'pokemon-agents-evolution.gif');

  const crop = `crop=${Math.round(box.width)}:${Math.round(box.height)}:${Math.round(box.x)}:${Math.round(box.y)}`;
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', takeStart.toFixed(2), '-to', takeEnd.toFixed(2), '-i', webm,
    '-vf', `${crop},fps=10,scale=640:-1:flags=neighbor,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    gif,
  ]);
  fs.rmSync(webm, { force: true });

  const megabytes = (fs.statSync(gif).size / 1e6).toFixed(1);
  console.log(`${path.relative(ROOT, gif)}  ${megabytes} MB, ${(takeEnd - takeStart).toFixed(0)}s`);
} finally {
  clearInterval(keepWorking);
  await browser.close();
  bridge.kill('SIGTERM');
}

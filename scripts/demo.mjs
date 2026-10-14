#!/usr/bin/env node
// Records a demo of the game from a made-up world: five invented projects at work, a goal that is
// typed in, asks a question and gets answered on screen, an evolution, and the timeline of it all.
//
// Everything in it is synthetic — temp transcripts, an empty session registry, a fake `claude`, its
// own port — so it never touches or shows your real sessions. Needs ffmpeg.
//
//   npm run demo  ->  artifacts/demo/pokemon-agents-demo.gif
//
// The recording is not committed: it is a screen capture of Nintendo's artwork, which this
// repository does not redistribute. Run this and you have your own copy, on your own machine.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7992;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'artifacts', 'demo');
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-demo-projects-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-demo-home-'));
const VIEW = { width: 700, height: 680 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// --- a made-up world -----------------------------------------------------------------------------
let past = Date.now() - 3 * 86_400_000; // the history happened a few days ago

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

// enough history that the early badges are earned, so Raikou and Suicune are out on patrol
const history = transcript('pocket-shop', 'past-0001');
history.prompt('add a cart');
history.title('Shopping cart');
history.tool('Bash', { command: 'npm test' }, { ok: false });
history.tool('Edit', { file_path: '/demo/pocket-shop/src/cart.ts' });
for (let i = 0; i < 10; i++) history.tool('Bash', { command: 'npm test' });
history.tool('Bash', { command: 'git commit -m "cart"' });
history.tool('Bash', { command: 'gh pr merge 12 --squash' });
history.reply('Merged the cart.');

// The goal needs a real folder inside home: a dummy app under artifacts/, which is gitignored.
// It is made a repository of its own, because a folder inside this one would otherwise be read as
// part of this project and would never appear in the picker under its own name.
const WEATHER_APP = path.join(OUT, 'weather-app');
fs.mkdirSync(WEATHER_APP, { recursive: true });
if (!fs.existsSync(path.join(WEATHER_APP, '.git'))) execFileSync('git', ['init', '-q', WEATHER_APP]);
const weather = transcript('weather-app', 'past-0002', WEATHER_APP);
weather.prompt('scaffold it');
weather.reply('Scaffolded the app.');

// four projects at work right now, each cycling through tools so it moves between buildings
const LIVE = [
  { repo: 'pocket-shop', title: 'Checkout flow', species: 181, tools: [['Bash', { command: 'npm test' }], ['Edit', { file_path: 'src/checkout.ts' }], ['Bash', { command: 'git commit -m checkout' }]] },
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

const press = async (key, ms = 180) => { await page.keyboard.press(key); await sleep(ms); };
const topOfStack = () => page.evaluate(() => window.__pokemonAgents?.ui.top?.constructor.name ?? null);
const clear = async () => { for (let i = 0; i < 10 && (await topOfStack()); i++) await press('Escape', 200); };

let video;
try {
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__pokemonAgents?.bridge.sessions.length >= 4 && !window.__pokemonAgents.bridge.scanning, null, { timeout: 30_000 });

  // high levels, so a few tool calls cannot level anyone up mid-take, and species the earned
  // stones do not evolve — the badges above put four stones in the bag
  for (const project of LIVE) await dev('patch', { agentId: `/demo/${project.repo}`, fields: { species: project.species, level: 30 } });
  await dev('patch', { agentId: WEATHER_APP, fields: { species: 187, level: 30 } });
  await sleep(2500);
  await clear();

  const takeStart = (Date.now() - openedAt) / 1000; // the loading frames are trimmed off the front

  await sleep(3500); // the town at work
  await press('m', 2800); await press('Escape', 600); // the Pokégear map

  // START > GOALS > NEW GOAL > weather-app > type it
  await press('Enter', 400);
  for (let i = 0; i < 6; i++) await press('ArrowDown', 120);
  await press('z', 700);
  await press('z', 600);
  const picker = await page.evaluate(() => window.__pokemonAgents.ui.top?.constructor.name);
  if (picker !== 'PCScreen') throw new Error(`expected the folder picker, found ${picker}`);
  const row = await page.evaluate(() => window.__pokemonAgents.ui.top.list.filter((r) => r.onPick).findIndex((r) => r.text.includes('weather-app')));
  for (let i = 0; i < row; i++) await press('ArrowDown', 90);
  await press('z', 500);
  await page.keyboard.type('Add a dark mode toggle', { delay: 55 });
  await press('Enter', 700);
  await sleep(1400);
  await clear();

  // it works, then asks: the question comes up on its own, and you answer it here
  await page.waitForFunction(() => String(window.__pokemonAgents.ui.top?.title ?? '').includes('ASKS'), null, { timeout: 30_000 });
  await sleep(3000);
  await press('z', 900);
  await press('z', 1600);
  await clear();
  await sleep(2500);

  // billing-api hands work to a subagent: a trade, and its Kadabra evolves
  const api = LIVE.find((p) => p.repo === 'billing-api').writer;
  api.tool('Agent', { subagent_type: 'Explore', description: 'find the callers' }, { ts: Date.now() });
  await page.waitForFunction(() => window.__pokemonAgents.ui.top?.constructor.name === 'EvolutionScene', null, { timeout: 15_000 });
  await sleep(6200);
  await press('z', 1200);
  await clear();

  // the timeline: everything that just happened, newest first
  await press('h', 3800);
  await press('Escape', 1200);
  const takeEnd = (Date.now() - openedAt) / 1000 - 0.4; // the last frames of the recording go black

  const box = await page.locator('.screen').boundingBox();
  video = page.video();
  await context.close(); // the video is only written out once the context closes
  const webm = await video.path();
  const gif = path.join(OUT, 'pokemon-agents-demo.gif');

  // Crop to the screen itself. 640px is four times the Game Boy and twice the PC overlay, so every
  // pixel stays square; 10fps and a small palette keep it down to a size worth looking at.
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

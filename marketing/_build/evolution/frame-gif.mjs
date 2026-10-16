#!/usr/bin/env node
// Put the evolution recording inside the SAME device the launch cards use, so the motion
// asset and the static cards are the same hardware. Mirrors the launch reel pipeline
// (card-reel-bg.html + reel-screen-rect.json + screen-mask.png), with the measuring and
// masking done here rather than by hand.
//
//   node frame-gif.mjs   ->  ../../evolution/motion/pokemon-agents-evolution.gif
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOTION = path.join(HERE, '..', '..', 'evolution', 'motion');
const RAW = path.join(MOTION, 'pokemon-agents-evolution-raw.gif');
const OUT = path.join(MOTION, 'pokemon-agents-evolution.gif');
const BG = path.join(HERE, 'evolution-reel-bg-1080x1920.png');
const MASK = path.join(HERE, 'evolution-screen-mask.png');
const RECT = path.join(HERE, 'evolution-screen-rect.json');
const SCREEN_RADIUS = 24; // the screen_radius passed to device() on the vertical card

if (!fs.existsSync(RAW)) throw new Error(`no raw recording at ${RAW} — run scripts/demo-evolution.mjs first`);

const browser = await chromium.launch();

// 1. the background, and where its screen actually sits
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(HERE, 'card-evolution-reel-bg.html'));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.locator('.card').screenshot({ path: BG });
const card = await page.locator('.card').boundingBox();
const screen = await page.locator('#reel-screen').boundingBox();
const rect = {
  x: Math.round(screen.x - card.x), y: Math.round(screen.y - card.y),
  w: Math.round(screen.width), h: Math.round(screen.height),
};
fs.writeFileSync(RECT, JSON.stringify(rect));
await page.close();

// 2. a rounded-rect alpha mask at exactly that size, so the gif gets the screen's corners
const mp = await browser.newPage({ viewport: { width: rect.w, height: rect.h } });
await mp.setContent(`<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:transparent}
  .m{width:${rect.w}px;height:${rect.h}px;background:#fff;border-radius:${SCREEN_RADIUS}px}
</style></head><body><div class="m"></div></body></html>`);
await mp.screenshot({ path: MASK, omitBackground: true });
await mp.close();
await browser.close();

// 3. composite: scale the recording into the screen, clip it to the mask, lay it on the card
const filter = [
  `[1:v]scale=${rect.w}:${rect.h}:flags=neighbor,setsar=1[g]`,
  `[2:v]alphaextract[am]`,
  `[g][am]alphamerge[gm]`,
  `[0:v][gm]overlay=${rect.x}:${rect.y}:shortest=1[v]`,
  `[v]scale=720:-2:flags=lanczos,fps=10,split[a][b]`,
  `[a]palettegen=max_colors=64:stats_mode=diff[p]`,
  `[b][p]paletteuse=dither=none:diff_mode=rectangle`,
].join(';');

execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-loop', '1', '-i', BG,
  '-i', RAW,
  '-i', MASK,
  '-filter_complex', filter,
  '-loop', '0',
  OUT,
], { stdio: 'inherit' });

console.log(`screen rect ${JSON.stringify(rect)}`);
console.log(`${path.relative(path.join(HERE, '..', '..', '..'), OUT)}  ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);

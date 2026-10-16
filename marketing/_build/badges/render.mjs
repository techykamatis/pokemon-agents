#!/usr/bin/env node
// Render each badge card HTML to a PNG at its exact canvas size.
// Waits for the in-page badge colouriser to finish before shooting.
//   node render.mjs
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'badges', 'posts');
const OUT_STORY = path.join(HERE, '..', '..', 'badges', 'stories');

const jobs = [
  ['card-badges-twitter.html',          1600, 900,  OUT,       'badges-twitter-x-1600x900.png'],
  ['card-badges-instagram-square.html', 1080, 1080, OUT,       'badges-instagram-1080x1080.png'],
  ['card-badges-portrait.html',         1080, 1350, OUT,       'badges-instagram-threads-portrait-1080x1350.png'],
  ['card-badges-story.html',            1080, 1920, OUT_STORY, 'badges-instagram-threads-story-1080x1920.png'],
];

const browser = await chromium.launch();
for (const [html, w, h, outDir, out] of jobs) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(html, 'pageerror:', e.message));
  await page.goto('file://' + path.join(HERE, html));
  await page.evaluate(() => document.fonts.ready);
  // the badge sprites are drawn by an onload handler; wait for its flag
  await page.waitForFunction(() => document.documentElement.dataset.badgesReady === '1', { timeout: 5000 })
    .catch(() => console.error(html, 'badges did not signal ready'));
  await page.waitForTimeout(500); // let web fonts + canvases paint
  await page.locator('.card').screenshot({ path: path.join(outDir, out) });
  await page.close();
  console.log('wrote', path.join(outDir, out));
}
await browser.close();

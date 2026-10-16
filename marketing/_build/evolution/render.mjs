#!/usr/bin/env node
// Render each evolution card HTML to a PNG at its exact canvas size.
// The hero frame is an inlined data: URI, so there is nothing async to wait for
// beyond the web fonts.
//   node render.mjs
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'evolution', 'posts');
const OUT_STORY = path.join(HERE, '..', '..', 'evolution', 'stories');

const jobs = [
  ['card-evolution-twitter.html',          1600, 900,  OUT,       'evolution-twitter-x-1600x900.png'],
  ['card-evolution-instagram-square.html', 1080, 1080, OUT,       'evolution-instagram-1080x1080.png'],
  ['card-evolution-portrait.html',         1080, 1350, OUT,       'evolution-instagram-threads-portrait-1080x1350.png'],
  ['card-evolution-story.html',            1080, 1920, OUT_STORY, 'evolution-instagram-threads-story-1080x1920.png'],
];

const browser = await chromium.launch();
for (const [html, w, h, outDir, out] of jobs) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(html, 'pageerror:', e.message));
  await page.goto('file://' + path.join(HERE, html));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500); // let web fonts paint
  await page.locator('.card').screenshot({ path: path.join(outDir, out) });
  await page.close();
  console.log('wrote', path.join(outDir, out));
}
await browser.close();

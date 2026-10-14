#!/usr/bin/env node
// A dev helper: open the running game headless, press some keys, save a screenshot.
//   node scripts/shot.mjs out.png [key ...]
// Keys are Playwright key names, or wait:<ms>, or type:<text>.
import { chromium } from 'playwright';

const [out = 'artifacts/shot.png', ...keys] = process.argv.slice(2);
const port = process.env.PKMN_PORT ?? 7880;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
page.on('pageerror', (e) => console.error('pageerror:', e.message));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForTimeout(2500);

for (const key of keys) {
  if (key.startsWith('wait:')) await page.waitForTimeout(Number(key.slice(5)));
  else if (key.startsWith('type:')) await page.keyboard.type(key.slice(5), { delay: 10 });
  else { await page.keyboard.press(key); await page.waitForTimeout(250); }
}

await page.locator('.screen').screenshot({ path: out });
await browser.close();
console.log(out);

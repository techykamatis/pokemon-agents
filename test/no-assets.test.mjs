// Guard: not one byte of Nintendo, Creatures or GAME FREAK material may ever be committed. Every
// sprite, tileset, map, palette, font and sound is fetched by `npm run setup` into the gitignored
// .cache/ and stays on the machine that fetched it. This repository holds original code and text.
//
// Checking extensions alone is not enough — a renamed .gif is still a .gif — so there are three
// checks: the names, the bytes, and the .gitignore that keeps the fetched tree out of git at all.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

/** anything that can carry art, a map, a font, a sound, a ROM, or disassembly source */
const ASSET_NAME = new RegExp(
  '\\.(png|gif|jpe?g|webp|avif|bmp|tiff?|ico|icns|svg|psd|xcf' // images
  + '|wav|aiff?|mp3|m4a|aac|ogg|oga|opus|flac|mid|midi|mod|spc|vgm|nsf' // audio
  + '|ttf|otf|woff2?|eot' // fonts
  + '|asm|inc|blk|2bpp|1bpp|pal|tilemap|bin' // pokecrystal disassembly and its binaries
  + '|gb|gbc|sav|nes|sfc|smc|z64|iso|rom'  // anything ROM-shaped
  + ')$', 'i',
);
/** directories that only ever hold fetched or generated material, whatever the files are named */
const ASSET_DIR = /^(\.cache|artifacts)\//i;
/** an upstream checkout that slipped in under some other name */
const UPSTREAM = /pokecrystal|pokeapi|pokered|pokeemerald|pokegold/i;

/** every file git has or would take: tracked plus untracked-and-not-ignored */
const candidates = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

/** a NUL byte in the head of a file means it is not source or text */
function isBinary(file) {
  let fd;
  try { fd = fs.openSync(path.join(ROOT, file), 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

describe('no Pokémon assets in git', () => {
  it('no file is named like art, audio, a font, a map, disassembly or a ROM', () => {
    const bad = candidates().filter((f) => ASSET_NAME.test(f) || ASSET_DIR.test(f) || UPSTREAM.test(f));
    assert.deepEqual(bad, [], 'these must be fetched into .cache/ instead of committed');
  });

  it('no file is binary, whatever it is called', () => {
    // the rename dodge: demo.gif committed as demo.dat passes the name check and fails here
    const bad = candidates().filter(isBinary);
    assert.deepEqual(bad, []);
  });

  it('.gitignore keeps the fetched and generated trees out of git', () => {
    for (const p of ['.cache/assets/pokedex.json', '.cache/pokecrystal/gfx/font/font.png', 'artifacts/demo/demo.gif', 'node_modules/ws/index.js']) {
      const { status } = spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT });
      assert.equal(status, 0, `${p} is not ignored: a fetched asset could be committed`);
    }
  });
});

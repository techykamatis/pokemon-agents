#!/usr/bin/env node
// `npm run setup`. Fetches every Pokémon asset onto this machine, into the gitignored .cache/, and
// builds the JSON the app reads. Nothing it downloads is ever committed — see test/no-assets.test.mjs.
// Safe to re-run: a finished step is skipped, and both checkouts are pinned to exact commits.
//
//   pret/pokecrystal   (sparse) the Johto tileset, overworld sprites, font, frames, map, palettes, audio
//   PokeAPI/sprites    (sparse) Crystal front sprites and their shinies, plus Gen 7 menu icons
//   pokeapi.co                  species and evolution chains for #1-251, one cached file each
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPokedex, MAX_ID } from '../src/build/pokedex.mjs';
import { buildSounds } from '../src/build/audio.mjs';
import { buildWorld } from '../src/build/world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const ASSETS = path.join(CACHE, 'assets');

const CHECKOUTS = [
  {
    dir: 'pokecrystal',
    url: 'https://github.com/pret/pokecrystal',
    commit: '3bc8daa4173e96a7f4011dad3922eb6fa5dad5c6',
    paths: [
      'gfx/tilesets/*', 'gfx/sprites/*', 'gfx/font/*', 'gfx/frames/*', 'gfx/overworld/*',
      'gfx/emotes/*', 'gfx/trainer_card/*',
      'data/tilesets/*', 'data/maps/*', 'maps/*', 'constants/*', 'engine/tilesets/*',
      'audio/*', '/macros/scripts/audio.asm',
    ],
  },
  {
    dir: 'pokeapi-sprites',
    url: 'https://github.com/PokeAPI/sprites',
    commit: '0dc105d5b12416932f29b594078282ab4be045f5',
    paths: ['sprites/pokemon/versions/generation-ii/crystal/*', 'sprites/pokemon/versions/generation-vii/icons/*'],
  },
];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

/** clone (blobless and sparse) or update one pinned checkout -> its path */
function checkout({ dir, url, commit, paths }) {
  const into = path.join(CACHE, dir);
  if (!fs.existsSync(path.join(into, '.git'))) {
    console.log(`clone ${url} (sparse, blobless)`);
    git(CACHE, 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', url, dir);
  }
  git(into, 'sparse-checkout', 'set', '--no-cone', ...paths);

  const head = (() => { try { return git(into, 'rev-parse', 'HEAD'); } catch { return ''; } })();
  if (head !== commit) git(into, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit);
  git(into, 'checkout', '-q', commit);
  return into;
}

/** fetch one JSON document, or read the copy already on disk. Retries a few times, then gives up. */
async function fetchJson(url, file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'pokemon-agents (personal use, cached)' } });
    if (res.ok) {
      const json = await res.json();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
      return json;
    }
    if (attempt >= 4) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((retry) => setTimeout(retry, 1000 * attempt));
  }
}

/** four at a time, every response cached for good: PokeAPI's fair-use policy asks for exactly this */
async function inParallel(items, width, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  }));
  return out;
}

async function fetchPokeApi() {
  const dir = path.join(CACHE, 'pokeapi');
  const ids = Array.from({ length: MAX_ID }, (_, i) => i + 1);
  const species = await inParallel(ids, 4, (id) => fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${id}/`, path.join(dir, 'species', `${id}.json`)));
  const chainUrls = [...new Set(species.map((s) => s.evolution_chain.url))];
  const chains = await inParallel(chainUrls, 4, (url) => fetchJson(url, path.join(dir, 'chain', `${url.split('/').filter(Boolean).pop()}.json`)));
  return { species, chains };
}

/** copy one file out of a checkout into the served assets tree */
function copyAcross(from, to) {
  // upstream content is untrusted: never follow a symlink out of the checkout into what we serve
  if (!fs.lstatSync(from).isFile()) throw new Error(`not a regular file: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const crystal = checkout(CHECKOUTS[0]);
  const sprites = checkout(CHECKOUTS[1]);

  const { species, chains } = await fetchPokeApi();
  const pokedex = buildPokedex(species, chains);
  fs.writeFileSync(path.join(ASSETS, 'pokedex.json'), JSON.stringify(pokedex));

  const world = buildWorld(crystal);
  fs.writeFileSync(path.join(ASSETS, 'world.json'), JSON.stringify(world));
  fs.writeFileSync(path.join(ASSETS, 'sounds.json'), JSON.stringify(buildSounds(crystal)));

  for (const png of world.pngs) copyAcross(path.join(crystal, png), path.join(ASSETS, png));

  const versions = path.join(sprites, 'sprites/pokemon/versions');
  for (let id = 1; id <= MAX_ID; id++) {
    copyAcross(path.join(versions, 'generation-ii/crystal', `${id}.png`), path.join(ASSETS, 'mon/front', `${id}.png`));
    copyAcross(path.join(versions, 'generation-ii/crystal/shiny', `${id}.png`), path.join(ASSETS, 'mon/shiny', `${id}.png`));
    copyAcross(path.join(versions, 'generation-vii/icons', `${id}.png`), path.join(ASSETS, 'mon/icon', `${id}.png`));
  }

  console.log(`assets ready in ${path.relative(ROOT, ASSETS)}: ${pokedex.species.length} species, ${pokedex.evolutions.length} evolutions, ${world.map.name} ${world.map.width}x${world.map.height}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

// Reads the pret/pokecrystal disassembly and writes the one world.json the client draws from:
// Violet City's block map, the Johto tileset's metatiles, collision and palette assignment, the
// morn/day/nite palettes, the roof colours, the text charmap, and the warps used as stations.
// Run once by `npm run setup`, against a checkout pinned to an exact commit in .cache/.
import fs from 'node:fs';
import path from 'node:path';

/** the one map this game plays on, and the tileset and roof colours it is drawn with */
const CITY = { name: 'VioletCity', constant: 'VIOLET_CITY', tileset: 'johto', roofGroup: 10, roof: 'violet' };

/** collision kinds you can stand on. Ledges (HOP_*) are one-way, and treating them as walls keeps
 *  pathfinding an honest BFS instead of a special case nobody would ever see. */
const WALKABLE = new Set(['FLOOR', 'TALL_GRASS', 'DOOR', 'LADDER', 'UP_WALL', 'WARP_CARPET_DOWN', 'WARP_CARPET_LEFT', 'WARP_CARPET_RIGHT']);

/** the eight background palettes, in the order the tileset assigns them */
const BG_PALETTES = ['gray', 'red', 'green', 'water', 'yellow', 'brown', 'roof', 'text'];

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

/** the Game Boy Color stores five bits per channel; the browser wants eight */
const rgb5to8 = (r, g, b) => [r, g, b].map((c) => Math.round((Number(c) * 255) / 31));

/**
 * A .pal file: sections headed `; morn`, `; day`, `; nite` (and sometimes `; dark`), each a run of
 * RGB lines. -> { morn: [[c0, c1, c2, c3] x 8], day: ..., nite: ... }
 */
export function parsePalettes(text) {
  const out = {};
  let section = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^;\s*(morn|day|nite|dark)\b/);
    if (heading) {
      section = [];
      out[heading[1]] = section;
      continue;
    }
    const rgb = line.match(/RGB\s+(.*?)(;|$)/);
    if (!rgb || !section) continue;
    const numbers = rgb[1].split(/[,\s]+/).filter(Boolean);
    const colors = [];
    for (let i = 0; i + 2 < numbers.length; i += 3) colors.push(rgb5to8(numbers[i], numbers[i + 1], numbers[i + 2]));
    section.push(colors);
  }
  return out;
}

/**
 * A tileset's palette map: each `tilepal` line names the palette for eight consecutive tiles, and a
 * `rept N / db $ff` block skips 2N tiles (that is the font area at $60-$7f, which has no palette).
 * -> { tileId: paletteIndex }
 */
export function parsePaletteMap(text) {
  const map = {};
  let tile = 0;
  for (const line of text.split('\n')) {
    const assignment = line.match(/^\s*tilepal\s+\d+,\s*(.*)$/);
    if (assignment) {
      for (const name of assignment[1].split(',').map((s) => s.trim().toLowerCase())) {
        map[tile] = BG_PALETTES.indexOf(name);
        tile += 1;
      }
      continue;
    }
    const skip = line.match(/^\s*rept\s+(\d+)/);
    if (skip) tile += 2 * Number(skip[1]);
  }
  return map;
}

/** `tilecoll` lines: four corners per block, each a collision kind -> [[bool x 4] per block] */
export function parseCollision(text) {
  return [...text.matchAll(/tilecoll\s+([A-Z_0-9]+),\s*([A-Z_0-9]+),\s*([A-Z_0-9]+),\s*([A-Z_0-9]+)/g)]
    .map((m) => m.slice(1, 5).map((kind) => WALKABLE.has(kind)));
}

/**
 * The charmap, for drawing text with the real font. Only the font.png section counts: later
 * sections remap the very same byte values for kana and Unown, and would overwrite the letters.
 * -> { character: glyphIndex }
 */
export function parseCharmap(text) {
  const out = {};
  const from = text.indexOf('(from gfx/font/font.png)');
  const section = text.slice(from, text.indexOf('; Japanese control characters', from));
  for (const m of section.matchAll(/charmap\s+"(.)",\s*\$([0-9a-f]{2})/gi)) {
    const code = parseInt(m[2], 16);
    if (code >= 0x80 && !(m[1] in out)) out[m[1]] = code - 0x80;
  }
  out[' '] = 0x7f - 0x80; // the blank tile: drawn as nothing at all
  return out;
}

/** one group's roof colours, day and nite, from the shared roofs.pal */
export function parseRoof(text, group) {
  // headings read `; group 10 (Violet)`, but match on the number alone: the name is a comment, and
  // matching "10 " would break on a group that happens not to have been given one
  const section = text.split(/;\s*group\s+/).find((s) => Number.parseInt(s, 10) === group);
  if (!section) throw new Error(`roofs.pal has no group ${group}`);
  const rows = [...section.matchAll(/RGB\s+([\d,\s]+?)\s*;/g)].map((m) => m[1].split(/[,\s]+/).filter(Boolean));
  if (rows.length < 2) throw new Error(`roofs.pal group ${group} has no day and nite pair`);
  const pair = (n) => [rgb5to8(n[0], n[1], n[2]), rgb5to8(n[3], n[4], n[5])];
  return { day: pair(rows[0]), nite: pair(rows[1]) };
}

/**
 * A map script's events. Warps are the doors, which is how each station finds its building; signs
 * are the ones you can read, which the game answers with live numbers.
 */
export function parseEvents(text) {
  const warps = [...text.matchAll(/warp_event\s+(\d+),\s*(\d+),\s*([A-Z_0-9]+)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), to: m[3] }));
  const signs = [...text.matchAll(/bg_event\s+(\d+),\s*(\d+),\s*BGEVENT_READ,\s*(\w+)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), id: m[3] }));
  return { warps, signs };
}

/** @param {string} root a pokecrystal checkout -> the world.json the client fetches */
export function buildWorld(root) {
  const size = read(root, 'constants/map_constants.asm').match(new RegExp(`map_const ${CITY.constant},\\s*(\\d+),\\s*(\\d+)`));
  const attributes = read(root, 'data/maps/attributes.asm').match(new RegExp(`map_attributes ${CITY.name}, ${CITY.constant}, \\$([0-9a-f]+)`, 'i'));
  const width = Number(size[1]);
  const height = Number(size[2]);

  const blocks = [...fs.readFileSync(path.join(root, `maps/${CITY.name}.blk`))];
  if (blocks.length !== width * height) throw new Error(`${CITY.name}.blk is ${blocks.length} blocks, not ${width}x${height}`);

  const metatileBytes = fs.readFileSync(path.join(root, `data/tilesets/${CITY.tileset}_metatiles.bin`));
  const metatiles = [];
  for (let i = 0; i < metatileBytes.length; i += 16) metatiles.push([...metatileBytes.subarray(i, i + 16)]);

  const sprites = ['chris', 'kris', 'poke_ball', 'raikou', 'entei', 'suicune'];
  const emotes = ['shock', 'question', 'happy', 'heart', 'sleep', 'bolt', 'sad'];
  const tilesetPng = `gfx/tilesets/${CITY.tileset}.png`;
  const roofPng = `gfx/tilesets/roofs/${CITY.roof}.png`;
  const fontPng = 'gfx/font/font.png';
  const framePng = 'gfx/frames/1.png';
  const badgesPng = 'gfx/trainer_card/badges.png';

  return {
    source: 'pret/pokecrystal',
    map: {
      name: CITY.name,
      width,
      height,
      border: parseInt(attributes[1], 16),
      blocks,
      ...parseEvents(read(root, `maps/${CITY.name}.asm`)),
    },
    tileset: {
      png: tilesetPng,
      roofPng,
      roofTile: 0x0a,
      metatiles,
      collision: parseCollision(read(root, `data/tilesets/${CITY.tileset}_collision.asm`)),
      paletteMap: parsePaletteMap(read(root, `gfx/tilesets/${CITY.tileset}_palette_map.asm`)),
    },
    palettes: {
      bg: parsePalettes(read(root, 'gfx/tilesets/bg_tiles.pal')),
      npc: parsePalettes(read(root, 'gfx/overworld/npc_sprites.pal')),
      roof: parseRoof(read(root, 'gfx/tilesets/roofs.pal'), CITY.roofGroup),
    },
    charmap: parseCharmap(read(root, 'constants/charmap.asm')),
    font: fontPng,
    frame: framePng,
    badges: badgesPng,
    sprites: Object.fromEntries(sprites.map((s) => [s, `gfx/sprites/${s}.png`])),
    emotes: Object.fromEntries(emotes.map((e) => [e, `gfx/emotes/${e}.png`])),
    // every image the client will ask for, so setup knows exactly what to copy across
    pngs: [
      tilesetPng, roofPng, fontPng, framePng, badgesPng,
      ...sprites.map((s) => `gfx/sprites/${s}.png`),
      ...emotes.map((e) => `gfx/emotes/${e}.png`),
    ],
  };
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { buildWorld, parseCharmap, parseCollision, parseEvents, parsePaletteMap, parsePalettes, parseRoof } from '../src/build/world.mjs';

describe('palettes', () => {
  it('splits the times of day and scales five-bit colour up to eight', () => {
    const pals = parsePalettes([
      '; morn',
      '\tRGB 28, 31, 16, 00, 00, 00',
      '\tRGB 31, 31, 31, 21, 21, 21',
      '; day',
      '\tRGB 27, 31, 27, 31, 19, 24',
      '; nite',
      '\tRGB 15, 14, 24, 00, 00, 00',
    ].join('\n'));

    assert.deepEqual(Object.keys(pals), ['morn', 'day', 'nite']);
    assert.deepEqual(pals.morn[0], [[230, 255, 132], [0, 0, 0]], '31 becomes 255, 0 stays 0');
    assert.deepEqual(pals.morn[1][0], [255, 255, 255]);
    assert.equal(pals.day.length, 1);
    assert.deepEqual(pals.nite[0][1], [0, 0, 0]);
  });

  it('ignores RGB lines before any heading, and comments after one', () => {
    const pals = parsePalettes(['\tRGB 31, 31, 31', '; day', '\tRGB 31, 00, 00 ; the red one'].join('\n'));
    assert.deepEqual(Object.keys(pals), ['day']);
    assert.deepEqual(pals.day[0], [[255, 0, 0]]);
  });

  it('reads one roof group, day and nite, out of the shared file', () => {
    const file = [
      '; group 1 (Olivine)',
      '\tRGB 20, 10, 10, 10, 05, 05 ; morn/day',
      '\tRGB 10, 05, 05, 05, 02, 02 ; nite',
      '',
      '; group 10 (Violet)',
      '\tRGB 31, 19, 24, 21, 09, 14 ; morn/day',
      '\tRGB 15, 10, 20, 10, 05, 10 ; nite',
    ].join('\n');

    const roofs = parseRoof(file, 10);
    assert.deepEqual(roofs.day, [[255, 156, 197], [173, 74, 115]]);
    assert.deepEqual(roofs.nite[0], [123, 82, 165]);
    assert.notDeepEqual(parseRoof(file, 1).day, roofs.day, 'group 1 is not group 10');
  });

  it('matches a group by its number, not by the name after it', () => {
    const unnamed = ['; group 10', '\tRGB 31, 19, 24, 21, 09, 14 ; morn/day', '\tRGB 15, 10, 20, 10, 05, 10 ; nite'].join('\n');
    assert.deepEqual(parseRoof(unnamed, 10).day[0], [255, 156, 197]);
    assert.throws(() => parseRoof(unnamed, 3), /group 3/);
  });
});

describe('the palette map', () => {
  it('assigns eight tiles per tilepal line, by palette name', () => {
    const map = parsePaletteMap([
      '\ttilepal 0, GRAY, GRAY, GRAY, GRAY, GRAY, GRAY, GRAY, GRAY',
      '\ttilepal 0, ROOF, ROOF, TEXT, WATER, RED, GREEN, YELLOW, BROWN',
    ].join('\n'));

    assert.equal(map[0], 0, 'gray is palette 0');
    assert.equal(map[7], 0);
    assert.equal(map[8], 6, 'roof is palette 6');
    assert.equal(map[10], 7, 'text is palette 7');
    assert.equal(map[11], 3, 'water is palette 3');
    assert.equal(map[15], 5, 'brown is palette 5');
  });

  it('skips the font area, so tiles after it are not shifted', () => {
    const map = parsePaletteMap([
      '\ttilepal 0, GRAY, GRAY, GRAY, GRAY, GRAY, GRAY, GRAY, GRAY',
      '\trept 16',
      '\tdb $ff',
      '\tendr',
      '\ttilepal 0, RED, RED, RED, RED, RED, RED, RED, RED',
    ].join('\n'));

    assert.equal(map[8], undefined, 'the font area has no palette of its own');
    assert.equal(map[40], 1, '8 tiles, then 2 x 16 skipped, puts red at 40');
  });
});

describe('collision', () => {
  it('turns each block into four walkable corners', () => {
    const grid = parseCollision([
      '\ttilecoll FLOOR, FLOOR, FLOOR, FLOOR ; 00',
      '\ttilecoll WALL,  WALL,  WALL,  WALL  ; 01',
      '\ttilecoll WALL,  WALL,  FLOOR, FLOOR ; 02',
      '\ttilecoll TALL_GRASS, DOOR, LADDER, UP_WALL ; 03',
    ].join('\n'));

    assert.deepEqual(grid[0], [true, true, true, true]);
    assert.deepEqual(grid[1], [false, false, false, false]);
    assert.deepEqual(grid[2], [false, false, true, true], 'you can walk into the bottom half');
    assert.deepEqual(grid[3], [true, true, true, true], 'grass, doors and ladders are all walkable');
  });

  it('treats a ledge as a wall, because it only works one way', () => {
    const grid = parseCollision('\ttilecoll HOP_DOWN, HOP_LEFT, HOP_RIGHT, HOP_UP ; 00');
    assert.deepEqual(grid[0], [false, false, false, false]);
  });
});

describe('the charmap', () => {
  it('reads only the font section, and maps each character to a glyph', () => {
    const map = parseCharmap([
      '; ASCII (from gfx/font/font.png)',
      '\tcharmap "A", $80',
      '\tcharmap "B", $81',
      '\tcharmap "z", $bf',
      '\tcharmap "?", $e6',
      '; Japanese control characters',
      '\tcharmap "A", $10',
    ].join('\n'));

    assert.equal(map.A, 0, '$80 is the first glyph');
    assert.equal(map.B, 1);
    assert.equal(map.z, 0x3f);
    assert.equal(map['?'], 0x66);
    assert.equal(map[' '], 0x7f - 0x80, 'space is the blank tile');
  });

  it('ignores the kana section, which reuses the same byte values', () => {
    const map = parseCharmap([
      '; (from gfx/font/font.png)',
      '\tcharmap "A", $80',
      '; Japanese control characters',
      '\tcharmap "X", $80',
    ].join('\n'));
    assert.equal(map.A, 0);
    assert.equal(map.X, undefined);
  });
});

describe('map events', () => {
  it('picks out the doors and the readable signs', () => {
    const events = parseEvents([
      '\twarp_event  7, 17, VIOLET_GYM, 1',
      '\twarp_event 17,  9, VIOLET_MART, 2',
      '\tbg_event 11, 15, BGEVENT_READ, VioletCitySign',
      '\tbg_event  6, 17, BGEVENT_READ, VioletGymSign',
      '\tbg_event  1,  1, BGEVENT_ITEM, SomeHiddenItem',
      '\tobject_event 10, 10, SPRITE_YOUNGSTER, 1, 1, 0, 0, 0, 0, 0, 0, 0',
    ].join('\n'));

    assert.deepEqual(events.warps, [{ x: 7, y: 17, to: 'VIOLET_GYM' }, { x: 17, y: 9, to: 'VIOLET_MART' }]);
    assert.deepEqual(events.signs.map((s) => s.id), ['VioletCitySign', 'VioletGymSign']);
    assert.deepEqual(events.signs[0], { x: 11, y: 15, id: 'VioletCitySign' });
  });
});

const CRYSTAL = new URL('../.cache/pokecrystal', import.meta.url);
describe('against the real checkout', { skip: !fs.existsSync(CRYSTAL) && 'assets not fetched: run npm run setup' }, () => {
  it('builds a Violet City the client can actually draw', () => {
    const world = buildWorld(CRYSTAL.pathname);
    assert.equal(world.map.name, 'VioletCity');
    assert.equal(world.map.blocks.length, world.map.width * world.map.height);
    assert.ok(world.map.width > 0 && world.map.height > 0);

    // every block the map uses must have both a metatile to draw and a collision row to walk on
    for (const block of new Set([...world.map.blocks, world.map.border])) {
      assert.ok(world.tileset.metatiles[block], `block ${block} has no metatile`);
      assert.equal(world.tileset.metatiles[block].length, 16);
      assert.ok(world.tileset.collision[block], `block ${block} has no collision`);
    }

    // the stations are warps, so the buildings the game needs have to be in there
    const doors = new Set(world.map.warps.map((w) => w.to));
    for (const door of ['VIOLET_GYM', 'VIOLET_POKECENTER_1F', 'VIOLET_MART', 'EARLS_POKEMON_ACADEMY', 'SPROUT_TOWER_1F', 'VIOLET_KYLES_HOUSE', 'VIOLET_NICKNAME_SPEECH_HOUSE']) {
      assert.ok(doors.has(door), `${door} is missing, so a station has nowhere to stand`);
    }

    for (const period of ['morn', 'day', 'nite']) {
      assert.equal(world.palettes.bg[period].length, 8, `${period} needs all eight palettes`);
    }
    assert.ok(world.charmap.A !== undefined && world.charmap[' '] !== undefined);
    assert.ok(world.pngs.every((p) => fs.existsSync(new URL(`../.cache/assets/${p}`, import.meta.url))), 'setup copied every image across');
  });
});

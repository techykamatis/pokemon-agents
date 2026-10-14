// Violet City, from the data the setup build produced: the tile layer prerendered once per time of
// day, a 16px collision grid, BFS pathfinding over it, and the stations — the spots in front of
// real buildings where sessions doing a particular kind of work gather.
import { canvas, colorize } from './pixels.mjs';

export const SQUARE = 16; // one walkable square is 2x2 tiles, which is the unit pret's events use
const BORDER_BLOCKS = 3; // how much of the surrounding border to draw around the map

/** the same three buckets the progression rules use, so the city and the clock agree */
export const period = (date = new Date()) => {
  const hour = date.getHours();
  if (hour >= 4 && hour < 10) return 'morn';
  if (hour >= 10 && hour < 18) return 'day';
  return 'nite';
};

export class City {
  constructor(world, tilesetImage, roofImage) {
    this.world = world;
    this.tilesetImage = tilesetImage;
    this.roofImage = roofImage;

    const { width, height } = world.map;
    this.cols = width * 2;
    this.rows = height * 2;
    this.walk = this.buildCollision();
    this.layers = {};
    this.stations = this.buildStations();
  }

  /** the block at a block coordinate, falling back to the map's border block outside it */
  blockAt(bx, by) {
    const { width, height, blocks, border } = this.world.map;
    return bx >= 0 && by >= 0 && bx < width && by < height ? blocks[by * width + bx] : border;
  }

  /** one boolean per 16px square: each block carries the walkability of its four corners */
  buildCollision() {
    const grid = [];
    for (let y = 0; y < this.rows; y++) {
      const row = [];
      for (let x = 0; x < this.cols; x++) {
        const corners = this.world.tileset.collision[this.blockAt(x >> 1, y >> 1)] ?? [false, false, false, false];
        row.push(corners[(y & 1) * 2 + (x & 1)]);
      }
      grid.push(row);
    }
    return grid;
  }

  walkable(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows && this.walk[y][x];
  }

  /** the whole map drawn once for a time of day, border included, and kept */
  layer(when) {
    if (this.layers[when]) return this.layers[when];
    const { tileset, palettes, map } = this.world;

    // palette 6 is the roof, and its two middle colours come from the roof file instead
    const palette = palettes.bg[when].map((pal, i) => (
      i === 6 ? [pal[0], ...palettes.roof[when === 'nite' ? 'nite' : 'day'], pal[3]] : pal
    ));

    const drawn = new Map();
    const tile = (id) => {
      const cached = drawn.get(id);
      if (cached) return cached;
      const pal = palette[tileset.paletteMap[id]] ?? palette[0];
      const roofOffset = id - tileset.roofTile;
      let image;
      if (roofOffset >= 0 && roofOffset < 9) {
        image = colorize(this.roofImage, (roofOffset % 3) * 8, Math.floor(roofOffset / 3) * 8, 8, 8, pal);
      } else {
        // the font occupies $60-$7f in the tile ids, but not in the image, so the index shifts back
        const inImage = id < 0x60 ? id : id >= 0x80 ? id - 0x80 + 0x60 : 0;
        image = colorize(this.tilesetImage, (inImage % 16) * 8, Math.floor(inImage / 16) * 8, 8, 8, pal);
      }
      drawn.set(id, image);
      return image;
    };

    const { width, height } = map;
    const c = canvas((width + BORDER_BLOCKS * 2) * 32, (height + BORDER_BLOCKS * 2) * 32);
    const ctx = c.getContext('2d');
    for (let by = -BORDER_BLOCKS; by < height + BORDER_BLOCKS; by++) {
      for (let bx = -BORDER_BLOCKS; bx < width + BORDER_BLOCKS; bx++) {
        const metatile = this.world.tileset.metatiles[this.blockAt(bx, by)];
        for (let i = 0; i < 16; i++) {
          ctx.drawImage(
            tile(metatile[i]),
            (bx + BORDER_BLOCKS) * 32 + (i % 4) * 8,
            (by + BORDER_BLOCKS) * 32 + Math.floor(i / 4) * 8,
          );
        }
      }
    }
    this.layers[when] = c;
    return c;
  }

  /** draw the city so that world pixel (camX, camY) is the top-left of the screen */
  draw(ctx, camX, camY, when) {
    const offset = BORDER_BLOCKS * 32;
    ctx.drawImage(this.layer(when), Math.round(camX) + offset, Math.round(camY) + offset, 160, 144, 0, 0, 160, 144);
  }

  nearestWalkable(x, y) {
    if (this.walkable(x, y)) return { x, y };
    for (let r = 1; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) if (this.walkable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
    return { x, y };
  }

  /**
   * BFS over the 16px grid. `blocked(x, y)` lets the caller route around whoever is standing where,
   * except at the destination itself — otherwise walking up to someone would never find a path.
   * @returns {Array<{x, y}>|null} the squares to walk, excluding where you are
   */
  path(from, to, blocked = () => false) {
    if (from.x === to.x && from.y === to.y) return [];
    const key = (x, y) => y * this.cols + x;
    const cameFrom = new Map([[key(from.x, from.y), null]]);
    const queue = [from];

    while (queue.length) {
      const at = queue.shift();
      if (at.x === to.x && at.y === to.y) break;
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const nx = at.x + dx;
        const ny = at.y + dy;
        const k = key(nx, ny);
        if (cameFrom.has(k) || !this.walkable(nx, ny)) continue;
        if (blocked(nx, ny) && !(nx === to.x && ny === to.y)) continue;
        cameFrom.set(k, at);
        queue.push({ x: nx, y: ny });
      }
    }

    if (!cameFrom.has(key(to.x, to.y))) return null;
    const steps = [];
    for (let at = to; at && !(at.x === from.x && at.y === from.y); at = cameFrom.get(key(at.x, at.y))) steps.unshift(at);
    return steps;
  }

  /**
   * Each station is a kind of work, pinned to the building that means it. The first spot is the
   * place itself and the rest are overflow, so a crowd queues up outside rather than stacking.
   */
  buildStations() {
    const door = (to) => this.world.map.warps.find((w) => w.to === to);
    const outside = (to, label) => {
      const at = door(to);
      return { label, spots: this.spread(at.x, at.y + 1) };
    };

    const tradeHouse = outside('VIOLET_KYLES_HOUSE', 'TRADE HOUSE');
    // Kyle's door opens onto the west edge of the park, so the park must not offer those squares too
    const notTheTradeHouse = (spot) => !tradeHouse.spots.some((s) => s.x === spot.x && s.y === spot.y);

    return {
      desk: outside('VIOLET_NICKNAME_SPEECH_HOUSE', 'HOUSE'), // editing: writing things down
      library: outside('EARLS_POKEMON_ACADEMY', 'ACADEMY'), // reading, searching, planning
      testbench: outside('VIOLET_GYM', 'VIOLET GYM'), // tests: the trial
      mergestation: outside('VIOLET_POKECENTER_1F', 'POKéMON CENTER'), // git: save and heal
      terminal: outside('VIOLET_MART', 'POKéMART'), // the rest of the shell work
      meeting: tradeHouse, // handing work to subagents, which is what evolves a Pokémon
      tower: outside('SPROUT_TOWER_1F', 'SPROUT TOWER'), // a finished goal reports to the Elder
      gate: { label: 'ROUTE 31 GATE', spots: this.spread(37, 24) }, // the web and MCP: out of town
      lounge: { label: 'PARK', spots: this.spread(27, 30, 24).filter(notTheTradeHouse) },
      user: { label: 'WITH YOU', spots: [] }, // filled in against wherever you are standing
    };
  }

  /** walkable squares around a point, nearest first, never behind the building itself */
  spread(x, y, max = 8) {
    const out = [];
    for (let r = 0; r < 6 && out.length < max; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const onRing = Math.max(Math.abs(dx), Math.abs(dy)) === r;
          if (onRing && dy >= 0 && this.walkable(x + dx, y + dy)) out.push({ x: x + dx, y: y + dy });
        }
      }
    }
    return out.length ? out : [this.nearestWalkable(x, y)];
  }
}

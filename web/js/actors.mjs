// Everything that moves, and the images it is drawn with.
//
// You walk. One Pokémon walks per live session, standing at the building that matches the work it
// is doing right now, or coming to find you when it needs an answer. Each released legendary
// patrols the building its job belongs to. The game only ever watches the sessions — nothing here
// drives them.
import { SQUARE } from './city.mjs';
import { H, W, canvas, colorize, loadImage, makeWalker } from './pixels.mjs';

export const DIRS = { DOWN: [0, 1], UP: [0, -1], LEFT: [-1, 0], RIGHT: [1, 0] };
const OPPOSITE = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

const SWAP_HOLD = 10; // ticks you must hold a direction to swap places rather than just turn
const PATROL_RANGE = 3; // how far a legendary strays from its building
const ROAMER_EVERY = 45; // ticks between a roamer considering a step
const FAR_AWAY = 12; // squares: past this a session Pokémon walks at double speed to catch up
const NPC_PALETTES = ['red', 'blue', 'green', 'brown', 'pink', 'silver', 'tree', 'rock'];

/** the three legendaries pret has real overworld sprites for; the rest use their menu icon */
const ROAMER_SPRITES = { 243: ['raikou', 'brown'], 244: ['entei', 'red'], 245: ['suicune', 'blue'] };
const STATUS_EMOTES = { waiting: 'shock', done: 'happy', resting: 'sleep' };

export const faceTo = (from, to) => (
  Math.abs(to.x - from.x) > Math.abs(to.y - from.y)
    ? (to.x > from.x ? 'RIGHT' : 'LEFT')
    : (to.y > from.y ? 'DOWN' : 'UP')
);

// --- images -------------------------------------------------------------------------------------
/** Every image the game draws: the fixed ones loaded at boot, the per-species ones on demand. */
export class Sprites {
  constructor(world, images) {
    this.world = world;
    this.images = images;
    this.cache = new Map();
    this.walkers = new Map(); // species -> two 16x16 frames
    this.shinyWalkers = new Map();
    this.fronts = new Map(); // species -> { normal, shiny }
  }

  static async load(world, assetUrl) {
    const wanted = {
      tileset: world.tileset.png,
      roof: world.tileset.roofPng,
      font: world.font,
      frame: world.frame,
      badges: world.badges,
      ...Object.fromEntries(Object.entries(world.sprites).map(([k, v]) => [`sprite:${k}`, v])),
      ...Object.fromEntries(Object.entries(world.emotes).map(([k, v]) => [`emote:${k}`, v])),
    };
    const loaded = await Promise.all(Object.entries(wanted).map(async ([key, file]) => [key, await loadImage(assetUrl(file))]));
    return new Sprites(world, Object.fromEntries(loaded));
  }

  memo(key, make) {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }

  /** a species' front sprite, overworld walker and shiny variants, fetched once */
  async loadMon(id) {
    if (this.walkers.has(id)) return;
    this.walkers.set(id, null); // claim it now, so a second caller does not fetch it again
    const [icon, front, shiny] = await Promise.all([
      loadImage(`/assets/mon/icon/${id}.png`),
      loadImage(`/assets/mon/front/${id}.png`),
      loadImage(`/assets/mon/shiny/${id}.png`),
    ]);
    this.walkers.set(id, makeWalker(icon));
    this.fronts.set(id, { normal: front.canvas, shiny: shiny.canvas });
    this.shinyWalkers.set(id, tintWalker(this.walkers.get(id), averageColor(front), averageColor(shiny)));
  }

  /** the big front sprite; starts loading and returns null the first time it is asked for */
  front(id, shiny) {
    const pair = this.fronts.get(id);
    if (!pair) { this.loadMon(id); return null; }
    return pair[shiny ? 'shiny' : 'normal'];
  }

  /** the flat black-and-white shape used while a Pokémon is evolving */
  silhouette(id) {
    if (!this.fronts.get(id)) { this.loadMon(id); return null; } // never cache before it has loaded
    return this.memo(`silhouette:${id}`, () => {
      const source = this.fronts.get(id).normal;
      const c = canvas(56, 56);
      const ctx = c.getContext('2d');
      ctx.drawImage(source, 0, 0);
      const data = ctx.getImageData(0, 0, 56, 56);
      for (let i = 0; i < data.data.length; i += 4) {
        const isBackground = data.data[i + 3] < 128 || (data.data[i] > 240 && data.data[i + 1] > 240 && data.data[i + 2] > 240);
        data.data.set(isBackground ? [248, 248, 248, 255] : [24, 24, 24, 255], i);
      }
      ctx.putImageData(data, 0, 0);
      return c;
    });
  }

  walkerFrames(species, shiny) {
    return shiny ? this.shinyWalkers.get(species) : this.walkers.get(species);
  }

  npcPalette(name, when) {
    return this.world.palettes.npc[when === 'nite' ? 'nite' : 'day'][NPC_PALETTES.indexOf(name)];
  }

  /** one frame of a pret overworld sprite, in an NPC palette */
  npcSprite(name, palette, frame, when) {
    return this.memo(`npc:${name}:${palette}:${frame}:${when}`, () => colorize(this.images[`sprite:${name}`], 0, frame * 16, 16, 16, this.npcPalette(palette, when), true));
  }

  emote(name) {
    return this.memo(`emote:${name}`, () => colorize(this.images[`emote:${name}`], 0, 0, 16, 16, [[0, 0, 0], [248, 248, 248], [120, 120, 120], [16, 16, 16]], true));
  }

  badge(index, palette) {
    return this.memo(`badge:${index}:${palette[1]}`, () => colorize(this.images.badges, 0, index * 16, 16, 16, palette, true));
  }
}

/** the average non-white colour of a Crystal front sprite */
function averageColor(image) {
  const sum = [0, 0, 0];
  let counted = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b, a] = image.data.subarray(i, i + 4);
    if (a > 127 && !(r > 240 && g > 240 && b > 240)) { sum[0] += r; sum[1] += g; sum[2] += b; counted++; }
  }
  return sum.map((v) => (counted ? v / counted : 1));
}

/** Gen 7 icons have no shiny set, so shift a walker's colours by the normal-to-shiny ratio */
function tintWalker(frames, from, to) {
  return frames.map((frame) => {
    const c = canvas(16, 16);
    const ctx = c.getContext('2d');
    ctx.drawImage(frame, 0, 0);
    const data = ctx.getImageData(0, 0, 16, 16);
    for (let i = 0; i < data.data.length; i += 4) {
      for (let k = 0; k < 3; k++) data.data[i + k] = Math.min(255, data.data[i + k] * (to[k] / Math.max(1, from[k])));
    }
    ctx.putImageData(data, 0, 0);
    return c;
  });
}

// --- one thing that walks ------------------------------------------------------------------------
export class Walker {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.px = x * SQUARE;
    this.py = y * SQUARE;
    this.facing = 'DOWN';
    this.moving = 0; // pixels still to slide before it is on its square again
    this.path = [];
    this.anim = 0;
  }

  get busy() { return this.moving > 0; }

  /** turn, and step if `canEnter` allows it */
  step(dir, canEnter) {
    const [dx, dy] = DIRS[dir];
    this.facing = dir;
    if (!canEnter(this.x + dx, this.y + dy)) return false;
    this.x += dx;
    this.y += dy;
    this.moving = SQUARE;
    return true;
  }

  update(speed = 1) {
    if (this.moving <= 0) return;
    const by = Math.min(speed, this.moving);
    this.moving -= by;
    this.px += Math.sign(this.x * SQUARE - this.px) * by;
    this.py += Math.sign(this.y * SQUARE - this.py) * by;
    this.anim++;
  }
}

// --- the overworld -------------------------------------------------------------------------------
export class Overworld {
  /** @param {{city: object, sprites: Sprites, bridge: object, start: {x, y}}} opts */
  constructor({ city, sprites, bridge, start = { x: 24, y: 21 } }) {
    this.city = city;
    this.sprites = sprites;
    this.bridge = bridge;
    this.player = new Walker(start.x, start.y);
    this.player.facing = 'UP';
    this.walkers = new Map(); // session id -> Walker
    this.roamers = new Map(); // species -> Walker
    this.walkingTo = null; // a session id: you are walking over to it
    this.bumping = 0;
  }

  sessionAt(id) { return this.bridge.sessions.find((s) => s.id === id); }

  /** is this square taken by anyone other than `self`? */
  occupied(x, y, self) {
    if (this.player !== self && this.player.x === x && this.player.y === y) return true;
    return [...this.walkers.values(), ...this.roamers.values()].some((w) => w !== self && w.x === x && w.y === y);
  }

  canWalk(x, y, self) { return this.city.walkable(x, y) && !this.occupied(x, y, self); }

  dirBetween(from, to) {
    return Object.keys(DIRS).find((d) => DIRS[d][0] === to.x - from.x && DIRS[d][1] === to.y - from.y);
  }

  // --- where each session should be standing -----------------------------------------------------
  targetFor(session, index) {
    if (session.station === 'user') {
      // the squares around you, shared out so two sessions needing you do not fight over one spot
      const spots = Object.values(DIRS)
        .map(([dx, dy]) => ({ x: this.player.x + dx, y: this.player.y + dy }))
        .filter((p) => this.city.walkable(p.x, p.y));
      const place = this.bridge.waiting.findIndex((w) => w.id === session.id);
      return spots[Math.max(0, place) % Math.max(1, spots.length)] ?? this.player;
    }
    const station = this.city.stations[session.station] ?? this.city.stations.desk;
    if (session.station === 'lounge') return station.spots[index % station.spots.length];
    // a stable queue position: how many sessions with a lower id are already at this station
    const ahead = this.bridge.sessions.filter((o) => o.station === session.station && o.id < session.id).length;
    return station.spots[ahead % station.spots.length];
  }

  updateWalkers() {
    const live = this.bridge.sessions.filter((s) => s.status !== 'resting'); // resting is back in its ball
    for (const id of this.walkers.keys()) if (!live.some((s) => s.id === id)) this.walkers.delete(id);

    live.forEach((session, index) => {
      let walker = this.walkers.get(session.id);
      if (!walker) {
        // arrive in the park and walk to wherever the work is from there
        const spot = this.city.stations.lounge.spots[index % this.city.stations.lounge.spots.length];
        walker = new Walker(spot.x, spot.y);
        this.walkers.set(session.id, walker);
      }

      const mon = this.bridge.monOf(session);
      if (mon) this.sprites.loadMon(mon.species);
      if (session.look) this.sprites.loadMon(session.look);
      if (walker.busy) return;

      const target = this.targetFor(session, index);
      if (walker.x === target.x && walker.y === target.y) {
        if (session.station === 'user') walker.facing = faceTo(walker, this.player); // look up at you
        return;
      }

      // route around you and the roamers; other session Pokémon step aside instead
      const inTheWay = (x, y) => (this.player.x === x && this.player.y === y)
        || [...this.roamers.values()].some((r) => r.x === x && r.y === y);
      if (!walker.path.length || walker.goal?.x !== target.x || walker.goal?.y !== target.y) {
        walker.goal = target;
        walker.path = this.city.path(walker, target, inTheWay) ?? [];
      }

      const next = walker.path[0];
      if (!next) return;
      const dir = this.dirBetween(walker, next);
      if (dir && this.occupied(next.x, next.y, walker)) this.swapInto(walker, dir);
      if (dir && walker.step(dir, (x, y) => this.canWalk(x, y, walker))) walker.path.shift();
      else if (!walker.busy) walker.path = []; // blocked: plan again next time
    });
  }

  /**
   * A session's Pokémon never walls anyone in: whoever walks into one standing still swaps places
   * with it, the way a follower does. Roamers do block, because a legendary should feel immovable.
   */
  swapInto(mover, dir) {
    const [dx, dy] = DIRS[dir];
    const other = [...this.walkers.values()].find((w) => w !== mover && w.x === mover.x + dx && w.y === mover.y + dy && !w.busy);
    if (!other) return false;
    // both heading for the same square would make them trade places forever
    if (mover.goal && other.goal?.x === mover.goal.x && other.goal?.y === mover.goal.y) return false;
    other.x = mover.x;
    other.y = mover.y;
    other.moving = SQUARE;
    other.path = [];
    other.facing = OPPOSITE[dir];
    return true;
  }

  /** for you it takes holding the direction: a tap just turns to face it, so you can talk */
  swapWithHeld(dir) {
    const [dx, dy] = DIRS[dir];
    const blocked = [...this.walkers.values()].some((w) => w.x === this.player.x + dx && w.y === this.player.y + dy);
    if (!blocked || this.player.facing !== dir) { this.bumping = 0; return; }
    if (++this.bumping < SWAP_HOLD) return;
    this.bumping = 0;
    this.swapInto(this.player, dir);
  }

  // --- legendaries -------------------------------------------------------------------------------
  homeOf(species) {
    const station = this.city.stations[this.bridge.legends?.[species]?.home];
    return station?.spots.at(-1) ?? this.city.nearestWalkable(10, 10);
  }

  updateRoamers(tick) {
    for (const species of this.bridge.progress?.team.legendaries ?? []) {
      if (this.roamers.has(species)) continue;
      const home = this.homeOf(species);
      this.roamers.set(species, new Walker(home.x, home.y));
      this.sprites.loadMon(species);
    }
    if (tick % ROAMER_EVERY) return;

    for (const [species, roamer] of this.roamers) {
      if (roamer.busy || Math.random() < 0.5) continue; // an unhurried patrol
      const home = this.homeOf(species);
      const strayed = Math.abs(roamer.x - home.x) + Math.abs(roamer.y - home.y) > PATROL_RANGE;
      const next = strayed ? this.city.path(roamer, home, (x, y) => this.occupied(x, y, roamer))?.[0] : null;
      const dir = next ? this.dirBetween(roamer, next) : Object.keys(DIRS)[Math.floor(Math.random() * 4)];
      roamer.step(dir, (x, y) => this.canWalk(x, y, roamer)
        && (strayed || Math.abs(x - home.x) + Math.abs(y - home.y) <= PATROL_RANGE));
    }
  }

  // --- walking over to something -----------------------------------------------------------------
  walkTo(id) { this.walkingTo = id; }

  /**
   * One step of walking over to a session's Pokémon.
   * @returns {{arrived: string}|{message: string}|null} null while still on the way
   */
  stepTowards() {
    const id = this.walkingTo;
    const session = this.sessionAt(id);
    const walker = this.walkers.get(id);
    if (!session || !walker) {
      this.walkingTo = null;
      return { message: session ? `${session.name.toUpperCase()} is resting in its ball.` : 'That session is gone.' };
    }
    if (Math.abs(walker.x - this.player.x) + Math.abs(walker.y - this.player.y) === 1) {
      this.player.facing = faceTo(this.player, walker);
      this.walkingTo = null;
      return { arrived: id };
    }
    // planned again every square, because it may well be walking too
    const next = this.city.path(this.player, walker, (x, y) => [...this.roamers.values()].some((r) => r.x === x && r.y === y))?.[0];
    if (!next) { this.walkingTo = null; return { message: "Can't find a way there." }; }
    const dir = this.dirBetween(this.player, next);
    if (this.occupied(next.x, next.y, this.player)) this.swapInto(this.player, dir);
    this.player.step(dir, (x, y) => this.canWalk(x, y, this.player));
    return null;
  }

  /** what you are facing: a session's Pokémon, a legendary, or a sign */
  facing() {
    const [dx, dy] = DIRS[this.player.facing];
    const x = this.player.x + dx;
    const y = this.player.y + dy;

    const session = [...this.walkers.entries()].find(([, w]) => w.x === x && w.y === y);
    if (session) return { kind: 'session', id: session[0] };
    const roamer = [...this.roamers.entries()].find(([, w]) => w.x === x && w.y === y);
    if (roamer) return { kind: 'legend', id: Number(roamer[0]) };
    const sign = this.city.world.map.signs.find((s) => s.x === x && s.y === y);
    if (sign) return { kind: 'sign', id: sign.id };
    return null;
  }

  // --- moving and drawing ------------------------------------------------------------------------
  /**
   * Move everything on by one tick.
   * @returns {{arrived: string}|{message: string}|null} whatever a walk-to has to report
   */
  advance(held, uiBusy) {
    let walkingOutcome = null;
    if (!this.player.busy && !uiBusy) {
      const dir = [...held].at(-1);
      if (dir) {
        this.walkingTo = null; // you took the controls back
        this.swapWithHeld(dir);
        this.player.step(dir, (x, y) => this.canWalk(x, y, this.player));
      } else {
        this.bumping = 0;
        if (this.walkingTo) walkingOutcome = this.stepTowards();
      }
    }
    this.player.update(this.walkingTo ? 2 : 1); // a walk you asked for should not dawdle
    for (const walker of this.walkers.values()) {
      const far = Math.hypot(walker.x - this.player.x, walker.y - this.player.y) > FAR_AWAY;
      walker.update(far ? 2 : 1); // off screen, hurry up: nobody is watching it stroll
    }
    for (const roamer of this.roamers.values()) roamer.update(1);
    return walkingOutcome;
  }

  playerFrame(when) {
    const stepping = this.player.busy && (this.player.anim >> 3) % 2;
    const base = { DOWN: 0, UP: 1, LEFT: 2, RIGHT: 2 }[this.player.facing];
    return this.sprites.npcSprite('chris', 'red', stepping ? base + 3 : base, when);
  }

  /** which image a session's Pokémon is drawn with right now */
  monFrame(session, walker, tick) {
    const mon = this.bridge.monOf(session);
    const look = session.look ?? mon?.species;
    const frames = look && (look === mon?.species ? this.sprites.walkerFrames(mon.species, mon.shiny) : this.sprites.walkerFrames(look, false));
    // until its sprite has loaded it is still in its ball
    if (!frames) return this.sprites.npcSprite('poke_ball', 'red', 0, 'day');
    return frames[(walker.busy ? walker.anim >> 3 : tick >> 5) % 2];
  }

  draw(ctx, tick, when) {
    const camX = this.player.px - 64;
    const camY = this.player.py - 64;
    this.city.draw(ctx, camX, camY, when);

    const place = (walker, image, mirrored) => drawAt(ctx, walker, image, camX, camY, mirrored);

    // drawn back to front, so someone further down the screen overlaps someone further up
    const everyone = [
      { walker: this.player, paint: () => place(this.player, this.playerFrame(when), this.player.facing === 'RIGHT') },
      ...[...this.walkers.entries()].map(([id, walker]) => ({
        walker,
        paint: () => {
          const session = this.sessionAt(id);
          if (session) place(walker, this.monFrame(session, walker, tick), walker.facing === 'RIGHT');
        },
      })),
      ...[...this.roamers.entries()].map(([species, walker]) => ({
        walker,
        paint: () => {
          const own = ROAMER_SPRITES[species];
          const image = own
            ? this.sprites.npcSprite(own[0], own[1], 0, when)
            : this.sprites.walkerFrames(Number(species), false)?.[(tick >> 4) % 2];
          place(walker, image, false);
        },
      })),
    ].sort((a, b) => a.walker.py - b.walker.py);
    for (const one of everyone) one.paint();

    this.drawEmotes(ctx, tick, camX, camY);
  }

  /** the bubble above a Pokémon: ! when it needs you, a bolt when its subagents are out */
  drawEmotes(ctx, tick, camX, camY) {
    const blinking = (tick >> 5) % 2;
    for (const [id, walker] of this.walkers) {
      const session = this.sessionAt(id);
      if (!session) continue;
      const emote = session.subagents && session.status === 'working' ? 'bolt' : STATUS_EMOTES[session.status];
      if (!emote) continue;
      if (emote === 'shock' && !blinking) continue; // a ! blinks, so it catches your eye
      drawAt(ctx, { px: walker.px, py: walker.py - 16 }, this.sprites.emote(emote), camX, camY, false);
    }
    for (const [species, roamer] of this.roamers) {
      if (!this.bridge.legends?.[species]?.alert || !blinking) continue;
      drawAt(ctx, { px: roamer.px, py: roamer.py - 16 }, this.sprites.emote('shock'), camX, camY, false);
    }
  }
}

/** draw a 16x16 image at a walker's pixel position, skipping it if it is off screen */
function drawAt(ctx, walker, image, camX, camY, mirrored) {
  const x = Math.round(walker.px - camX);
  const y = Math.round(walker.py - camY) - 4; // sprites stand a little above their square
  if (!image || x < -16 || y < -16 || x > W || y > H) return;
  if (!mirrored) { ctx.drawImage(image, x, y); return; }
  ctx.save();
  ctx.translate(x + 16, y);
  ctx.scale(-1, 1);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

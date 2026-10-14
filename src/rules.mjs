// The rules of progression: what work is worth, how a Pokémon levels, which badge a milestone earns,
// and when an evolution is allowed to fire. Pure functions and tables only — src/progression.mjs
// feeds them the events read out of your transcripts. Tune the numbers here and nowhere else.

export const START_LEVEL = 5;

/** what each kind of work is worth. A commit is worth 25 tool calls; a merge, fifty. */
export const XP = { tool: 2, session: 20, test: 10, commit: 50, merge: 100, subagent: 5 };

/** friendship, Gen 2 style: it grows by showing up, finishing things, and coming back tomorrow */
export const FRIENDSHIP = { base: 70, day: 8, session: 2, commit: 3, level: 1, max: 255 };

export const SHINY_ODDS = 8192;

// --- the curve -----------------------------------------------------------------------------------
/** Gen 2's "medium fast" curve: the total XP for level n is n cubed. */
export const xpForLevel = (n) => n ** 3;
/** the inverse, clamped to a real level. The epsilon keeps cbrt(n^3) off the wrong side of an integer. */
export const levelFor = (xp) => Math.max(1, Math.min(100, Math.floor(Math.cbrt(xp + 1e-9))));

// --- the clock -----------------------------------------------------------------------------------
/** Gen 2's clock: morn 4-9, day 10-17, nite 18-3. Local time, because it is your day that matters. */
export const timeOfDay = (date) => {
  const hour = date.getHours();
  if (hour >= 4 && hour < 10) return 'morn';
  if (hour >= 10 && hour < 18) return 'day';
  return 'nite';
};

/** PokeAPI says "day" or "night"; its "day" covers Gen 2's morn as well */
const matchesTimeOfDay = (wanted, date) => {
  if (!wanted) return true;
  return wanted === 'night' ? timeOfDay(date) === 'nite' : timeOfDay(date) !== 'nite';
};

export const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const nextDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + 1)); // Date rolls the month and year over for us
};

/**
 * The current and best runs of consecutive days, from a set of days in any order. A backfill reads
 * transcripts one file at a time, so days arrive shuffled; counting from a sorted set makes the
 * answer independent of the order they turned up in.
 * @param {string[]} days
 */
export function streaks(days) {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of sorted) {
    run = previous && nextDay(previous) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return { current: run, best };
}

// --- badges and achievements ---------------------------------------------------------------------
// Badges belong to you, not to one project: they are earned across everything you work on. `item`
// goes into the bag, where it can trigger a stone evolution; `unlock` releases a legendary.
export const BADGES = [
  { id: 'zephyr', name: 'ZEPHYRBADGE', why: 'first commit', test: (t) => t.commits >= 1, item: 'moon-stone' },
  { id: 'hive', name: 'HIVEBADGE', why: '10 green test runs', test: (t) => t.testsGreen >= 10, item: 'leaf-stone' },
  { id: 'plain', name: 'PLAINBADGE', why: 'a failing test fixed in the same session', test: (t) => t.fixes >= 1, item: 'thunder-stone', unlock: 243 },
  { id: 'fog', name: 'FOGBADGE', why: 'first merge', test: (t) => t.merges >= 1, item: 'water-stone', unlock: 245 },
  { id: 'storm', name: 'STORMBADGE', why: '7-day streak', test: (t) => t.bestStreak >= 7, item: 'fire-stone', unlock: 244 },
  { id: 'mineral', name: 'MINERALBADGE', why: '100 commits', test: (t) => t.commits >= 100, item: 'metal-coat' },
  { id: 'glacier', name: 'GLACIERBADGE', why: 'a clean session (25+ tools, no errors)', test: (t) => t.cleanSessions >= 1, item: 'kings-rock' },
  { id: 'rising', name: 'RISINGBADGE', why: '100 sessions', test: (t) => t.sessions >= 100, item: 'dragon-scale', unlock: 249 },
];

/** everything beyond the eight badges: the remaining evolution items, Eggs, and the last legendaries */
export const EXTRAS = [
  { id: 'sun', name: 'SUN STONE', why: '10 merges', test: (t) => t.merges >= 10, item: 'sun-stone' },
  { id: 'upgrade', name: 'UP-GRADE', why: '5000 tool calls', test: (t) => t.toolCalls >= 5000, item: 'up-grade' },
  { id: 'egg', name: 'EGG', why: '25 sessions', test: (t) => t.sessions >= 25, egg: true },
  { id: 'egg2', name: 'EGG', why: '250 sessions', test: (t) => t.sessions >= 250, egg: true },
  { id: 'champion', name: 'CHAMPION', why: 'all 8 badges', test: (t) => t.badges >= 8, unlock: 250 },
  { id: 'celebi', name: 'TIME TRAVELER', why: '30 active days', test: (t) => t.daysActive >= 30, unlock: 251 },
];

// --- who a new project gets ----------------------------------------------------------------------
/**
 * The species a brand-new project may be rolled as: first stages only, so there is somewhere to
 * grow. A species whose only pre-evolution is a baby (Pikachu, Clefairy) counts as a first stage.
 * Legendaries and mythicals are never handed out, and babies only hatch from an Egg.
 */
export function rollPool(pokedex) {
  const byId = new Map(pokedex.species.map((s) => [s.id, s]));
  return pokedex.species
    .filter((s) => !s.isBaby && !s.isLegendary && !s.isMythical && (!s.evolvesFrom || byId.get(s.evolvesFrom)?.isBaby))
    .map((s) => s.id);
}

/** what an Egg can hatch into */
export const babyPool = (pokedex) => pokedex.species.filter((s) => s.isBaby).map((s) => s.id);

/**
 * species id -> the first stage of its family (Pidgeotto -> Pidgey, Pikachu -> Pichu). Two projects
 * in one family would look like the same Pokémon once one evolved, so families are kept distinct.
 */
export function familyOf(pokedex) {
  const byId = new Map(pokedex.species.map((s) => [s.id, s]));
  return (id) => {
    let species = byId.get(id);
    // the longest Gen 1-2 chain is three stages, plus a baby: four hops is already generous
    for (let hop = 0; species?.evolvesFrom && hop < 4; hop++) species = byId.get(species.evolvesFrom) ?? null;
    return species?.id ?? id;
  };
}

// --- evolution -----------------------------------------------------------------------------------
/**
 * The first evolution of `mon` that the moment allows, or null.
 *
 * Which work stands in for which Gen 2 trigger:
 *   level-up  a level gained, as in the games (friendship, time of day and stats still apply)
 *   use-item  a stone in the bag, earned from a badge; checked any time
 *   trade     a session handing work to a subagent, which is the closest thing to a trade
 *
 * Tyrogue's relative-stat rule reads commits as Attack and green tests as Defense: ship more than
 * you verify and you get Hitmonlee, verify more than you ship and you get Hitmonchan.
 *
 * @param {object} pokedex
 * @param {{species: number, level: number, friendship: number, commits: number, testsGreen: number}} mon
 * @param {{event: 'level'|'item'|'trade', date: Date, bag: Record<string, number>}} ctx
 */
export function findEvolution(pokedex, mon, ctx) {
  for (const edge of pokedex.evolutions) {
    if (edge.from !== mon.species) continue;

    if (edge.trigger === 'level-up' && ctx.event === 'level') {
      if (edge.minLevel != null && mon.level < edge.minLevel) continue;
      if (edge.minHappiness != null && mon.friendship < edge.minHappiness) continue;
      if (!matchesTimeOfDay(edge.timeOfDay, ctx.date)) continue;
      if (edge.relativePhysicalStats != null && Math.sign(mon.commits - mon.testsGreen) !== edge.relativePhysicalStats) continue;
      return edge;
    }
    if (edge.trigger === 'use-item' && ctx.event === 'item' && ctx.bag[edge.item] > 0) return edge;
    if (edge.trigger === 'trade' && ctx.event === 'trade' && (!edge.heldItem || ctx.bag[edge.heldItem] > 0)) return edge;
  }
  return null;
}

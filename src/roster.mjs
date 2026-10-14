// Which Pokémon each live session is drawn as.
//
// A project *is* its Pokémon. But one repo can have several sessions open at once, and three
// identical Ariados shuffling around Violet City reads as noise rather than information. So per
// project the session most worth your attention wears the project's own Pokémon, and the rest get
// stand-ins: chosen by a hash of the session id, so they hold still while the map does, and drawn
// from evolution families that are not already on screen and species no project owns.
//
// Each rule gives way only once it has nothing left to offer, so looks are almost always unique and
// never absent.
import { familyOf } from './rules.mjs';

/** which session leads a project: the one you most need to look at */
const ATTENTION = { waiting: 0, working: 1, done: 2, idle: 3, resting: 4 };

const memo = new WeakMap();
function dexInfo(pokedex) {
  if (!memo.has(pokedex)) {
    memo.set(pokedex, {
      // a legendary stand-in would be a lie: those are earned, and they roam on their own
      pool: pokedex.species.filter((s) => !s.isLegendary && !s.isMythical).map((s) => s.id),
      family: familyOf(pokedex),
    });
  }
  return memo.get(pokedex);
}

/** FNV-1a: a small stable hash, so a session keeps its stand-in for as long as the map lasts */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * @param {object[]} sessions from the watcher
 * @param {Record<string, {species: number}>} mons progression's Pokémon, by project
 * @param {object} pokedex
 * @returns {object[]} the same sessions, each with `look`: the species id to draw it as
 */
export function assignLooks(sessions, mons, pokedex) {
  const { pool, family } = dexInfo(pokedex);
  const ownSpecies = (session) => mons[session.project]?.species ?? null;

  // a resting session is back in its ball, so it is not on the map and cannot clash with anyone
  const onMap = sessions
    .filter((s) => s.status !== 'resting')
    .sort((a, b) => (ATTENTION[a.status] ?? 9) - (ATTENTION[b.status] ?? 9) || b.lastTs - a.lastTs || (a.id < b.id ? -1 : 1));

  const looks = new Map();
  const leading = new Set();
  for (const session of onMap) {
    if (leading.has(session.project)) continue;
    leading.add(session.project);
    looks.set(session.id, ownSpecies(session));
  }

  const owned = new Set(Object.values(mons).map((m) => m.species));
  const shown = new Set([...looks.values()].filter(Boolean));
  const families = new Set([...shown].map(family));

  const preferences = [
    (id) => !owned.has(id) && !families.has(family(id)), // nobody's, and nothing like it on screen
    (id) => !families.has(family(id)), // at least nothing like it on screen
    (id) => !shown.has(id), // at least not this very species twice
    () => true, // a repeat beats an empty square
  ];

  // sorted by id so the result does not depend on the order the watcher happened to return
  const standIns = onMap.filter((s) => !looks.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const session of standIns) {
    const choices = preferences.map((allowed) => pool.filter(allowed)).find((c) => c.length);
    const species = choices[hash(session.id) % choices.length];
    looks.set(session.id, species);
    shown.add(species);
    families.add(family(species));
  }

  return sessions.map((s) => ({ ...s, look: looks.has(s.id) ? looks.get(s.id) : ownSpecies(s) }));
}

// One Pokémon per project, kept for good. This turns the events read out of your transcripts
// (src/transcript.mjs, tagged with a project by src/watcher.mjs) into XP, levels, friendship,
// badges, items and evolutions, and reports every milestone so the game can act it out.
//
// Two properties the whole thing leans on:
//   - apply() works on a structuredClone and swaps it in at the end, so a throw anywhere leaves the
//     previous state untouched rather than half-applied.
//   - days are sets and streaks are derived from them, so the order a backfill happens to read
//     files in cannot change the result.
import {
  BADGES, EXTRAS, FRIENDSHIP, SHINY_ODDS, START_LEVEL, XP,
  babyPool, familyOf, findEvolution, levelFor, localDay, rollPool, streaks, xpForLevel,
} from './rules.mjs';

const RECENT = 30; // milestones kept on the state for a page that has just connected

export function emptyState() {
  return {
    version: 1,
    mons: {},
    team: {
      sessions: 0, toolCalls: 0, testsGreen: 0, fixes: 0, commits: 0, merges: 0, cleanSessions: 0,
      days: [], daysActive: 0, streak: 0, bestStreak: 0,
      badges: [], achievements: [], bag: {}, eggs: 0, legendaries: [],
    },
    recent: [],
  };
}

/**
 * @param {object} opts
 * @param {object} opts.pokedex  the Pokédex built at setup
 * @param {object} [opts.state]  progression saved from a previous run
 * @param {() => number} [opts.rng]
 */
export function createProgression({ pokedex, state = emptyState(), rng = Math.random }) {
  const pool = rollPool(pokedex);
  const babies = babyPool(pokedex);
  const family = familyOf(pokedex);
  let current = state;

  /** @param {Array<{kind: string, ts: number, project: string, name: string}>} events */
  function apply(events) {
    const draft = structuredClone(current);
    const ctx = { state: draft, out: [], credit: null, dayOf: new Map(), date: new Date() };
    for (const event of events) {
      ctx.date = new Date(event.ts || Date.now());
      applyOne(ctx, event);
    }
    // Badges are checked once per batch, not once per event: a full backfill is millions of events
    // across a hundred-odd projects, and the answer is the same either way.
    if (events.length) awardWhatIsEarned(ctx);
    draft.recent = [...draft.recent, ...ctx.out].slice(-RECENT);
    current = draft;
    return ctx.out;
  }

  function applyOne(ctx, event) {
    if (!event.project || event.project === 'unknown') return;
    const mon = ctx.state.mons[event.project] ?? meet(ctx, event);
    const team = ctx.state.team;
    ctx.credit = event.project; // whichever project was in play when a badge landed gets the credit
    markDay(ctx, event.project, mon);

    switch (event.kind) {
      case 'session':
        mon.sessions++; team.sessions++;
        befriend(mon, FRIENDSHIP.session);
        gainXp(ctx, event.project, XP.session);
        break;
      case 'tool':
        mon.toolCalls++; team.toolCalls++;
        gainXp(ctx, event.project, XP.tool);
        break;
      case 'test':
        mon.testsGreen++; team.testsGreen++;
        gainXp(ctx, event.project, XP.test);
        break;
      case 'fix':
        mon.fixes++; team.fixes++;
        break;
      case 'commit':
        mon.commits++; team.commits++;
        befriend(mon, FRIENDSHIP.commit);
        gainXp(ctx, event.project, XP.commit);
        break;
      case 'merge':
        mon.merges++; team.merges++;
        gainXp(ctx, event.project, XP.merge);
        break;
      case 'clean':
        mon.cleanSessions++; team.cleanSessions++;
        break;
      case 'subagent':
        mon.trades++;
        gainXp(ctx, event.project, XP.subagent);
        ctx.out.push({ kind: 'trade', agentId: event.project });
        tryEvolve(ctx, event.project, 'trade');
        break;
      default:
    }
  }

  /** a project turns up for the first time: roll it a Pokémon, or hatch one if an Egg is waiting */
  function meet(ctx, event) {
    const { state: draft } = ctx;
    const hatching = draft.team.eggs > 0;
    const owned = Object.values(draft.mons).map((m) => m.species);
    // the owner of a Pidgeotto owns Pidgey's family too, so no two projects can end up look-alikes
    const takenFamilies = new Set(owned.map(family));
    const from = hatching ? babies : pool;

    const freshFamily = from.filter((id) => !takenFamilies.has(family(id)));
    const unowned = from.filter((id) => !owned.includes(id));
    // each rule gives way only when it has nothing left to offer
    const choices = freshFamily.length ? freshFamily : unowned.length ? unowned : from;
    const species = choices[Math.floor(rng() * choices.length)];
    if (hatching) draft.team.eggs--;

    const mon = {
      species,
      shiny: rng() < 1 / SHINY_ODDS,
      hatched: hatching,
      nickname: event.name.toUpperCase().slice(0, 10),
      project: event.project,
      joined: event.ts,
      level: START_LEVEL,
      xp: xpForLevel(START_LEVEL),
      friendship: FRIENDSHIP.base,
      sessions: 0, toolCalls: 0, testsGreen: 0, fixes: 0, commits: 0, merges: 0, cleanSessions: 0, trades: 0,
      days: [],
      evolutions: [],
    };
    draft.mons[event.project] = mon;
    ctx.out.push({ kind: hatching ? 'hatch' : 'join', agentId: event.project, species, shiny: mon.shiny });
    return mon;
  }

  const befriend = (mon, by) => { mon.friendship = Math.min(FRIENDSHIP.max, mon.friendship + by); };

  /** credit a day to the project and to you, and recount the streak if it is a new one */
  function markDay(ctx, project, mon) {
    const day = localDay(ctx.date);
    if (ctx.dayOf.get(project) === day) return; // already counted in this batch
    ctx.dayOf.set(project, day);

    if (!mon.days.includes(day)) {
      mon.days = [...mon.days, day];
      befriend(mon, FRIENDSHIP.day);
    }
    const team = ctx.state.team;
    if (team.days.includes(day)) return;
    team.days = [...team.days, day];
    const { current: streak, best } = streaks(team.days);
    team.daysActive = team.days.length;
    team.streak = streak;
    team.bestStreak = best;
  }

  function gainXp(ctx, project, amount) {
    const mon = ctx.state.mons[project];
    mon.xp += amount;
    const reached = levelFor(mon.xp);
    if (reached <= mon.level) return;
    while (mon.level < reached) {
      mon.level++;
      befriend(mon, FRIENDSHIP.level);
    }
    ctx.out.push({ kind: 'level', agentId: project, level: mon.level });
    tryEvolve(ctx, project, 'level');
  }

  function tryEvolve(ctx, project, trigger) {
    const mon = ctx.state.mons[project];
    const edge = findEvolution(pokedex, mon, { event: trigger, date: ctx.date, bag: ctx.state.team.bag });
    if (!edge) return false;

    const spent = edge.item ?? edge.heldItem;
    if (spent) ctx.state.team.bag[spent] -= 1;
    mon.evolutions = [...mon.evolutions, { from: mon.species, to: edge.to, trigger: edge.trigger, ...(spent && { item: spent }), ts: ctx.date.getTime() }];
    ctx.out.push({ kind: 'evolve', agentId: project, from: mon.species, to: edge.to, trigger: edge.trigger, ...(spent && { item: spent }) });
    mon.species = edge.to;
    return true;
  }

  /** every badge and achievement whose condition is now met, then any stone evolution they allow */
  function awardWhatIsEarned(ctx) {
    const team = ctx.state.team;
    const earn = (rule, into) => {
      into.push({ id: rule.id, ts: ctx.date.getTime(), agentId: ctx.credit });
      if (rule.item) team.bag[rule.item] = (team.bag[rule.item] ?? 0) + 1;
      if (rule.egg) team.eggs++;
      if (rule.unlock && !team.legendaries.includes(rule.unlock)) team.legendaries.push(rule.unlock);
      ctx.out.push({
        kind: into === team.badges ? 'badge' : 'achievement',
        id: rule.id, name: rule.name, why: rule.why, agentId: ctx.credit,
        ...(rule.item && { item: rule.item }),
        ...(rule.egg && { egg: true }),
        ...(rule.unlock && { legendary: rule.unlock }),
      });
    };

    const tally = () => ({ ...team, badges: team.badges.length });
    for (const badge of BADGES) if (!team.badges.some((b) => b.id === badge.id) && badge.test(tally())) earn(badge, team.badges);
    for (const extra of EXTRAS) if (!team.achievements.some((a) => a.id === extra.id) && extra.test(tally())) earn(extra, team.achievements);
    // a stone can take a Pokémon up two stages in one go, so keep going while it keeps evolving
    for (const project of Object.keys(ctx.state.mons).sort()) while (tryEvolve(ctx, project, 'item'));
  }

  return {
    apply,

    get state() { return current; },

    /**
     * One evolution family per project. Where two share one — rolled before the newer project
     * existed, or because the pool ran dry — the project that joined first keeps it and the newer
     * re-rolls to a free first stage, keeping its level, XP, friendship and counters. A project is
     * left alone when no free family remains. Idempotent, so it can run on every start.
     * @returns {Array<{project: string, from: number, to: number}>}
     */
    rerollSharedFamilies() {
      const draft = structuredClone(current);
      const inUse = new Set(Object.values(draft.mons).map((m) => family(m.species)));
      const claimed = new Set();
      const changed = [];
      const oldestFirst = Object.entries(draft.mons)
        .sort(([idA, a], [idB, b]) => (a.joined ?? 0) - (b.joined ?? 0) || (idA < idB ? -1 : 1));

      for (const [project, mon] of oldestFirst) {
        const line = family(mon.species);
        if (!claimed.has(line)) { claimed.add(line); continue; }
        const free = pool.filter((id) => !inUse.has(family(id)));
        if (!free.length) continue;
        const to = free[Math.floor(rng() * free.length)];
        mon.rerolled = { from: mon.species, to, ts: Date.now() };
        mon.species = to;
        inUse.add(family(to));
        claimed.add(family(to));
        changed.push({ project, from: mon.rerolled.from, to });
      }
      current = draft;
      return changed;
    },

    /** drop the projects `matches(id)` picks (throwaway folders); returns the ones that went */
    forget(matches) {
      const gone = Object.keys(current.mons).filter(matches);
      if (!gone.length) return [];
      const draft = structuredClone(current);
      for (const project of gone) delete draft.mons[project];
      current = draft;
      return gone;
    },

    /** dev only: overwrite fields of one Pokémon (the e2e and demo runs stage scenes with it) */
    patch(project, fields) {
      const draft = structuredClone(current);
      if (!draft.mons[project]) return false;
      Object.assign(draft.mons[project], fields);
      if (fields.level) draft.mons[project].xp = Math.max(draft.mons[project].xp, xpForLevel(fields.level));
      current = draft;
      return true;
    },

    /** dev only: put items in the bag and let the stone evolutions they allow fire */
    give(items) {
      const draft = structuredClone(current);
      for (const [item, n] of Object.entries(items)) draft.team.bag[item] = (draft.team.bag[item] ?? 0) + n;
      const ctx = { state: draft, out: [], credit: null, date: new Date() };
      for (const project of Object.keys(draft.mons).sort()) while (tryEvolve(ctx, project, 'item'));
      draft.recent = [...draft.recent, ...ctx.out].slice(-RECENT);
      current = draft;
      return ctx.out;
    },
  };
}

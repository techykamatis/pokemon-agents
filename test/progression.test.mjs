import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { createProgression, emptyState } from '../src/progression.mjs';
import { BADGES, familyOf, rollPool, xpForLevel } from '../src/rules.mjs';

const pokedex = JSON.parse(fs.readFileSync(new URL('./fixtures/pokedex-mini.json', import.meta.url)));
const pool = rollPool(pokedex);
const family = familyOf(pokedex);

const KIT = '/code/kit';
const on = (year, month, day, hour = 12) => new Date(year, month, day, hour).getTime();
const NOON = on(2026, 9, 12);
const ev = (kind, over = {}) => ({ kind, ts: NOON, project: KIT, name: 'kit', ...over });

/** an engine with one project, its species forced so the test can aim at a known evolution */
function withProject(species = 4, state) {
  const p = createProgression({ pokedex, state, rng: () => 0 });
  p.apply([ev('session')]);
  p.patch(KIT, { species });
  return { p, mon: () => p.state.mons[KIT], team: () => p.state.team };
}

describe('meeting a project', () => {
  it('rolls one first-stage Pokémon per project, and two projects never match', () => {
    const p = createProgression({ pokedex, rng: () => 0 });
    p.apply([ev('session'), ev('session', { project: '/code/wren', name: 'wren' }), ev('tool')]);
    const kit = p.state.mons[KIT];
    const wren = p.state.mons['/code/wren'];
    assert.ok(pool.includes(kit.species));
    assert.notEqual(kit.species, wren.species);
    assert.notEqual(family(kit.species), family(wren.species), 'nor do their families');
    assert.equal(kit.nickname, 'KIT');
    assert.equal(kit.project, KIT);
    assert.equal(kit.sessions, 1);
    assert.equal(kit.toolCalls, 1);
  });

  it('names a project after its folder, in ten capitals', () => {
    const p = createProgression({ pokedex, rng: () => 0 });
    p.apply([ev('session', { project: '/code/an-extremely-long-name', name: 'an-extremely-long-name' })]);
    assert.equal(p.state.mons['/code/an-extremely-long-name'].nickname, 'AN-EXTREME');
  });

  it('avoids a family that is already owned, even once its owner has evolved past it', () => {
    // kit is a Charmeleon, so Charmander's family is taken although no Charmander is on the books.
    const { p } = withProject(5);
    // Own everything the roll would reach before Charmander, so a check that only compared species
    // would hand out Charmander next. Picking anything else is the family rule doing the work.
    const before = pool.slice(0, pool.indexOf(4));
    for (const [i, species] of before.entries()) {
      p.apply([ev('session', { project: `/code/other${i}`, name: `other${i}` })]);
      p.patch(`/code/other${i}`, { species });
    }
    p.apply([ev('session', { project: '/code/wren', name: 'wren' })]);
    const wren = p.state.mons['/code/wren'];
    assert.notEqual(wren.species, 4, 'Charmander would have been next if only species were compared');
    assert.notEqual(family(wren.species), 4);
  });

  it('once every family is taken it reuses one rather than leaving a project blank', () => {
    const { p } = withProject(5);
    for (const [i, species] of pool.filter((id) => id !== 4).entries()) {
      p.apply([ev('session', { project: `/code/other${i}`, name: `other${i}` })]);
      p.patch(`/code/other${i}`, { species });
    }
    p.apply([ev('session', { project: '/code/wren', name: 'wren' })]);
    const wren = p.state.mons['/code/wren'];
    assert.ok(wren, 'a project always gets someone');
    assert.equal(wren.species, 4, 'the last unowned species, family clash and all');
    // which is exactly what rerollSharedFamilies is for, on the next start
    assert.deepEqual(p.rerollSharedFamilies(), [], 'though with nothing free, it leaves it be');
  });

  it('a waiting Egg hatches the next new project as a baby, and is spent', () => {
    const start = emptyState();
    const p = createProgression({ pokedex, rng: () => 0, state: { ...start, team: { ...start.team, eggs: 1 } } });
    const [first] = p.apply([ev('session')]);
    assert.equal(first.kind, 'hatch');
    assert.ok(pokedex.species.find((s) => s.id === first.species).isBaby);
    assert.equal(p.state.team.eggs, 0);
    const [next] = p.apply([ev('session', { project: '/code/wren', name: 'wren' })]);
    assert.equal(next.kind, 'join', 'the Egg is gone, so the next one is rolled normally');
  });

  it('shines one project in 8192', () => {
    const lucky = createProgression({ pokedex, rng: () => 0.00001 });
    assert.equal(lucky.apply([ev('session')])[0].shiny, true);
    const ordinary = createProgression({ pokedex, rng: () => 0.5 });
    assert.equal(ordinary.apply([ev('session')])[0].shiny, false);
  });

  it('events with no project at all are ignored', () => {
    const p = createProgression({ pokedex, rng: () => 0 });
    p.apply([ev('session', { project: 'unknown' }), ev('session', { project: '' })]);
    assert.deepEqual(Object.keys(p.state.mons), []);
  });
});

describe('what the work adds up to', () => {
  it('counts for the project and for you at the same time', () => {
    const { p, mon, team } = withProject();
    p.apply([ev('tool'), ev('tool'), ev('test'), ev('commit'), ev('merge'), ev('clean'), ev('fix')]);
    assert.equal(mon().toolCalls, 2);
    assert.equal(mon().commits, 1);
    assert.equal(team().toolCalls, 2);
    assert.equal(team().merges, 1);
    assert.equal(team().cleanSessions, 1);
    assert.equal(team().fixes, 1);
  });

  it('grows friendship by showing up, committing and levelling, and caps it', () => {
    const { p, mon } = withProject();
    const started = mon().friendship;
    p.apply([ev('commit')]);
    assert.ok(mon().friendship > started);
    p.patch(KIT, { friendship: 254 });
    p.apply([ev('commit', { ts: on(2026, 9, 13) })]);
    assert.equal(mon().friendship, 255, 'friendship stops at 255');
  });

  it('counts a day once per project however much happens in it', () => {
    const { p, mon, team } = withProject();
    p.apply([ev('tool'), ev('tool'), ev('commit')]);
    assert.equal(mon().days.length, 1);
    p.apply([ev('tool', { ts: on(2026, 9, 13) })]);
    assert.deepEqual(mon().days, ['2026-10-12', '2026-10-13']);
    assert.equal(team().daysActive, 2);
  });

  it('reads the same whichever order a backfill happens to deliver the days in', () => {
    const week = [5, 1, 3, 2, 4, 7, 6].map((day) => ev('tool', { ts: on(2026, 9, day) }));
    const forwards = createProgression({ pokedex, rng: () => 0 });
    forwards.apply(week);
    const backwards = createProgression({ pokedex, rng: () => 0 });
    backwards.apply([...week].reverse());
    assert.equal(forwards.state.team.bestStreak, 7);
    assert.deepEqual(
      [forwards.state.team.daysActive, forwards.state.team.bestStreak],
      [backwards.state.team.daysActive, backwards.state.team.bestStreak],
    );
    assert.ok(forwards.state.team.badges.some((b) => b.id === 'storm'), 'a seven-day run is the STORMBADGE');
  });

  it('a single gain that crosses two levels is announced once, at the level reached', () => {
    const { p, mon } = withProject(1);
    p.patch(KIT, { level: 5 });
    p.patch(KIT, { xp: xpForLevel(7) - 1 }); // one merge is worth more than the two levels left
    const out = p.apply([ev('merge')]);
    const levels = out.filter((e) => e.kind === 'level');
    assert.equal(levels.length, 1, 'one announcement, not one per level');
    assert.equal(levels[0].level, 7);
    assert.equal(mon().level, 7);
  });

  it('two separate gains that each cross a level are announced each time', () => {
    const { p } = withProject(1);
    p.patch(KIT, { level: 5 });
    p.patch(KIT, { xp: xpForLevel(6) - 2 });
    const levels = p.apply([ev('merge'), ev('merge')]).filter((e) => e.kind === 'level');
    assert.deepEqual(levels.map((e) => e.level), [6, 7]);
  });

  it('survives a trip through JSON, which is how it is stored', () => {
    const { p } = withProject();
    p.apply([ev('tool'), ev('tool')]);
    const reloaded = createProgression({ pokedex, state: JSON.parse(JSON.stringify(p.state)), rng: () => 0 });
    reloaded.apply([ev('tool')]);
    assert.equal(reloaded.state.mons[KIT].toolCalls, 3);
    assert.equal(reloaded.state.mons[KIT].species, 4, 'and keeps the Pokémon it rolled');
  });

  it('leaves the previous state untouched when applying a batch throws', () => {
    const { p } = withProject();
    p.apply([ev('tool')]);
    const before = JSON.stringify(p.state);
    assert.throws(() => p.apply([ev('tool'), null]));
    assert.equal(JSON.stringify(p.state), before, 'no half-applied batch');
  });
});

describe('evolving', () => {
  it('on a level: Charmander at 16', () => {
    const { p, mon } = withProject(4);
    p.patch(KIT, { level: 15, xp: xpForLevel(16) - 2 });
    const out = p.apply([ev('tool')]);
    assert.deepEqual(out.find((e) => e.kind === 'evolve'), { kind: 'evolve', agentId: KIT, from: 4, to: 5, trigger: 'level-up' });
    assert.equal(mon().species, 5);
    assert.equal(mon().evolutions.length, 1);
    assert.equal(mon().evolutions[0].to, 5);
  });

  it('on friendship: Pichu, but not before it trusts you', () => {
    const { p, mon } = withProject(172);
    p.patch(KIT, { friendship: 200, xp: xpForLevel(6) - 2 });
    p.apply([ev('tool')]);
    assert.equal(mon().species, 172, 'levelling alone is not enough');
    p.patch(KIT, { friendship: 230, xp: xpForLevel(7) - 2 });
    p.apply([ev('tool')]);
    assert.equal(mon().species, 25);
  });

  it('by the hour the work happened at, not the hour it was read', () => {
    for (const [hour, expected] of [[12, 196], [23, 197]]) {
      const { p, mon } = withProject(133);
      p.patch(KIT, { friendship: 200, xp: xpForLevel(6) - 2 });
      p.apply([ev('tool', { ts: on(2026, 9, 12, hour) })]);
      assert.equal(mon().species, expected);
    }
  });

  it('on a stone the badge paid out: the first commit turns a Clefairy into Clefable', () => {
    const { p } = withProject(4);
    p.apply([ev('session', { project: '/code/wren', name: 'wren' })]);
    p.patch('/code/wren', { species: 35 });
    p.apply([ev('commit')]);
    assert.ok(p.state.team.badges.some((b) => b.id === 'zephyr'));
    assert.equal(p.state.mons['/code/wren'].species, 36);
    assert.equal(p.state.team.bag['moon-stone'], 0, 'the stone was spent');
  });

  it('on a handoff: Kadabra, once a subagent takes over', () => {
    const { p, mon } = withProject(64);
    const out = p.apply([ev('subagent')]);
    assert.ok(out.some((e) => e.kind === 'trade'));
    assert.equal(mon().species, 65);
  });

  it('on a handoff with a held item: Onix waits for a Metal Coat', () => {
    const { p, mon } = withProject(95);
    p.apply([ev('subagent')]);
    assert.equal(mon().species, 95, 'no Metal Coat, no Steelix');
    p.give({ 'metal-coat': 1 });
    p.apply([ev('subagent')]);
    assert.equal(mon().species, 208);
  });
});

describe('badges', () => {
  it('a red test fixed in the same session earns PLAINBADGE and releases Raikou', () => {
    const { p, team } = withProject();
    const out = p.apply([ev('fix')]);
    assert.ok(team().badges.some((b) => b.id === 'plain'));
    assert.ok(team().legendaries.includes(243));
    const badge = out.find((e) => e.kind === 'badge' && e.id === 'plain');
    assert.equal(badge.legendary, 243);
    assert.equal(badge.agentId, KIT, 'credited to whichever project earned it');
  });

  it('a clean session earns GLACIERBADGE', () => {
    const { p, team } = withProject();
    p.apply([ev('clean')]);
    assert.ok(team().badges.some((b) => b.id === 'glacier'));
  });

  it('earns each badge once, however often the condition stays true', () => {
    const { p, team } = withProject();
    p.apply([ev('commit')]);
    p.apply([ev('commit')]);
    p.apply([ev('commit')]);
    assert.equal(team().badges.filter((b) => b.id === 'zephyr').length, 1);
    assert.equal(team().bag['moon-stone'], 1, 'and pays out its item once');
  });

  it('all eight badges make you CHAMPION, which releases Ho-Oh', () => {
    const { p, team } = withProject();
    p.apply([
      ev('commit'), ev('merge'), ev('fix'), ev('clean'),
      ...Array.from({ length: 10 }, () => ev('test')),
      ...Array.from({ length: 100 }, () => ev('commit')),
      ...Array.from({ length: 100 }, () => ev('session')),
      ...[1, 2, 3, 4, 5, 6, 7].map((day) => ev('tool', { ts: on(2026, 9, day) })),
    ]);
    assert.equal(team().badges.length, 8, team().badges.map((b) => b.id).join(','));
    assert.ok(team().achievements.some((a) => a.id === 'champion'));
    assert.ok(team().legendaries.includes(250));
  });
});

describe('housekeeping', () => {
  it('re-rolls the newer of two look-alike projects, keeping everything it has earned', () => {
    const p = createProgression({ pokedex, rng: () => 0 });
    p.apply([ev('session'), ev('session', { ts: NOON + 1000, project: '/code/wren', name: 'wren' })]);
    p.patch(KIT, { species: 5 }); // Charmeleon
    p.patch('/code/wren', { species: 4, level: 30 }); // Charmander: the same family
    const before = { ...p.state.mons['/code/wren'] };

    const changed = p.rerollSharedFamilies();
    const wren = p.state.mons['/code/wren'];
    assert.deepEqual(changed.map((c) => c.project), ['/code/wren'], 'the older project keeps its Pokémon');
    assert.equal(p.state.mons[KIT].species, 5);
    assert.notEqual(family(wren.species), family(4));
    assert.ok(pool.includes(wren.species));
    assert.equal(wren.level, before.level);
    assert.equal(wren.xp, before.xp);
    assert.deepEqual(wren.rerolled, { from: 4, to: wren.species, ts: wren.rerolled.ts });
    assert.deepEqual(p.rerollSharedFamilies(), [], 'and running it again changes nothing');
  });

  it('forgets the projects it is told to, and reports which', () => {
    const p = createProgression({ pokedex, rng: () => 0 });
    p.apply([ev('session'), ev('session', { project: '/tmp/throwaway', name: 'throwaway' })]);
    assert.deepEqual(p.forget((id) => id.startsWith('/tmp/')), ['/tmp/throwaway']);
    assert.deepEqual(Object.keys(p.state.mons), [KIT]);
    assert.deepEqual(p.forget(() => false), [], 'nothing to forget, nothing written');
  });

  it('keeps only the last few milestones on the state, for a page that has just connected', () => {
    const { p } = withProject(1);
    for (let i = 0; i < 60; i++) p.apply([ev('merge')]);
    assert.ok(p.state.recent.length <= 30);
  });

  it('patch refuses a project it has never met', () => {
    const { p } = withProject();
    assert.equal(p.patch('/code/nobody', { level: 50 }), false);
  });
});

const REAL_POKEDEX = new URL('../.cache/assets/pokedex.json', import.meta.url);
describe('against the real Pokédex', { skip: !fs.existsSync(REAL_POKEDEX) && 'assets not fetched: run npm run setup' }, () => {
  const real = fs.existsSync(REAL_POKEDEX) ? JSON.parse(fs.readFileSync(REAL_POKEDEX)) : null;

  it('covers #1-251', () => {
    assert.equal(real.species.length, 251);
    assert.equal(real.species.at(-1).id, 251);
  });

  it('every species that evolves from something has a rule that reaches it', () => {
    const reachable = new Set(real.evolutions.map((e) => e.to));
    for (const s of real.species) {
      if (s.evolvesFrom) assert.ok(reachable.has(s.id), `${s.slug} can never be reached`);
    }
  });

  it('every item an evolution asks for is one you can actually earn', () => {
    const earnable = new Set([...BADGES.map((b) => b.item), 'sun-stone', 'up-grade'].filter(Boolean));
    for (const item of new Set(real.evolutions.flatMap((e) => [e.item, e.heldItem]).filter(Boolean))) {
      assert.ok(earnable.has(item), `${item} is needed but cannot be earned`);
    }
  });

  it('rolls a believable starting Pokémon for a brand-new project', () => {
    const p = createProgression({ pokedex: real });
    const [joined] = p.apply([ev('session')]);
    assert.equal(joined.kind, 'join');
    const species = real.species.find((s) => s.id === joined.species);
    assert.ok(!species.isLegendary && !species.isMythical && !species.isBaby, species.slug);
  });
});

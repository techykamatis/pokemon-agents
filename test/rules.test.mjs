import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { BADGES, EXTRAS, babyPool, familyOf, findEvolution, levelFor, localDay, nextDay, rollPool, streaks, timeOfDay, xpForLevel } from '../src/rules.mjs';

const pokedex = JSON.parse(fs.readFileSync(new URL('./fixtures/pokedex-mini.json', import.meta.url)));
const DAYTIME = new Date(2026, 9, 12, 12);
const mon = (over = {}) => ({ species: 133, level: 20, friendship: 70, commits: 0, testsGreen: 0, ...over });
const bag = {};

describe('the curve', () => {
  it('a level is the cube root of total XP, Gen 2 medium fast', () => {
    assert.equal(levelFor(xpForLevel(16)), 16);
    assert.equal(levelFor(xpForLevel(16) - 1), 15, 'one XP short is one level short');
    assert.equal(levelFor(0), 1);
    assert.equal(levelFor(10 ** 9), 100, 'and it stops at 100');
  });
});

describe('the clock', () => {
  it('buckets the hours the way Gen 2 does', () => {
    assert.equal(timeOfDay(new Date(2026, 0, 1, 4)), 'morn');
    assert.equal(timeOfDay(new Date(2026, 0, 1, 9, 59)), 'morn');
    assert.equal(timeOfDay(new Date(2026, 0, 1, 10)), 'day');
    assert.equal(timeOfDay(new Date(2026, 0, 1, 17, 59)), 'day');
    assert.equal(timeOfDay(new Date(2026, 0, 1, 18)), 'nite');
    assert.equal(timeOfDay(new Date(2026, 0, 1, 3, 59)), 'nite');
  });

  it('a day is a local calendar day, and the next one rolls months and years over', () => {
    assert.equal(localDay(new Date(2026, 0, 9)), '2026-01-09');
    assert.equal(nextDay('2026-01-31'), '2026-02-01');
    assert.equal(nextDay('2026-12-31'), '2027-01-01');
    assert.equal(nextDay('2028-02-28'), '2028-02-29', 'leap years included');
  });

  it('streaks come out of a set of days, whatever order they arrive in', () => {
    const days = ['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-05'];
    assert.deepEqual(streaks(days), { current: 1, best: 3 });
    assert.deepEqual(streaks([...days].reverse()), { current: 1, best: 3 });
    assert.deepEqual(streaks(['2026-10-01', '2026-10-01']), { current: 1, best: 1 }, 'a day counts once');
    assert.deepEqual(streaks([]), { current: 0, best: 0 });
  });
});

describe('who a new project can be', () => {
  it('the roll pool is first stages only: no babies, legendaries or mythicals, nothing mid-chain', () => {
    const pool = rollPool(pokedex);
    assert.ok(pool.includes(4), 'Charmander is a first stage');
    assert.ok(pool.includes(25), 'Pikachu counts: its only pre-evolution is a baby');
    assert.ok(!pool.includes(5), 'Charmeleon is mid-chain');
    assert.ok(!pool.includes(172), 'Pichu is a baby, and hatches from an Egg instead');
    assert.ok(!pool.includes(243), 'Raikou is legendary');
    assert.ok(!pool.includes(151), 'Mew is mythical');
  });

  it('an Egg hatches babies and nothing else', () => {
    assert.deepEqual(babyPool(pokedex).sort((a, b) => a - b), [172, 173, 236]);
  });

  it('a family is named by its first stage, baby included', () => {
    const family = familyOf(pokedex);
    assert.equal(family(6), 4, 'Charizard belongs to Charmander');
    assert.equal(family(26), 172, 'Raichu goes all the way back to Pichu');
    assert.equal(family(237), 236);
    assert.equal(family(1), 1);
    assert.equal(family(999), 999, 'an id it has never heard of is its own family');
  });
});

describe('when an evolution may fire', () => {
  it('a level rule needs the level, and only fires on a level-up', () => {
    assert.equal(findEvolution(pokedex, mon({ species: 4, level: 15 }), { event: 'level', date: DAYTIME, bag }), null);
    assert.equal(findEvolution(pokedex, mon({ species: 4, level: 16 }), { event: 'level', date: DAYTIME, bag }).to, 5);
    assert.equal(findEvolution(pokedex, mon({ species: 4, level: 40 }), { event: 'trade', date: DAYTIME, bag }), null, 'a trade is not a level-up');
  });

  it('a friendship rule needs the friendship', () => {
    assert.equal(findEvolution(pokedex, mon({ species: 172, friendship: 219 }), { event: 'level', date: DAYTIME, bag }), null);
    assert.equal(findEvolution(pokedex, mon({ species: 172, friendship: 220 }), { event: 'level', date: DAYTIME, bag }).to, 25);
  });

  it('time of day splits Espeon from Umbreon', () => {
    const friendly = mon({ species: 133, friendship: 200 });
    const byTime = (hour) => findEvolution(pokedex, friendly, { event: 'level', date: new Date(2026, 9, 12, hour), bag }).to;
    assert.equal(byTime(12), 196, 'daytime: Espeon');
    assert.equal(byTime(6), 196, "Gen 2's morning counts as day");
    assert.equal(byTime(23), 197, 'night: Umbreon');
  });

  it('a stone has to be in the bag, and then works at any hour', () => {
    assert.equal(findEvolution(pokedex, mon({ species: 25 }), { event: 'item', date: DAYTIME, bag: {} }), null);
    assert.equal(findEvolution(pokedex, mon({ species: 25 }), { event: 'item', date: DAYTIME, bag: { 'thunder-stone': 1 } }).to, 26);
    assert.equal(findEvolution(pokedex, mon({ species: 25 }), { event: 'item', date: DAYTIME, bag: { 'thunder-stone': 0 } }), null, 'one already spent is no use');
  });

  it('a trade rule can want a held item', () => {
    assert.equal(findEvolution(pokedex, mon({ species: 64 }), { event: 'trade', date: DAYTIME, bag }).to, 65);
    assert.equal(findEvolution(pokedex, mon({ species: 95 }), { event: 'trade', date: DAYTIME, bag: {} }), null);
    assert.equal(findEvolution(pokedex, mon({ species: 95 }), { event: 'trade', date: DAYTIME, bag: { 'metal-coat': 1 } }).to, 208);
  });

  it("Tyrogue reads commits as Attack and green tests as Defense", () => {
    const pick = (commits, testsGreen) => findEvolution(pokedex, mon({ species: 236, commits, testsGreen }), { event: 'level', date: DAYTIME, bag }).to;
    assert.equal(pick(3, 1), 106, 'shipping more than you verify: Hitmonlee');
    assert.equal(pick(1, 3), 107, 'verifying more than you ship: Hitmonchan');
    assert.equal(pick(2, 2), 237, 'even: Hitmontop');
  });

  it('a Pokémon with nowhere left to go stays put', () => {
    assert.equal(findEvolution(pokedex, mon({ species: 6, level: 100 }), { event: 'level', date: DAYTIME, bag }), null);
  });
});

describe('the badge table', () => {
  it('eight badges, each with a unique id and an item to show for it', () => {
    assert.equal(BADGES.length, 8);
    assert.equal(new Set(BADGES.map((b) => b.id)).size, 8);
    assert.ok(BADGES.every((b) => b.item), 'every badge pays out something for the bag');
    assert.ok(BADGES.every((b) => b.name && b.why));
  });

  it('no id is used twice across badges and achievements', () => {
    const ids = [...BADGES, ...EXTRAS].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('the four roaming legendaries are each released by exactly one rule', () => {
    const unlocks = [...BADGES, ...EXTRAS].map((r) => r.unlock).filter(Boolean);
    assert.deepEqual(unlocks.sort((a, b) => a - b), [243, 244, 245, 249, 250, 251]);
    assert.equal(new Set(unlocks).size, unlocks.length);
  });

  it('every rule fires on the tally it claims to, and not before', () => {
    const none = { commits: 0, testsGreen: 0, fixes: 0, merges: 0, bestStreak: 0, cleanSessions: 0, sessions: 0, toolCalls: 0, daysActive: 0, badges: 0 };
    assert.deepEqual(BADGES.filter((b) => b.test(none)), [], 'a fresh trainer has earned nothing');
    assert.deepEqual(EXTRAS.filter((e) => e.test(none)), []);
    assert.ok(BADGES.find((b) => b.id === 'zephyr').test({ ...none, commits: 1 }));
    assert.ok(!BADGES.find((b) => b.id === 'mineral').test({ ...none, commits: 99 }));
    assert.ok(BADGES.find((b) => b.id === 'mineral').test({ ...none, commits: 100 }));
    assert.ok(EXTRAS.find((e) => e.id === 'champion').test({ ...none, badges: 8 }));
  });
});

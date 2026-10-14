import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignLooks } from '../src/roster.mjs';
import { familyOf } from '../src/rules.mjs';

// a tiny dex: one three-stage family (1-2-3), one two-stage (4-5), fifteen singles, one legendary
const species = [
  { id: 1, evolvesFrom: null }, { id: 2, evolvesFrom: 1 }, { id: 3, evolvesFrom: 2 },
  { id: 4, evolvesFrom: null }, { id: 5, evolvesFrom: 4 },
  ...Array.from({ length: 15 }, (_, i) => ({ id: 6 + i, evolvesFrom: null })),
  { id: 99, evolvesFrom: null, isLegendary: true },
].map((s) => ({ isBaby: false, isLegendary: false, isMythical: false, ...s }));
const pokedex = { species, evolutions: [] };
const family = familyOf(pokedex);

const S = (id, project, status = 'working', lastTs = 0) => ({ id, project, status, lastTs });
const lookMap = (out) => Object.fromEntries(out.map((s) => [s.id, s.look]));

describe('who leads a project', () => {
  it('the session you most need to look at wears the project Pokémon', () => {
    const mons = { '/a': { species: 2 }, '/b': { species: 4 } };
    const out = assignLooks([S('s1', '/a', 'done', 5), S('s2', '/a', 'waiting', 1), S('s3', '/a', 'idle', 9), S('s4', '/b')], mons, pokedex);
    const look = lookMap(out);
    assert.equal(look.s2, 2, 'the one that needs you leads, however stale it looks');
    assert.equal(look.s4, 4, 'and each project leads separately');
  });

  it('with nothing to choose between them, the most recent leads', () => {
    const mons = { '/a': { species: 6 } };
    const look = lookMap(assignLooks([S('s1', '/a', 'working', 10), S('s2', '/a', 'working', 99)], mons, pokedex));
    assert.equal(look.s2, 6);
    assert.notEqual(look.s1, 6);
  });

  it('a project with no Pokémon yet has no look to give', () => {
    const look = lookMap(assignLooks([S('s1', '/unknown')], {}, pokedex));
    assert.equal(look.s1, null);
  });
});

describe('stand-ins', () => {
  it('are all different, and avoid both owned species and families already on screen', () => {
    const mons = { '/a': { species: 2 }, '/b': { species: 4 } };
    const out = assignLooks([S('s1', '/a', 'done', 5), S('s2', '/a', 'waiting', 1), S('s3', '/a', 'idle', 9), S('s4', '/b')], mons, pokedex);
    const looks = out.map((s) => s.look);
    assert.equal(new Set(looks).size, looks.length, 'no two sessions look alike');
    assert.equal(new Set(looks.map(family)).size, looks.length, 'nor do any two families');
    for (const id of ['s1', 's3']) {
      assert.ok(![1, 2, 3, 4, 5].includes(lookMap(out)[id]), 'a stand-in avoids an owned family entirely');
    }
  });

  it('never hand out a legendary: those are earned', () => {
    const mons = { '/a': { species: 6 } };
    const many = Array.from({ length: 19 }, (_, i) => S(`m${i}`, '/a'));
    assert.ok(!assignLooks(many, mons, pokedex).some((s) => s.look === 99));
  });

  it('hold still: the same map gives the same answer whatever order it arrives in', () => {
    const mons = { '/a': { species: 6 } };
    const sessions = [S('x1', '/a'), S('x2', '/a'), S('x3', '/a')];
    const forwards = lookMap(assignLooks(sessions, mons, pokedex));
    const backwards = lookMap(assignLooks([...sessions].reverse(), mons, pokedex));
    assert.deepEqual(forwards, backwards);
  });

  it('use every species once before repeating any', () => {
    const mons = { '/a': { species: 1 } };
    const crowd = Array.from({ length: 25 }, (_, i) => S(`m${i}`, '/a'));
    const looks = assignLooks(crowd, mons, pokedex).map((s) => s.look);
    assert.equal(new Set(looks).size, 20, 'twenty species are available, and all twenty get used');
  });
});

describe('sessions off the map', () => {
  it('a resting session keeps its own project Pokémon and takes no stand-in', () => {
    const mons = { '/a': { species: 6 } };
    const out = assignLooks([S('x1', '/a'), S('x2', '/a'), S('x3', '/a', 'resting')], mons, pokedex);
    assert.equal(out.find((s) => s.id === 'x3').look, 6);
  });

  it('a resting session does not take a look away from one that is out', () => {
    const mons = { '/a': { species: 6 }, '/b': { species: 7 } };
    const out = assignLooks([S('r', '/a', 'resting'), S('w', '/b')], mons, pokedex);
    assert.equal(lookMap(out).w, 7, 'the live one still leads its own project');
  });
});

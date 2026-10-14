import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_ID, buildPokedex } from '../src/build/pokedex.mjs';

// the shape of a PokeAPI pokemon-species response, cut down to the fields the build reads
const species = (id, name, over = {}) => ({
  id,
  name,
  names: [{ language: { name: 'ja' }, name: 'ジャ' }, { language: { name: 'en' }, name }],
  genera: [{ language: { name: 'en' }, genus: 'Test Pokémon' }],
  flavor_text_entries: [
    { language: { name: 'en' }, version: { name: 'gold' }, flavor_text: 'The Gold entry.' },
    { language: { name: 'en' }, version: { name: 'crystal' }, flavor_text: 'The  Crystal\nentry.' },
  ],
  is_baby: false,
  is_legendary: false,
  is_mythical: false,
  evolves_from_species: null,
  evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/1/' },
  ...over,
});
const url = (id) => `https://pokeapi.co/api/v2/pokemon-species/${id}/`;
const node = (id, to = []) => ({ species: { url: url(id) }, evolves_to: to });
const detail = (over = {}) => ({
  trigger: { name: 'level-up' },
  min_level: null,
  min_happiness: null,
  time_of_day: '',
  item: null,
  held_item: null,
  relative_physical_stats: null,
  version_group: { name: 'crystal' },
  is_default: true,
  ...over,
});
const chain = (root) => ({ chain: root });

describe('species', () => {
  it('keeps the English name, the Crystal entry and the flags progression needs', () => {
    const { species: out } = buildPokedex([species(1, 'bulbasaur')], []);
    assert.deepEqual(out[0], {
      id: 1,
      slug: 'bulbasaur',
      name: 'bulbasaur',
      isBaby: false,
      isLegendary: false,
      isMythical: false,
      evolvesFrom: null,
      genus: 'Test Pokémon',
      flavor: 'The Crystal entry.', // whitespace and the hard line break squashed for the GB font
    });
  });

  it('sorts by number and drops anything past Celebi', () => {
    const { species: out } = buildPokedex([species(251, 'celebi'), species(252, 'treecko'), species(4, 'charmander')], []);
    assert.deepEqual(out.map((s) => s.id), [4, 251]);
    assert.equal(MAX_ID, 251);
  });

  it('forgets a pre-evolution from a later generation, so a Gen 2 first stage stays one', () => {
    // Snorlax evolves from Munchlax (#446) in Gen 4; in Johto it is where the family starts
    const { species: out } = buildPokedex([species(143, 'snorlax', { evolves_from_species: { url: url(446) } })], []);
    assert.equal(out[0].evolvesFrom, null);
  });

  it('keeps a pre-evolution that is inside Gen 1-2', () => {
    const { species: out } = buildPokedex([species(25, 'pikachu', { evolves_from_species: { url: url(172) } })], []);
    assert.equal(out[0].evolvesFrom, 172);
  });

  it('copes with a species that has no English entry for Crystal', () => {
    const { species: out } = buildPokedex([species(1, 'bulbasaur', { flavor_text_entries: [], genera: [] })], []);
    assert.equal(out[0].flavor, '');
    assert.equal(out[0].genus, undefined);
  });
});

describe('evolutions', () => {
  it('keeps level, happiness, time of day, items and relative stats', () => {
    const tyrogue = chain(node(236, [
      { species: { url: url(106) }, evolves_to: [], evolution_details: [detail({ min_level: 20, relative_physical_stats: 1 })] },
      { species: { url: url(107) }, evolves_to: [], evolution_details: [detail({ min_level: 20, relative_physical_stats: -1 })] },
    ]));
    const eevee = chain(node(133, [
      { species: { url: url(196) }, evolves_to: [], evolution_details: [detail({ min_happiness: 160, time_of_day: 'day' })] },
      { species: { url: url(134) }, evolves_to: [], evolution_details: [detail({ trigger: { name: 'use-item' }, item: { name: 'water-stone' } })] },
    ]));
    const onix = chain(node(95, [
      { species: { url: url(208) }, evolves_to: [], evolution_details: [detail({ trigger: { name: 'trade' }, held_item: { name: 'metal-coat' } })] },
    ]));

    const { evolutions } = buildPokedex([], [tyrogue, eevee, onix]);
    const edge = (from, to) => evolutions.find((e) => e.from === from && e.to === to);
    assert.deepEqual(edge(236, 106), { from: 236, to: 106, trigger: 'level-up', minLevel: 20, relativePhysicalStats: 1 });
    assert.deepEqual(edge(236, 107).relativePhysicalStats, -1);
    assert.deepEqual(edge(133, 196), { from: 133, to: 196, trigger: 'level-up', minHappiness: 160, timeOfDay: 'day' });
    assert.deepEqual(edge(133, 134), { from: 133, to: 134, trigger: 'use-item', item: 'water-stone' });
    assert.deepEqual(edge(95, 208), { from: 95, to: 208, trigger: 'trade', heldItem: 'metal-coat' });
  });

  it('prefers the Gen 1-2 wording when PokeAPI lists the same evolution several times', () => {
    const many = chain(node(133, [{
      species: { url: url(196) },
      evolves_to: [],
      evolution_details: [
        detail({ version_group: { name: 'sun-moon' }, min_happiness: 160, time_of_day: 'day', is_default: true }),
        detail({ version_group: { name: 'gold-silver' }, min_happiness: 220, time_of_day: 'day', is_default: false }),
      ],
    }]));
    assert.equal(buildPokedex([], [many]).evolutions[0].minHappiness, 220, 'Gold and Silver wanted more friendship');
  });

  it('falls back to the default rule, then to whatever is usable', () => {
    const modern = chain(node(133, [{
      species: { url: url(470) },
      evolves_to: [],
      evolution_details: [
        detail({ version_group: { name: 'platinum' }, min_level: 30, is_default: false }),
        detail({ version_group: { name: 'sun-moon' }, min_level: 25, is_default: true }),
      ],
    }]));
    // the target is past Celebi so it is dropped, but the pick must not have thrown on the way
    assert.deepEqual(buildPokedex([], [modern]).evolutions, []);
  });

  it('drops a rule this game cannot represent, such as one needing a location', () => {
    const location = chain(node(95, [{
      species: { url: url(208) },
      evolves_to: [],
      evolution_details: [detail({ trigger: { name: 'level-up-at-magnetic-field' } })],
    }]));
    assert.deepEqual(buildPokedex([], [location]).evolutions, []);
  });

  it('a dropped edge does not cut off the rest of its chain', () => {
    // a middle stage with an unrepresentable rule still has its own evolution read
    const broken = chain(node(63, [{
      species: { url: url(64) },
      evolves_to: [{ species: { url: url(65) }, evolves_to: [], evolution_details: [detail({ trigger: { name: 'trade' } })] }],
      evolution_details: [detail({ trigger: { name: 'spin' } })],
    }]));
    assert.deepEqual(buildPokedex([], [broken]).evolutions, [{ from: 64, to: 65, trigger: 'trade' }]);
  });

  it('keeps one edge per pair, however many chains mention it', () => {
    const once = chain(node(4, [{ species: { url: url(5) }, evolves_to: [], evolution_details: [detail({ min_level: 16 })] }]));
    const { evolutions } = buildPokedex([], [once, once]);
    assert.equal(evolutions.length, 1);
  });
});

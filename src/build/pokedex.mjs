// Reduces raw PokeAPI species and evolution-chain JSON down to the Gen 1-2 Pokédex the game needs:
// 251 species with the few flags progression cares about, and one evolution edge per pair.
// Run once by `npm run setup`; the result is written to .cache/assets/pokedex.json.
export const MAX_ID = 251; // Celebi, the end of Johto

/** the version groups whose evolution rules are the Gen 1-2 ones, best first */
const CLASSIC_VERSIONS = ['red-blue', 'yellow', 'gold-silver', 'crystal'];

/** the triggers this game can represent: a level gained, a stone used, a handoff to a subagent */
export const TRIGGERS = ['level-up', 'use-item', 'trade'];

const idFromUrl = (url) => Number(url.split('/').filter(Boolean).pop());
const inEnglish = (entries, field) => entries?.find((e) => e.language.name === 'en')?.[field];

/**
 * PokeAPI often lists the same evolution several times, once per version group. Take the Gen 1-2
 * wording where there is one, then the default, then whatever is left.
 */
function pickRule(details) {
  const usable = details.filter((d) => TRIGGERS.includes(d.trigger?.name));
  return usable.find((d) => CLASSIC_VERSIONS.includes(d.version_group?.name))
    ?? usable.find((d) => d.is_default)
    ?? usable[0];
}

/** walk one evolution chain depth-first, keeping the edges that stay inside Gen 1-2 */
function collectEdges(node, out) {
  const from = idFromUrl(node.species.url);
  for (const next of node.evolves_to) {
    const to = idFromUrl(next.species.url);
    const rule = pickRule(next.evolution_details);
    if (rule && from <= MAX_ID && to <= MAX_ID) {
      out.push({
        from,
        to,
        trigger: rule.trigger.name,
        ...(rule.min_level != null && { minLevel: rule.min_level }),
        ...(rule.min_happiness != null && { minHappiness: rule.min_happiness }),
        ...(rule.time_of_day && { timeOfDay: rule.time_of_day }),
        ...(rule.item && { item: rule.item.name }),
        ...(rule.held_item && { heldItem: rule.held_item.name }),
        ...(rule.relative_physical_stats != null && { relativePhysicalStats: rule.relative_physical_stats }),
      });
    }
    collectEdges(next, out); // keep walking: a dropped edge does not cut off the rest of the chain
  }
  return out;
}

/**
 * @param {object[]} speciesJson  one pokemon-species response per id
 * @param {object[]} chainJson    one evolution-chain response per chain
 * @returns {{species: object[], evolutions: object[]}}
 */
export function buildPokedex(speciesJson, chainJson) {
  const species = speciesJson
    .filter((s) => s.id <= MAX_ID)
    .map((s) => ({
      id: s.id,
      slug: s.name,
      name: inEnglish(s.names, 'name') ?? s.name,
      isBaby: s.is_baby,
      isLegendary: s.is_legendary,
      isMythical: s.is_mythical,
      // a pre-evolution from a later generation is no pre-evolution as far as this game is concerned
      evolvesFrom: s.evolves_from_species && idFromUrl(s.evolves_from_species.url) <= MAX_ID
        ? idFromUrl(s.evolves_from_species.url)
        : null,
      genus: inEnglish(s.genera, 'genus'),
      flavor: (s.flavor_text_entries.find((f) => f.language.name === 'en' && f.version.name === 'crystal')?.flavor_text ?? '').replace(/\s+/g, ' '),
    }))
    .sort((a, b) => a.id - b.id);

  // one edge per from>to pair, keeping the first (best) rule found for it
  const seen = new Set();
  const evolutions = chainJson
    .flatMap((chain) => collectEdges(chain.chain, []))
    .filter((e) => {
      const pair = `${e.from}>${e.to}`;
      if (seen.has(pair)) return false;
      seen.add(pair);
      return true;
    });

  return { species, evolutions };
}

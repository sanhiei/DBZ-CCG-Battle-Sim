/**
 * Attach machine-readable abilities to enriched cards by parsing their rules text.
 * Conservative: only attaches abilities the parser reads confidently (attack cards
 * for now); everything else stays manual. Marks parsed cards 'partial' coverage
 * (they still need human verification against the CRD).
 *
 *   node --experimental-strip-types src/author.ts [--saga=saiyan]
 *
 * Requires the engine to be built (imports @dbz/engine): `npx tsc -b packages/engine`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAbility } from '@dbz/engine';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

async function main() {
  const saga = (process.argv.slice(2).find((a) => a.startsWith('--saga='))?.split('=')[1] ?? 'saiyan').toLowerCase();
  const file = join(dataDir, `cards.${saga}.enriched.json`);
  const cards = JSON.parse(await readFile(file, 'utf8')) as Array<{
    name: string;
    rules?: { type?: string; text?: string; coverage?: string; abilities?: unknown[] };
  }>;

  let attached = 0;
  const effectKinds: Record<string, number> = {};
  for (const c of cards) {
    if (!c.rules) continue;
    // Reset to the baseline each run so re-authoring is idempotent (clears stale abilities).
    delete c.rules.abilities;
    c.rules.coverage = c.rules.type && c.rules.type !== 'Unknown' ? 'metadata' : 'unknown';

    const text = c.rules.text;
    if (!text) continue;
    const ability = parseAbility(text, c.rules.type ?? 'Unknown');
    if (!ability) continue;
    c.rules.abilities = [ability];
    c.rules.coverage = 'partial'; // parsed -> needs verification before 'full'
    attached += 1;
    for (const e of ability.effects) effectKinds[e.kind] = (effectKinds[e.kind] ?? 0) + 1;
  }

  await writeFile(file, JSON.stringify(cards, null, 2), 'utf8');
  console.log(`Attached abilities to ${attached}/${cards.length} cards -> ${file}`);
  console.log('Effect kinds:', effectKinds);
}

main().catch((e) => { console.error(e); process.exit(1); });

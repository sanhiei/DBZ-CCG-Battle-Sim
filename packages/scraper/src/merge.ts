/**
 * Merge the scraped catalog (cards.<saga>.json) with OCR output (ocr.<saga>.json)
 * into an enriched card file (cards.<saga>.enriched.json) that carries a `rules`
 * block + `coverage` status for the engine.
 *
 *   node --experimental-strip-types src/merge.ts [--saga=saiyan]
 *
 * Rules text/type come from OCR (imperfect, flagged). Personality alignment and
 * ally-capture flags are curated here (few personalities per saga).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

interface CatalogCard {
  id: string; number: number | null; name: string; style: string | null;
  saga: string; rarity: string; imageUrl: string; setSlug: string; rawLabel: string;
}
interface OcrRecord {
  id: string; isPersonality: boolean; personalityName?: string; level?: number;
  variant?: string; type: string | null; text?: string;
  powerRatings?: Array<number | 'Z'>; pur?: number | null; needsReview: string[];
}

/** Curated hero/villain alignment for personalities (blue bg = hero, red = villain). */
const ALIGNMENT: Record<string, 'Hero' | 'Villain'> = {
  Goku: 'Hero', Gohan: 'Hero', Krillin: 'Hero', Piccolo: 'Hero', Yamcha: 'Hero',
  Tien: 'Hero', Chiaotzu: 'Hero', Yajirobe: 'Hero', Bulma: 'Hero', 'Chi-Chi': 'Hero',
  'Master Roshi': 'Hero', Videl: 'Hero', Trunks: 'Hero',
  Vegeta: 'Villain', Nappa: 'Villain', Raditz: 'Villain', Saibaimen: 'Villain',
  Frieza: 'Villain', Guldo: 'Villain', 'Garlic Jr.': 'Villain',
};
const CAPTURING_ALLIES = new Set([
  'Bulma', 'Chi-Chi', 'Frieza', 'Garlic Jr.', 'Guldo', 'Krillin',
  'Master Roshi', 'Saibaimen', 'Videl', 'Tien', 'Yamcha',
]);

function coverageFor(type: string | null): 'metadata' | 'unknown' {
  return type ? 'metadata' : 'unknown';
}

async function main() {
  const saga = (process.argv.slice(2).find((a) => a.startsWith('--saga='))?.split('=')[1] ?? 'saiyan').toLowerCase();
  const catalog: CatalogCard[] = JSON.parse(await readFile(join(dataDir, `cards.${saga}.json`), 'utf8'));
  const ocr: OcrRecord[] = JSON.parse(await readFile(join(dataDir, `ocr.${saga}.json`), 'utf8'));
  const ocrById = new Map(ocr.map((o) => [o.id, o]));

  const enriched = catalog.map((c) => {
    const o = ocrById.get(c.id);
    if (!o) return { ...c, rules: { type: 'Unknown', coverage: 'unknown' as const } };

    const rules: Record<string, unknown> = {
      type: o.type ?? 'Unknown',
      coverage: coverageFor(o.type),
      needsReview: o.needsReview,
    };
    if (o.text) rules.text = o.text;

    if (o.isPersonality && o.personalityName) {
      const nm = o.personalityName;
      rules.type = 'Personality';
      rules.coverage = 'metadata';
      rules.personality = {
        level: o.level ?? 1,
        personalityName: nm,
        alignment: ALIGNMENT[nm] ?? 'Rogue',
        powerRatings: o.powerRatings ?? [],
        zeroStageIndex: 0,
        pur: o.pur ?? null,
        canBeAlly: true,
        canCaptureDragonBall: CAPTURING_ALLIES.has(nm) || undefined,
        ...(o.variant ? { variant: o.variant } : {}),
      };
    }
    return { ...c, rules };
  });

  const out = join(dataDir, `cards.${saga}.enriched.json`);
  await writeFile(out, JSON.stringify(enriched, null, 2), 'utf8');

  const cov: Record<string, number> = {};
  let review = 0;
  for (const c of enriched) {
    const st = (c.rules as { coverage?: string }).coverage ?? 'unknown';
    cov[st] = (cov[st] ?? 0) + 1;
    if ((c.rules as { needsReview?: string[] }).needsReview?.length) review++;
  }
  console.log(`Wrote ${enriched.length} enriched cards -> ${out}`);
  console.log('Coverage:', cov, '| flagged for review:', review);
}

main().catch((e) => { console.error(e); process.exit(1); });

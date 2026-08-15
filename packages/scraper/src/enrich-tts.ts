/**
 * Fuses the TTS catalog (cards.tts.json) with its OCR pass (ocr.tts.json) into
 * data/cards.tts.enriched.json — the engine-ready, all-sagas catalog.
 *
 *   node --experimental-strip-types src/enrich-tts.ts
 *
 * Coverage ladder per card (same model as the Saiyan catalog):
 *   unknown  — catalog entry only, no usable OCR
 *   metadata — type known, no modelled abilities
 *   partial  — abilities parsed from text (still need human verification)
 *   full     — never assigned here; requires human sign-off against the CRD
 *
 * Personality cards additionally carry the scouter ladder, level and PUR read
 * from the face; every field that failed to read stays absent and is listed in
 * rules.needsReview rather than being guessed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbility } from '@dbz/engine';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

interface TtsCard {
  id: string;
  name: string;
  saga: string;
  containers: string[];
  errata?: string;
  copies: number;
}

interface OcrRec {
  id: string;
  name: string;
  saga?: string;
  isPersonality: boolean;
  type: string | null;
  text?: string;
  powerRatings?: Array<number | 'Z'>;
  pur?: number | null;
  level?: number;
  confidence: Record<string, number>;
  needsReview: string[];
}

async function main(): Promise<void> {
  const catalog = JSON.parse(await readFile(join(dataDir, 'cards.tts.json'), 'utf8')) as { cards: TtsCard[] };
  const ocr = JSON.parse(await readFile(join(dataDir, 'ocr.tts.json'), 'utf8')) as OcrRec[];
  const ocrById = new Map(ocr.map((r) => [r.id, r]));

  let personalities = 0;
  let withAbilities = 0;
  const coverage: Record<string, number> = {};
  const effectKinds: Record<string, number> = {};

  const cards = catalog.cards.map((c) => {
    const rec = ocrById.get(c.id);
    const needsReview = [...(rec?.needsReview ?? [])];
    const type = rec?.isPersonality ? 'Personality' : rec?.type ?? 'Unknown';

    const rules: Record<string, unknown> = { type, coverage: 'unknown', needsReview };
    if (rec?.text) rules.text = rec.text;
    if (c.errata) rules.errata = c.errata;

    if (rec?.isPersonality) {
      personalities++;
      const personality: Record<string, unknown> = {
        personalityName: c.name,
        // Alignment is not printed as text; needs the hero/villain frame colour
        // or a curated list. Rogue is the CRD's explicit "neither" bucket.
        alignment: 'Rogue',
        powerRatings: rec.powerRatings ?? [],
        zeroStageIndex: 0,
        pur: rec.pur ?? null,
        canBeAlly: true,
      };
      if (rec.level !== undefined) personality.level = rec.level;
      else needsReview.push('level');
      if (!needsReview.includes('alignment')) needsReview.push('alignment');
      rules.personality = personality;
    }

    // Parse abilities off the rules text. The parser is conservative: cards it
    // cannot confidently read stay manual.
    if (rec?.text && type !== 'Personality') {
      const ability = parseAbility(rec.text, type);
      if (ability) {
        rules.abilities = [ability];
        withAbilities++;
        for (const e of ability.effects) effectKinds[e.kind] = (effectKinds[e.kind] ?? 0) + 1;
        if (ability.needsReview?.length) needsReview.push(...ability.needsReview.map((n) => `ability:${n}`));
      }
    }

    rules.coverage = rules.abilities
      ? 'partial'
      : type !== 'Unknown'
        ? 'metadata'
        : 'unknown';
    coverage[rules.coverage as string] = (coverage[rules.coverage as string] ?? 0) + 1;

    return {
      id: c.id,
      number: null,
      name: c.name,
      style: null,
      saga: c.saga,
      rarity: 'Unknown',
      imageUrl: `images-tts/${c.id}.jpg`,
      rules,
    };
  });

  const out = join(dataDir, 'cards.tts.enriched.json');
  await writeFile(out, JSON.stringify(cards, null, 2), 'utf8');

  console.log(`[enrich-tts] ${cards.length} cards -> ${out}`);
  console.log(`[enrich-tts] personalities: ${personalities}, with parsed abilities: ${withAbilities}`);
  console.log(`[enrich-tts] coverage: ${JSON.stringify(coverage)}`);
  console.log(`[enrich-tts] effect kinds: ${JSON.stringify(effectKinds)}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

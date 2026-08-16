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
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbility } from '@dbz/engine';
// Reaching into the OCR package's source is deliberate: the corrector operates
// on OCR output and lives with the OCR calibration tooling.
import { correctText, type Template } from '../../ocr/src/phrases.ts';
import { correct } from '../../ocr/src/shared.ts';

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

  // Corpus templates (run mine-phrases.ts to refresh after an OCR pass).
  const phrasesPath = join(dataDir, 'phrases.tts.json');
  const templates: Template[] = existsSync(phrasesPath)
    ? (JSON.parse(await readFile(phrasesPath, 'utf8')) as { templates: Template[] }).templates
    : [];
  // Lackey plugin: independent human-typed card data for triangulation.
  const lackeyPath = join(dataDir, 'cards.lackey.json');
  interface LackeyCard { name: string; saga: string; number: string; level: number | null; rarity: string; style: string | null; type: string; pur: number | null; text: string }
  const lackey: LackeyCard[] = existsSync(lackeyPath) ? (JSON.parse(await readFile(lackeyPath, 'utf8')) as LackeyCard[]) : [];
  const normName = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // Lackey prefixes styled card names with the style word ("Orange One Knuckle
  // Punch"); index under both spellings.
  const lackeyByKey = new Map<string, LackeyCard>();
  for (const lc of lackey) {
    const keys = [normName(lc.name)];
    const bare = lc.style && normName(lc.name).startsWith(normName(lc.style) + ' ') ? normName(lc.name).slice(normName(lc.style).length + 1) : null;
    if (bare) keys.push(bare);
    for (const k of keys) {
      const full = k + '|' + lc.saga + '|' + (lc.level ?? '');
      if (!lackeyByKey.has(full)) lackeyByKey.set(full, lc);
      const noLevel = k + '|' + lc.saga + '|';
      if (!lackeyByKey.has(noLevel)) lackeyByKey.set(noLevel, lc);
    }
  }
  const simNorm = (t: string) => t.toLowerCase().replace(/[^a-z0-9+]/g, '');
  /** Cheap similarity: shared-trigram ratio. */
  const similar = (a: string, b: string): number => {
    const A = simNorm(a); const B = simNorm(b);
    if (!A.length || !B.length) return 0;
    const tri = (x: string) => { const s = new Set<string>(); for (let i = 0; i < x.length - 2; i++) s.add(x.slice(i, i + 3)); return s; };
    const ta = tri(A); const tb = tri(B);
    let hit = 0; for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.max(ta.size, tb.size, 1);
  };
  let matched = 0; let verified = 0;
  let snappedTotal = 0;
  let cardsSnapped = 0;
  const fixText = (raw: string): string => {
    const cleaned = correct(raw);
    if (!templates.length) return cleaned;
    const { text, snappedCount } = correctText(cleaned, templates);
    if (snappedCount > 0) {
      snappedTotal += snappedCount;
      cardsSnapped++;
    }
    return text;
  };

  let personalities = 0;
  let withAbilities = 0;
  const coverage: Record<string, number> = {};
  const effectKinds: Record<string, number> = {};

  const cards = catalog.cards.map((c) => {
    const rec = ocrById.get(c.id);
    const needsReview = [...(rec?.needsReview ?? [])];
    const type = rec?.isPersonality ? 'Personality' : rec?.type ?? 'Unknown';

    const rules: Record<string, unknown> = { type, coverage: 'unknown', needsReview };
    const ocrText = rec?.text ? fixText(rec.text) : undefined;
    if (ocrText) rules.text = ocrText;
    if (c.errata) rules.errata = c.errata;

    // Triangulate with the Lackey database (matched by name+saga, +level for
    // personalities). Typed text supersedes OCR; agreement between the two
    // independent transcriptions marks the text verified.
    const lk = lackeyByKey.get(normName(c.name) + '|' + c.saga + '|' + (rec?.level ?? '')) ?? lackeyByKey.get(normName(c.name) + '|' + c.saga + '|');
    if (lk) {
      matched++;
      // Agreement: two independent transcriptions -> take the typed one, mark
      // verified. Disagreement: the card FACE (errata'd, most-recent wording)
      // outranks Lackey's original-printing text, which is kept as evidence —
      // Saiyan Truce Card's errata rewrite showed why this must not be a
      // blind replacement.
      const sim = ocrText ? similar(lk.text, ocrText) : 0;
      if (sim >= 0.55) {
        verified++;
        rules.text = lk.text;
        rules.textVerified = true;
      } else {
        rules.textOriginal = lk.text;
        if (ocrText) needsReview.push('textDisagreement');
        else rules.text = lk.text; // no OCR at all -> typed text beats nothing
      }
      if (lk.type) rules.type = lk.type;
      rules.lackey = { number: lk.number, rarity: lk.rarity, style: lk.style, ...(lk.pur != null ? { pur: lk.pur } : {}), ...(lk.level != null ? { level: lk.level } : {}) };
    }
    const effType = (rules.type as string) ?? type;

    if (rec?.isPersonality || (lk && lk.pur != null)) {
      personalities++;
      const personality: Record<string, unknown> = {
        personalityName: c.name,
        // Alignment is not printed as text; needs the hero/villain frame colour
        // or a curated list. Rogue is the CRD's explicit "neither" bucket.
        alignment: 'Rogue',
        powerRatings: rec?.powerRatings ?? [],
        zeroStageIndex: 0,
        pur: (lk?.pur ?? rec?.pur) ?? null,
        canBeAlly: true,
      };
      const lvl = lk?.level ?? rec?.level;
      if (lvl !== undefined && lvl !== null) personality.level = lvl;
      else needsReview.push('level');
      if (!needsReview.includes('alignment')) needsReview.push('alignment');
      rules.personality = personality;
    }

    // Parse abilities off the rules text. The parser is conservative: cards it
    // cannot confidently read stay manual.
    if (rules.text && (rules.type ?? type) !== 'Personality') {
      const ability = parseAbility(rules.text as string, (rules.type as string) ?? type);
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
  console.log(`[enrich-tts] template snaps: ${snappedTotal} sentences on ${cardsSnapped} cards (${templates.length} templates)`);
  console.log(`[enrich-tts] lackey: ${lackey.length} cards loaded, ${matched} matched, ${verified} text-verified by OCR agreement`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

/**
 * Scores data/ocr.tts.json against the hand-verified fixture.
 *
 * Measures extraction against values read off the actual card faces, so a
 * change can be judged on whether it made the data more correct rather than
 * on whether it produced fewer warnings.
 *
 *   node --experimental-strip-types src/check-ocr.ts
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrRecord } from './shared.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

interface Truth {
  name: string;
  saga: string;
  isPersonality: boolean;
  type?: string;
  level?: number;
  pur?: number;
  topRating?: number;
  stages?: number;
  /** Hand-transcribed rules text (logical words; line-break hyphens joined). */
  text?: string;
}

/**
 * Normalization for character-error-rate: case, whitespace, trademark glyphs
 * and line-break hyphenation are presentation, not content.
 */
function cerNormalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[™®"“”]/g, '')
    .replace(/([a-z])-\s+([a-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

interface Tally { pass: number; fail: number; missing: number }
const tally = (): Tally => ({ pass: 0, fail: 0, missing: 0 });

function score(t: Tally, expected: unknown, actual: unknown, label: string, notes: string[]): void {
  if (expected === undefined) return;
  if (actual === undefined || actual === null) {
    t.missing++;
    notes.push(`${label}: MISSING (want ${String(expected)})`);
  } else if (expected === actual) {
    t.pass++;
  } else {
    t.fail++;
    notes.push(`${label}: got ${String(actual)}, want ${String(expected)}`);
  }
}

async function main(): Promise<void> {
  const fixture = JSON.parse(
    await readFile(join(here, 'fixtures', 'ground-truth.json'), 'utf8'),
  ) as { cards: Truth[] };
  const records = JSON.parse(await readFile(join(root, 'data', 'ocr.tts.json'), 'utf8')) as OcrRecord[];

  const byKey = new Map<string, OcrRecord>();
  for (const r of records) byKey.set(`${r.name.toLowerCase()}|${r.saga ?? ''}`, r);

  // Text CER is scored against the ENRICHED text (post char-fixes and template
  // snapping) when available — that is what the ability parser consumes.
  const enrichedPath = join(root, 'data', 'cards.tts.enriched.json');
  const enrichedText = new Map<string, string>();
  interface EnrichedPersonality { level?: number; pur?: number | null; powerRatings?: Array<number | 'Z'> }
  const enrichedPers = new Map<string, EnrichedPersonality>();
  try {
    const enriched = JSON.parse(await readFile(enrichedPath, 'utf8')) as Array<{
      name: string;
      saga: string;
      rules?: { text?: string; personality?: EnrichedPersonality };
    }>;
    for (const c of enriched) {
      const key = `${c.name.toLowerCase()}|${c.saga}`;
      if (c.rules?.text) enrichedText.set(key, c.rules.text);
      if (c.rules?.personality) enrichedPers.set(key, c.rules.personality);
    }
  } catch {
    /* enrichment not run yet — fall back to raw OCR text */
  }

  const classify = tally();
  const type = tally();
  const level = tally();
  const pur = tally();
  const top = tally();
  // Same fields scored against the MERGED catalog (what the engine consumes).
  const mLevel = tally();
  const mPur = tally();
  const mTop = tally();
  const cers: Array<{ name: string; cer: number }> = [];
  let notFound = 0;

  for (const truth of fixture.cards) {
    const rec = byKey.get(`${truth.name.toLowerCase()}|${truth.saga}`);
    if (!rec) {
      notFound++;
      console.log(`?  ${truth.name} [${truth.saga}] — no record`);
      continue;
    }
    const notes: string[] = [];
    score(classify, truth.isPersonality, rec.isPersonality, 'isPersonality', notes);
    if (truth.isPersonality) {
      score(level, truth.level, rec.level, 'level', notes);
      score(pur, truth.pur, rec.pur, 'pur', notes);
      const highest = rec.powerRatings?.filter((r): r is number => typeof r === 'number').at(-1);
      score(top, truth.topRating, highest, 'topRating', notes);
      const merged = enrichedPers.get(`${truth.name.toLowerCase()}|${truth.saga}`);
      if (merged) {
        score(mLevel, truth.level, merged.level, 'merged.level', notes);
        score(mPur, truth.pur, merged.pur ?? undefined, 'merged.pur', notes);
        const mHighest = merged.powerRatings?.filter((r): r is number => typeof r === 'number').at(-1);
        score(mTop, truth.topRating, mHighest, 'merged.topRating', notes);
      }
    } else {
      score(type, truth.type, rec.type, 'type', notes);
    }
    if (truth.text) {
      const got = enrichedText.get(`${truth.name.toLowerCase()}|${truth.saga}`) ?? rec.text ?? '';
      const want = cerNormalize(truth.text);
      const cer = levenshtein(cerNormalize(got), want) / Math.max(1, want.length);
      cers.push({ name: truth.name, cer });
      if (cer > 0.05) notes.push(`CER ${(cer * 100).toFixed(1)}%`);
    }
    const mark = notes.length === 0 ? 'OK ' : '   ';
    console.log(`${mark}${truth.name} [${truth.saga}]${notes.length ? ' — ' + notes.join('; ') : ''}`);
  }

  const line = (label: string, t: Tally) => {
    const total = t.pass + t.fail + t.missing;
    if (total === 0) return;
    const pct = ((t.pass / total) * 100).toFixed(0);
    console.log(`  ${label.padEnd(14)} ${String(t.pass).padStart(2)}/${total}  (${pct}%)  ${t.fail} wrong, ${t.missing} missing`);
  };
  console.log('\n--- accuracy vs hand-read ground truth ---');
  line('personality', classify);
  line('type', type);
  line('level', level);
  line('pur', pur);
  line('top rating', top);
  console.log('  --- merged catalog (what the engine consumes) ---');
  line('level', mLevel);
  line('pur', mPur);
  line('top rating', mTop);
  if (cers.length) {
    const avg = cers.reduce((s, c) => s + c.cer, 0) / cers.length;
    const worst = cers.reduce((a, b) => (b.cer > a.cer ? b : a));
    console.log(`  text CER      avg ${(avg * 100).toFixed(1)}% over ${cers.length} cards  (worst: ${worst.name} ${(worst.cer * 100).toFixed(1)}%)`);
  }
  if (notFound) console.log(`  ${notFound} fixture card(s) had no record`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

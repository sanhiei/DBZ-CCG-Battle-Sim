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

  const classify = tally();
  const type = tally();
  const level = tally();
  const pur = tally();
  const top = tally();
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
    } else {
      score(type, truth.type, rec.type, 'type', notes);
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
  if (notFound) console.log(`  ${notFound} fixture card(s) had no record`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

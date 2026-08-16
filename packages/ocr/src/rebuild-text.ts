/**
 * Regenerates every record's `text` from its stored per-word data using the
 * tuner's winning configuration (conf>=40, digits rescued at >=10, trailing
 * junk trimmed) — no re-OCR involved. Template snapping is NOT applied here:
 * ocr.tts.json stays close to the raw evidence; enrich-tts.ts snaps.
 *
 *   node --experimental-strip-types src/rebuild-text.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correct, type OcrRecord } from './shared.ts';
import { rebuildText } from './tune-text.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

/** Winning config from tune-text.ts (fixture CER 6.7% vs 33.8% before). */
export const TEXT_CONFIG = { minConf: 40, digitConf: 10, trimTrailingJunk: true };

async function main(): Promise<void> {
  const path = join(dataDir, 'ocr.tts.json');
  const records = JSON.parse(await readFile(path, 'utf8')) as OcrRecord[];
  let rebuilt = 0;
  let emptied = 0;
  for (const rec of records) {
    if (!rec.words?.length) continue;
    const text = correct(rebuildText(rec.words, TEXT_CONFIG));
    if (text !== rec.text) rebuilt++;
    if (!text && rec.text) emptied++;
    rec.text = text;
    rec.needsReview = rec.needsReview.filter((n) => n !== 'text');
    if (!text || text.length < 12) rec.needsReview.push('text');
  }
  await writeFile(path, JSON.stringify(records, null, 2), 'utf8');
  console.log(`[rebuild] ${rebuilt}/${records.length} texts changed (${emptied} became empty)`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

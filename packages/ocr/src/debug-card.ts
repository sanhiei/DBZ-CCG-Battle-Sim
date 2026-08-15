/**
 * Dump what the layout detectors actually see for one card.
 *
 *   node --experimental-strip-types src/debug-card.ts "Android 13" [saga]
 *
 * Prints the words found in each area with their normalised boxes, so a wrong
 * field can be traced to the pixels rather than guessed at.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createScheduler, createWorker, PSM } from 'tesseract.js';
import { AREAS, detectLadder, detectLevel, detectPur, groupRows, ocrArea, type Preprocess } from './layout.ts';
import type { OcrRecord } from './shared.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

async function main(): Promise<void> {
  const [name, saga] = process.argv.slice(2);
  if (!name) {
    console.error('usage: debug-card.ts "<card name>" [saga]');
    process.exit(1);
  }
  const recs = JSON.parse(await readFile(join(root, 'data', 'ocr.tts.json'), 'utf8')) as OcrRecord[];
  const rec = recs.find((r) => r.name.toLowerCase() === name.toLowerCase() && (!saga || r.saga === saga));
  if (!rec) {
    console.error(`no record for "${name}"${saga ? ` [${saga}]` : ''}`);
    process.exit(1);
  }

  const path = join(root, 'data', 'images-tts', `${rec.id}.jpg`);
  const meta = await sharp(path).metadata();
  const w = meta.width ?? 800;
  const h = meta.height ?? 1100;
  console.log(`${rec.name} [${rec.saga}]  ${w}x${h}  id=${rec.id}`);
  console.log(`current record: isPersonality=${rec.isPersonality} type=${rec.type} level=${rec.level} pur=${rec.pur}`);
  console.log(`  ratings: ${JSON.stringify(rec.powerRatings)}\n`);

  const digits = createScheduler();
  const text = createScheduler();
  const dw = await createWorker('eng');
  await dw.setParameters({ tessedit_char_whitelist: '0123456789Z', tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  digits.addWorker(dw);
  const tw = await createWorker('eng');
  await tw.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  text.addWorker(tw);

  const show = async (label: string, area: keyof typeof AREAS, mode: Preprocess, useDigits: boolean) => {
    const r = await ocrArea(useDigits ? digits : text, path, AREAS[area], w, h, mode);
    console.log(`--- ${label} (${area}, ${mode}) conf=${r.conf.toFixed(0)} words=${r.words.length}`);
    for (const row of groupRows(r.words)) {
      const joined = row.map((x) => x.text).join(' ');
      const b = row[0]!;
      const height = ((row[0]!.y1 - row[0]!.y0) * 100).toFixed(1);
      console.log(`    y=${b.y0.toFixed(3)} x=${b.x0.toFixed(3)}-${row.at(-1)!.x1.toFixed(3)} h=${height}%  conf=${(row.reduce((s, x) => s + x.conf, 0) / row.length).toFixed(0)}  "${joined}"`);
    }
    return r;
  };

  for (const mode of ['invert', 'text'] as Preprocess[]) {
    const r = await show(`LADDER ${mode}`, 'ladder', mode, true);
    const d = detectLadder(r.words);
    console.log(`    => ok=${d.ok} reason=${d.reason ?? '-'} span=${d.span.toFixed(2)} n=${d.ratings.length}`);
    console.log(`    => ${JSON.stringify(d.ratings)}\n`);
  }
  for (const mode of ['text', 'invert'] as Preprocess[]) {
    const r = await show(`LEVEL ${mode}`, 'level', mode, true);
    console.log(`    => ${JSON.stringify(detectLevel(r.words))}\n`);
  }
  for (const mode of ['text', 'invert'] as Preprocess[]) {
    const r = await show(`PUR ${mode}`, 'pur', mode, true);
    console.log(`    => ${JSON.stringify(detectPur(r.words))}\n`);
  }
  for (const mode of ['sharp', 'text', 'invert'] as Preprocess[]) {
    await show(`BANNER ${mode}`, 'typeBanner', mode, false);
  }

  await Promise.all([digits.terminate(), text.terminate()]);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

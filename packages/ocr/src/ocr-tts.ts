/**
 * OCR pass over the Tabletop Simulator card slices (data/images-tts/).
 *
 * These faces are ~800x1100 with errata already printed on them — 4x the pixel
 * area of the retrodbzccg gallery scans, which is what makes the text usable.
 *
 * TTS nicknames carry no level ("Goku" for every Goku level card), so unlike
 * ocr.ts this driver cannot detect personalities from the name. Instead it
 * probes the scouter ladder: a card showing a column of ascending ratings is a
 * personality, and its level is read off the top-left corner badge.
 *
 *   node --experimental-strip-types src/ocr-tts.ts [--limit=N] [--force] [--concurrency=N]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createScheduler, createWorker, PSM, type Scheduler } from 'tesseract.js';
import { correct, guessType, parseLadder, regionBuffer, REGIONS, stripNoise, type OcrRecord } from './shared.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dataDir = join(root, 'data');
const imgDir = join(dataDir, 'images-tts');
const outDir = join(dataDir, 'ocr-tts');

/** A ladder this long means we're looking at a personality's scouter. */
const PERSONALITY_MIN_RATINGS = 5;

interface IndexEntry { id: string; name: string; saga: string; file: string }

async function run(scheduler: Scheduler, buf: Buffer): Promise<{ text: string; conf: number }> {
  const { data } = (await scheduler.addJob('recognize', buf)) as { data: { text: string; confidence: number } };
  return { text: data.text.trim(), conf: data.confidence };
}

async function processCard(entry: IndexEntry, text: Scheduler, digits: Scheduler, chars: Scheduler): Promise<OcrRecord> {
  const path = join(imgDir, entry.file);
  const meta = await sharp(path).metadata();
  const w = meta.width ?? 800;
  const h = meta.height ?? 1100;

  const rec: OcrRecord = {
    id: entry.id,
    number: null,
    name: entry.name,
    saga: entry.saga,
    isPersonality: false,
    type: null,
    confidence: {},
    needsReview: [],
  };

  // Probe the scouter column first — it decides which layout this card uses.
  const ladderR = await run(digits, await regionBuffer(path, REGIONS.powerColumn, w, h, { mode: 'invert' }));
  const ladder = parseLadder(ladderR.text);
  rec.isPersonality = ladder.ratings.length >= PERSONALITY_MIN_RATINGS;

  if (rec.isPersonality) {
    rec.type = 'Personality';
    rec.personalityName = entry.name;
    rec.powerRatings = ladder.ratings;
    rec.confidence.powerColumn = ladderR.conf;
    if (ladder.suspect || ladderR.conf < 70) rec.needsReview.push('powerRatings');
    if (ladder.dropped > 0) rec.confidence.ladderDropped = ladder.dropped;

    // TTS gives us no level, so read the corner badge.
    const levelR = await run(chars, await regionBuffer(path, REGIONS.level, w, h, { mode: 'text' }));
    const lvl = Number((levelR.text.match(/[1-5]/) ?? [''])[0]);
    rec.level = Number.isFinite(lvl) && lvl >= 1 ? lvl : 1;
    rec.confidence.level = levelR.conf;
    if (!Number.isFinite(lvl) || lvl < 1) rec.needsReview.push('level');

    const purR = await run(chars, await regionBuffer(path, REGIONS.pur, w, h, { mode: 'text' }));
    const purNum = Number((purR.text.match(/\d+/) ?? [''])[0]);
    rec.pur = Number.isFinite(purNum) ? purNum : null;
    rec.confidence.pur = purR.conf;
    if (rec.pur == null || purR.conf < 60) rec.needsReview.push('pur');

    const powerR = await run(text, await regionBuffer(path, REGIONS.powerText, w, h));
    rec.text = stripNoise(correct(powerR.text));
    rec.confidence.text = powerR.conf;
    if (powerR.conf < 55) rec.needsReview.push('text');
  } else {
    const typeR = await run(text, await regionBuffer(path, REGIONS.typeLine, w, h));
    rec.typeLineRaw = typeR.text.replace(/\n/g, ' ').trim();
    const guessed = guessType(typeR.text);
    rec.type = guessed.type;
    rec.confidence.typeLine = typeR.conf;
    if (guessed.conf === 'none') rec.needsReview.push('type');

    const textR = await run(text, await regionBuffer(path, REGIONS.textBox, w, h));
    rec.text = stripNoise(correct(textR.text));
    rec.confidence.text = textR.conf;
    if (textR.conf < 55) rec.needsReview.push('text');
  }

  return rec;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (flag: string, fallback: number) => {
    const raw = args.find((a) => a.startsWith(`--${flag}=`))?.split('=')[1];
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const limit = num('limit', Infinity);
  const force = args.includes('--force');
  // Tesseract is CPU-bound; leave a couple of cores for the OS.
  const concurrency = Math.max(1, Math.min(num('concurrency', Math.max(2, cpus().length - 4)), 16));

  const indexPath = join(imgDir, 'index.json');
  if (!existsSync(indexPath)) {
    console.error(`[ocr-tts] ${indexPath} not found — run \`npm run slice:tts\` first`);
    process.exit(1);
  }
  await mkdir(outDir, { recursive: true });

  const index = JSON.parse(await readFile(indexPath, 'utf8')) as { cards: IndexEntry[] };
  const all = index.cards.slice(0, limit);
  const todo = force ? all : all.filter((c) => !existsSync(join(outDir, `${c.id}.json`)));
  console.log(`[ocr-tts] ${todo.length} to process (${all.length - todo.length} already done), concurrency ${concurrency}`);
  if (todo.length === 0) return;

  const textScheduler = createScheduler();
  const digitScheduler = createScheduler();
  const charScheduler = createScheduler();
  const digitWorkers = Math.max(1, Math.floor(concurrency / 2));
  console.log(`[ocr-tts] starting ${concurrency} text + ${digitWorkers} digit workers...`);
  await Promise.all([
    ...Array.from({ length: concurrency }, async () => {
      const w = await createWorker('eng');
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      textScheduler.addWorker(w);
    }),
    ...Array.from({ length: digitWorkers }, async () => {
      const w = await createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: '0123456789Z', tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      digitScheduler.addWorker(w);
    }),
    // PUR and level are a single large glyph; SPARSE_TEXT misreads them.
    ...Array.from({ length: digitWorkers }, async () => {
      const w = await createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_CHAR });
      charScheduler.addWorker(w);
    }),
  ]);

  const started = Date.now();
  let done = 0;
  let failed = 0;
  const queue = [...todo];

  const consume = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const rec = await processCard(entry, textScheduler, digitScheduler, charScheduler);
        await writeFile(join(outDir, `${rec.id}.json`), JSON.stringify(rec, null, 2), 'utf8');
      } catch (err) {
        failed++;
        console.warn(`  ${entry.name}: ERROR ${(err as Error).message}`);
      }
      done++;
      if (done % 50 === 0 || done === todo.length) {
        const secs = (Date.now() - started) / 1000;
        const rate = done / secs;
        const eta = Math.round((todo.length - done) / Math.max(rate, 0.01));
        console.log(`[ocr-tts] ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${eta % 60}s`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, consume));
  await Promise.all([textScheduler.terminate(), digitScheduler.terminate(), charScheduler.terminate()]);

  // Merge every per-card record (including earlier runs) into one file.
  const merged: OcrRecord[] = [];
  for (const entry of index.cards) {
    const p = join(outDir, `${entry.id}.json`);
    if (existsSync(p)) merged.push(JSON.parse(await readFile(p, 'utf8')) as OcrRecord);
  }
  await writeFile(join(dataDir, 'ocr.tts.json'), JSON.stringify(merged, null, 2), 'utf8');

  const personalities = merged.filter((r) => r.isPersonality).length;
  const review = merged.filter((r) => r.needsReview.length).length;
  const typed = merged.filter((r) => r.type).length;
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n[ocr-tts] done in ${Math.floor(secs / 60)}m${secs % 60}s — ${done} processed, ${failed} failed`);
  console.log(`[ocr-tts] ${merged.length} records: ${personalities} personalities, ${typed} typed, ${review} flagged for review`);
  console.log(`[ocr-tts] wrote data/ocr.tts.json`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

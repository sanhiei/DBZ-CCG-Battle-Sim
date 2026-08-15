/**
 * OCR pass over the Tabletop Simulator card slices (data/images-tts/).
 *
 * Faces are ~800x1100 with errata already printed on them — 4x the pixel area
 * of the retrodbzccg gallery scans, which is what makes the text usable.
 *
 * Fields are located by structure, not by fixed fractions (see layout.ts for
 * why). Two consequences shape this driver:
 *
 *  - Personality classification is a RESULT, not an input. TTS nicknames carry
 *    no level, so a card is a personality exactly when a valid scouter ladder
 *    is found on it.
 *  - Contrast polarity varies by frame: Bulma's ladder is dark digits on pale
 *    pills, Captain Ginyu's is pale digits on a dark panel. Each field is tried
 *    both ways and the better reading wins.
 *
 *   node --experimental-strip-types src/ocr-tts.ts [--limit=N] [--force]
 *                                                  [--concurrency=N] [--only=name]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createScheduler, createWorker, PSM, type Scheduler } from 'tesseract.js';
import { correct, guessType, type OcrRecord } from './shared.ts';
import { AREAS, detectLadder, ladderScore, LEVEL_BOXES, ocrArea, probeBadge, PUR_BOXES, textFromWords } from './layout.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dataDir = join(root, 'data');
const imgDir = join(dataDir, 'images-tts');
const outDir = join(dataDir, 'ocr-tts');

interface IndexEntry { id: string; name: string; saga: string; file: string }

interface Schedulers {
  /** Whitelisted digits, sparse layout — the scouter ladder. */
  digits: Scheduler;
  /** Full text, single block — rules text and the type plate. */
  text: Scheduler;
  /** Single-character mode — the level and PUR badges. */
  chars: Scheduler;
}

/**
 * Infer a card type from its rules text when the embossed metallic type plate
 * will not OCR. Ordered most- to least-specific; only consulted as a fallback,
 * and the result is marked so it can be told apart from a real banner read.
 */
const TYPE_FROM_TEXT: Array<[RegExp, string]> = [
  [/\bphysical attack\b/i, 'Physical Combat'],
  [/\benergy attack\b/i, 'Energy Combat'],
  [/\bconstant combat power\b/i, 'Personality'],
  [/\bdrill\b.*\bin play\b|\bthis drill\b/i, 'Drill'],
  [/\bmastery\b/i, 'Mastery'],
  [/\bsensei deck\b/i, 'Sensei'],
  [/\bdragon ball\b/i, 'Dragon Ball'],
  [/\buse (when|once)\b|\bremove from the game after use\b/i, 'Non-Combat'],
];

function inferType(text: string): string | null {
  for (const [pattern, type] of TYPE_FROM_TEXT) if (pattern.test(text)) return type;
  return null;
}

async function processCard(entry: IndexEntry, s: Schedulers): Promise<OcrRecord> {
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

  // ---- Scouter ladder: also the personality test ----
  // Polarity varies by frame (pale digits on red pills vs dark digits on pale
  // ones), so read it both ways and keep the better-scoring result rather than
  // the first that merely parses — a weak reading used to beat a strong one.
  const inverted = await ocrArea(s.digits, path, AREAS.ladder, w, h, 'invert');
  const plain = await ocrArea(s.digits, path, AREAS.ladder, w, h, 'text');
  const readings = [detectLadder(inverted.words), detectLadder(plain.words)];
  const ladder = readings.reduce((a, b) => (ladderScore(b) > ladderScore(a) ? b : a));
  rec.isPersonality = ladder.ok;

  if (ladder.ok) {
    rec.type = 'Personality';
    rec.personalityName = entry.name;
    rec.powerRatings = ladder.ratings;
    rec.confidence.powerColumn = Math.round(ladder.conf);
    if (ladder.conf < 65) rec.needsReview.push('powerRatings');

    const level = await probeBadge(s.chars, path, LEVEL_BOXES, w, h, /^[1-5]$/);
    if (level.value !== undefined) rec.level = level.value;
    else rec.needsReview.push('level');
    rec.confidence.level = Math.round(level.conf);

    const pur = await probeBadge(s.chars, path, PUR_BOXES, w, h, /^[1-9]$/);
    if (pur.value !== undefined) rec.pur = pur.value;
    else {
      rec.pur = null;
      rec.needsReview.push('pur');
    }
    rec.confidence.pur = Math.round(pur.conf);
  } else {
    rec.confidence.ladderReason = 0;
    if (ladder.reason) rec.typeLineRaw = `no-ladder: ${ladder.reason}`;
  }

  // ---- Rules text (all card kinds) ----
  const rules = await ocrArea(s.text, path, AREAS.rules, w, h, 'text');
  rec.text = correct(textFromWords(rules.words));
  rec.confidence.text = Math.round(rules.conf);
  if (!rec.text || rec.text.length < 12) rec.needsReview.push('text');

  // ---- Type plate (non-personalities only) ----
  if (!rec.isPersonality) {
    // The type plate is embossed silver-on-silver; no single preprocessing
    // reads every frame, so try each and stop at the first keyword match.
    let bannerText = '';
    let bannerConf = 0;
    let matched: string | null = null;
    for (const mode of ['sharp', 'text', 'invert'] as const) {
      const banner = await ocrArea(s.text, path, AREAS.typeBanner, w, h, mode);
      const candidate = banner.words.map((x) => x.text).join(' ');
      if (candidate.trim().length > bannerText.trim().length) {
        bannerText = candidate;
        bannerConf = banner.conf;
      }
      const guessed = guessType(candidate);
      if (guessed.type) {
        matched = guessed.type;
        bannerText = candidate;
        bannerConf = banner.conf;
        break;
      }
    }
    rec.typeLineRaw = bannerText.trim();
    rec.type = matched;
    rec.confidence.typeLine = Math.round(bannerConf);
    if (!rec.type) {
      const inferred = inferType(rec.text ?? '');
      if (inferred && inferred !== 'Personality') {
        rec.type = inferred;
        rec.confidence.typeInferred = 1;
      } else {
        rec.needsReview.push('type');
      }
    }
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
  const str = (flag: string) => args.find((a) => a.startsWith(`--${flag}=`))?.split('=').slice(1).join('=');
  const limit = num('limit', Infinity);
  const force = args.includes('--force');
  const only = str('only');
  const concurrency = Math.max(1, Math.min(num('concurrency', Math.max(2, cpus().length - 4)), 16));

  const indexPath = join(imgDir, 'index.json');
  if (!existsSync(indexPath)) {
    console.error(`[ocr-tts] ${indexPath} not found — run \`npm run slice:tts\` first`);
    process.exit(1);
  }
  await mkdir(outDir, { recursive: true });

  const index = JSON.parse(await readFile(indexPath, 'utf8')) as { cards: IndexEntry[] };
  let all = index.cards;
  if (only) {
    const names = only.split('|').map((n) => n.toLowerCase());
    all = all.filter((c) => names.includes(c.name.toLowerCase()));
  }
  all = all.slice(0, limit);
  const todo = force ? all : all.filter((c) => !existsSync(join(outDir, `${c.id}.json`)));
  console.log(`[ocr-tts] ${todo.length} to process (${all.length - todo.length} already done), concurrency ${concurrency}`);
  if (todo.length === 0) return;

  const digits = createScheduler();
  const text = createScheduler();
  const chars = createScheduler();
  const digitWorkers = Math.max(2, Math.ceil(concurrency * 0.6));
  console.log(`[ocr-tts] starting ${concurrency} text + ${digitWorkers} digit workers...`);
  await Promise.all([
    ...Array.from({ length: concurrency }, async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      text.addWorker(worker);
    }),
    ...Array.from({ length: digitWorkers }, async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: '0123456789Z', tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      digits.addWorker(worker);
    }),
    ...Array.from({ length: Math.max(2, Math.floor(concurrency / 3)) }, async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_CHAR });
      chars.addWorker(worker);
    }),
  ]);

  const schedulers: Schedulers = { digits, text, chars };
  const started = Date.now();
  let done = 0;
  let failed = 0;
  const queue = [...todo];

  const consume = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const rec = await processCard(entry, schedulers);
        await writeFile(join(outDir, `${rec.id}.json`), JSON.stringify(rec, null, 2), 'utf8');
      } catch (err) {
        failed++;
        console.warn(`  ${entry.name}: ERROR ${(err as Error).message}`);
      }
      done++;
      if (done % 100 === 0 || done === todo.length) {
        const secs = (Date.now() - started) / 1000;
        const rate = done / secs;
        const eta = Math.round((todo.length - done) / Math.max(rate, 0.01));
        console.log(`[ocr-tts] ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${eta % 60}s`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, consume));
  await Promise.all([text.terminate(), digits.terminate(), chars.terminate()]);

  const merged: OcrRecord[] = [];
  for (const entry of index.cards) {
    const p = join(outDir, `${entry.id}.json`);
    if (existsSync(p)) merged.push(JSON.parse(await readFile(p, 'utf8')) as OcrRecord);
  }
  await writeFile(join(dataDir, 'ocr.tts.json'), JSON.stringify(merged, null, 2), 'utf8');

  const personalities = merged.filter((r) => r.isPersonality);
  const nonPers = merged.filter((r) => !r.isPersonality);
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n[ocr-tts] done in ${Math.floor(secs / 60)}m${secs % 60}s — ${done} processed, ${failed} failed`);
  console.log(`[ocr-tts] ${merged.length} records: ${personalities.length} personalities, ${nonPers.length} other`);
  console.log(`[ocr-tts]   personalities clean: ${personalities.filter((r) => !r.needsReview.length).length}`);
  console.log(`[ocr-tts]   typed: ${nonPers.filter((r) => r.type).length}/${nonPers.length}`);
  console.log(`[ocr-tts]   flagged: ${merged.filter((r) => r.needsReview.length).length}`);
  console.log(`[ocr-tts] wrote data/ocr.tts.json`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

/**
 * Batch OCR pipeline for DBZ CCG cards.
 *
 * For each scraped card, crops the meaningful regions with sharp, preprocesses,
 * and OCRs them with Tesseract:
 *   - non-personality: type line + rules text box
 *   - personality:     power-stage ladder (digit-whitelisted), PUR, level, Power text
 * Emits a reviewable record per card and a merged file. Low-confidence / suspect
 * fields are flagged for QA.
 *
 *   node --experimental-strip-types src/ocr.ts [--saga=saiyan] [--limit=N] [--force]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dataDir = join(root, 'data');
const imgDir = join(dataDir, 'images');
const ocrDir = join(dataDir, 'ocr');

interface Card { id: string; number: number | null; name: string; style: string | null; imageUrl: string }

type Rect = { x0: number; y0: number; x1: number; y1: number }; // fractions 0..1

/** Regions as fractions of the card. Calibrated from Saiyan Saga layouts. */
const REGIONS = {
  title: { x0: 0.03, y0: 0.0, x1: 0.72, y1: 0.085 } satisfies Rect,
  // Non-personality cards:
  typeLine: { x0: 0.04, y0: 0.455, x1: 0.96, y1: 0.575 } satisfies Rect,
  textBox: { x0: 0.05, y0: 0.62, x1: 0.87, y1: 0.9 } satisfies Rect,
  // Personality cards (power ladder trimmed to exclude set number + SCORE logo):
  powerColumn: { x0: 0.79, y0: 0.085, x1: 1.0, y1: 0.9 } satisfies Rect,
  pur: { x0: 0.0, y0: 0.49, x1: 0.15, y1: 0.63 } satisfies Rect,
  level: { x0: 0.03, y0: 0.0, x1: 0.15, y1: 0.09 } satisfies Rect,
  powerText: { x0: 0.15, y0: 0.55, x1: 0.78, y1: 0.84 } satisfies Rect,
};

const CARD_TYPES = [
  'Physical Combat',
  'Energy Combat',
  'Non-Combat',
  'Combat',
  'Drill',
  'Mastery',
  'Location',
  'Battleground',
  'Dragon Ball',
  'Sensei',
  'Personality',
];

/** Frequent OCR confusions in this card set. */
const CORRECTIONS: Array<[RegExp, string]> = [
  [/\bphusical\b/gi, 'physical'],
  [/\bpersanality'?s?\b/gi, 'personality'],
  [/\bpersonalitys\b/gi, "personality's"],
  [/\bTheu'?ve\b/gi, "They've"],
  [/\bTheu\b/gi, 'They'],
  [/\bpawer\b/gi, 'power'],
  [/\bdamoge\b/gi, 'damage'],
  [/\bopponenr\b/gi, 'opponent'],
  [/\bcombar\b/gi, 'combat'],
  [/\bDragon\b/g, 'Dragon'],
  [/\battock\b/gi, 'attack'],
  [/\bstoge\b/gi, 'stage'],
  [/\brotinq\b/gi, 'rating'],
  [/[ \t]+\n/g, '\n'],
  [/\n{3,}/g, '\n\n'],
  [/[ \t]{2,}/g, ' '],
];

function correct(text: string): string {
  let t = text;
  for (const [re, rep] of CORRECTIONS) t = t.replace(re, rep);
  return t.trim();
}

function isPersonality(name: string): boolean {
  return /\bLV\s?\d/i.test(name);
}

/** Parse "Goku LV1 HT" -> { personalityName, level, variant }. */
function parsePersonalityName(name: string): { personalityName: string; level: number; variant?: string } {
  const m = name.match(/^(.*?)\s+LV\s?(\d)(?:\s+(.*))?$/i);
  if (!m) return { personalityName: name, level: 1 };
  return {
    personalityName: m[1]!.trim(),
    level: Number(m[2]),
    ...(m[3] ? { variant: m[3].trim() } : {}),
  };
}

function px(rect: Rect, w: number, h: number) {
  const left = Math.max(0, Math.round(rect.x0 * w));
  const top = Math.max(0, Math.round(rect.y0 * h));
  const right = Math.min(w, Math.round(rect.x1 * w));
  const bottom = Math.min(h, Math.round(rect.y1 * h));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function regionBuffer(
  path: string,
  rect: Rect,
  w: number,
  h: number,
  opts: { digits?: boolean } = {},
): Promise<Buffer> {
  const region = px(rect, w, h);
  const scale = opts.digits ? 4 : 3;
  let s = sharp(path).extract(region).grayscale().resize({ width: region.width * scale });
  s = s.normalize();
  // Scouter/PUR numbers are light-on-color: isolate them (threshold) then invert
  // to black-on-white for OCR. Rules text is dark-on-light: just sharpen.
  s = opts.digits ? s.threshold(175).negate() : s.sharpen();
  return s.png().toBuffer();
}

async function ocr(worker: Worker, buf: Buffer): Promise<{ text: string; conf: number }> {
  const { data } = await worker.recognize(buf);
  return { text: data.text.trim(), conf: data.confidence };
}

function guessType(typeLineText: string): { type: string | null; conf: 'match' | 'none' } {
  const t = correct(typeLineText).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ');
  const has = (w: string) => t.includes(w);
  // Order matters: check compound types before the bare "combat".
  if (has('physical') && has('combat')) return { type: 'Physical Combat', conf: 'match' };
  if (has('energy') && has('combat')) return { type: 'Energy Combat', conf: 'match' };
  if ((has('non') || has('non-')) && has('combat')) return { type: 'Non-Combat', conf: 'match' };
  if (has('dragon') && has('ball')) return { type: 'Dragon Ball', conf: 'match' };
  if (has('battleground') || has('location')) return { type: 'Location', conf: 'match' };
  for (const ct of ['Drill', 'Mastery', 'Sensei', 'Combat']) {
    if (has(ct.toLowerCase())) return { type: ct, conf: 'match' };
  }
  return { type: null, conf: 'none' };
}

/** Parse the digit ladder into power ratings (bottom stage 0 first). */
function parseLadder(text: string): { ratings: Array<number | 'Z'>; suspect: boolean } {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[^0-9Z]/gi, '').trim())
    .filter(Boolean);
  const ratings: Array<number | 'Z'> = [];
  for (const l of lines) {
    if (/^Z+$/i.test(l)) ratings.push('Z');
    else {
      const n = Number(l);
      if (Number.isFinite(n)) ratings.push(n);
    }
  }
  // Ladder is printed top(highest)->bottom(00); reverse to stage 0..N.
  ratings.reverse();
  // Suspect if empty, or (numeric) not strictly increasing.
  let suspect = ratings.length < 3;
  const nums = ratings.filter((r): r is number => typeof r === 'number');
  for (let i = 1; i < nums.length; i++) if (nums[i]! <= nums[i - 1]!) suspect = true;
  return { ratings, suspect };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dbz-sim ocr)' } });
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  await sleep(200);
}

interface OcrRecord {
  id: string;
  number: number | null;
  name: string;
  isPersonality: boolean;
  personalityName?: string;
  level?: number;
  variant?: string;
  type: string | null;
  typeLineRaw?: string;
  text?: string;
  powerRatings?: Array<number | 'Z'>;
  pur?: number | null;
  levelNum?: number | null;
  confidence: Record<string, number>;
  needsReview: string[];
}

async function processCard(
  card: Card,
  textWorker: Worker,
  digitWorker: Worker,
): Promise<OcrRecord> {
  const path = join(imgDir, `${card.id}.jpg`);
  await download(card.imageUrl, path);
  const meta = await sharp(path).metadata();
  const w = meta.width ?? 400;
  const h = meta.height ?? 550;

  const rec: OcrRecord = {
    id: card.id,
    number: card.number,
    name: card.name,
    isPersonality: isPersonality(card.name),
    type: null,
    confidence: {},
    needsReview: [],
  };

  if (rec.isPersonality) {
    const pn = parsePersonalityName(card.name);
    rec.personalityName = pn.personalityName;
    rec.level = pn.level;
    if (pn.variant) rec.variant = pn.variant;
    rec.type = 'Personality';

    const ladder = await ocr(digitWorker, await regionBuffer(path, REGIONS.powerColumn, w, h, { digits: true }));
    const parsed = parseLadder(ladder.text);
    rec.powerRatings = parsed.ratings;
    rec.confidence.powerColumn = ladder.conf;
    if (parsed.suspect || ladder.conf < 70) rec.needsReview.push('powerRatings');

    const purR = await ocr(digitWorker, await regionBuffer(path, REGIONS.pur, w, h, { digits: true }));
    const purNum = Number((purR.text.match(/\d+/) ?? [''])[0]);
    rec.pur = Number.isFinite(purNum) ? purNum : null;
    rec.confidence.pur = purR.conf;
    if (rec.pur == null || purR.conf < 60) rec.needsReview.push('pur');

    const power = await ocr(textWorker, await regionBuffer(path, REGIONS.powerText, w, h));
    rec.text = correct(power.text);
    rec.confidence.text = power.conf;
    if (power.conf < 55) rec.needsReview.push('text');
  } else {
    const typeR = await ocr(textWorker, await regionBuffer(path, REGIONS.typeLine, w, h));
    rec.typeLineRaw = typeR.text.replace(/\n/g, ' ').trim();
    const guessed = guessType(typeR.text);
    rec.type = guessed.type;
    rec.confidence.typeLine = typeR.conf;
    if (guessed.conf === 'none') rec.needsReview.push('type');

    const textR = await ocr(textWorker, await regionBuffer(path, REGIONS.textBox, w, h));
    rec.text = correct(textR.text);
    rec.confidence.text = textR.conf;
    if (textR.conf < 55) rec.needsReview.push('text');
  }
  return rec;
}

async function main() {
  const args = process.argv.slice(2);
  const saga = (args.find((a) => a.startsWith('--saga='))?.split('=')[1] ?? 'saiyan').toLowerCase();
  const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : Infinity;
  const onlyArg = args.find((a) => a.startsWith('--only='))?.split('=')[1];
  const onlyNums = onlyArg ? new Set(onlyArg.split(',').map((n) => Number(n))) : null;

  await mkdir(imgDir, { recursive: true });
  await mkdir(ocrDir, { recursive: true });

  const cards: Card[] = JSON.parse(await readFile(join(dataDir, `cards.${saga}.json`), 'utf8'));
  const filtered = onlyNums ? cards.filter((c) => c.number != null && onlyNums.has(c.number)) : cards;
  const todo = filtered.slice(0, limit);
  console.log(`OCR ${todo.length}/${cards.length} cards (saga=${saga})...`);

  console.log('Starting Tesseract workers...');
  const textWorker = await createWorker('eng');
  await textWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  const digitWorker = await createWorker('eng');
  await digitWorker.setParameters({
    tessedit_char_whitelist: '0123456789Z',
    tessedit_pageseg_mode: PSM.SPARSE_TEXT, // scattered pills; SINGLE_COLUMN returns empty
  });

  const out: OcrRecord[] = [];
  let i = 0;
  for (const card of todo) {
    i++;
    try {
      const rec = await processCard(card, textWorker, digitWorker);
      out.push(rec);
      await writeFile(join(ocrDir, `${card.id}.json`), JSON.stringify(rec, null, 2), 'utf8');
      const flag = rec.needsReview.length ? ` ⚠ ${rec.needsReview.join(',')}` : '';
      process.stdout.write(`  [${i}/${todo.length}] ${card.name} -> ${rec.type ?? '?'}${flag}\n`);
    } catch (err) {
      console.warn(`  [${i}/${todo.length}] ${card.name}: ERROR ${(err as Error).message}`);
    }
  }

  await textWorker.terminate();
  await digitWorker.terminate();

  await writeFile(join(dataDir, `ocr.${saga}.json`), JSON.stringify(out, null, 2), 'utf8');
  const review = out.filter((r) => r.needsReview.length).length;
  console.log(`\nWrote ${out.length} records -> data/ocr.${saga}.json`);
  console.log(`Flagged for review: ${review}/${out.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

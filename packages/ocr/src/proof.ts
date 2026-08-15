/**
 * OCR proof-of-concept: download a few diverse Saiyan cards and OCR them
 * (full image + a cropped text-box rectangle) to gauge raw Tesseract quality
 * before building the batch pipeline.
 *
 *   node --experimental-strip-types src/proof.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorker } from 'tesseract.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dataDir = join(root, 'data');
const imgDir = join(dataDir, 'images');

interface Card { id: string; number: number | null; name: string; imageUrl: string }

// Cards are 400x550. Regions are in source pixels.
const SAMPLE_NUMBERS = [158, 43, 17, 28]; // Goku LV1, Senzu Bean, Hidden Power Level, Vegeta's Physical Attack

async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dbz-sim ocr)' } });
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

async function main() {
  await mkdir(imgDir, { recursive: true });
  const cards: Card[] = JSON.parse(await readFile(join(dataDir, 'cards.saiyan.json'), 'utf8'));
  const samples = SAMPLE_NUMBERS.map((n) => cards.find((c) => c.number === n)).filter(
    (c): c is Card => !!c,
  );

  console.log('Downloading samples...');
  for (const c of samples) {
    const dest = join(imgDir, `${c.id}.jpg`);
    await download(c.imageUrl, dest);
    console.log(`  ${c.name} -> ${dest}`);
  }

  console.log('\nInitializing Tesseract (first run downloads eng.traineddata)...');
  const worker = await createWorker('eng');

  for (const c of samples) {
    const path = join(imgDir, `${c.id}.jpg`);
    console.log(`\n${'='.repeat(70)}\n#${c.number} ${c.name}\n${'='.repeat(70)}`);

    const full = await worker.recognize(path);
    console.log('--- FULL IMAGE ---');
    console.log(full.data.text.trim() || '(empty)');
    console.log(`  [mean confidence: ${full.data.confidence.toFixed(0)}]`);

    // Bottom ~40% = rules text box (cards are ~400x550).
    const box = await worker.recognize(path, {
      rectangle: { left: 10, top: 335, width: 380, height: 205 },
    });
    console.log('--- TEXT-BOX CROP (bottom ~40%) ---');
    console.log(box.data.text.trim() || '(empty)');
    console.log(`  [mean confidence: ${box.data.confidence.toFixed(0)}]`);
  }

  await worker.terminate();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

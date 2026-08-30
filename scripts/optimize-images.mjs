/**
 * Web-size the sliced card faces.
 *
 * The slices out of the Tabletop Simulator atlases average 206KB and total
 * 541MB across 2,764 cards. That is fine on the machine that made them and
 * miserable through a tunnel, which is how friends actually connect. This
 * writes a smaller WebP beside each one; the server prefers those when they
 * exist and falls back to the originals when they do not, so running this is
 * optional and reversible (delete data/images-web to undo).
 *
 * The originals are never modified — they are the OCR/vision source of truth
 * and re-deriving them from the mod takes hours.
 *
 *   node scripts/optimize-images.mjs [--width 600] [--quality 78]
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'data', 'images-tts');
const outDir = join(root, 'data', 'images-web');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const WIDTH = arg('width', 600);
const QUALITY = arg('quality', 78);

if (!existsSync(srcDir)) {
  console.error(`No ${srcDir} — run the TTS slice pipeline first.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const files = readdirSync(srcDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
let done = 0;
let skipped = 0;
let srcBytes = 0;
let outBytes = 0;

console.log(`${files.length} images -> ${WIDTH}px WebP q${QUALITY}`);

for (const f of files) {
  const src = join(srcDir, f);
  const out = join(outDir, f.replace(/\.(jpg|jpeg|png)$/i, '.webp'));
  srcBytes += statSync(src).size;

  // Resume-friendly: a re-run only does what is missing.
  if (existsSync(out)) {
    outBytes += statSync(out).size;
    skipped++;
    continue;
  }
  try {
    await sharp(src).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: QUALITY }).toFile(out);
    outBytes += statSync(out).size;
    done++;
    if (done % 200 === 0) console.log(`  ${done + skipped}/${files.length}`);
  } catch (err) {
    console.error(`  failed on ${f}: ${err.message}`);
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
console.log(`\nconverted ${done}, reused ${skipped}`);
console.log(`${mb(srcBytes)} -> ${mb(outBytes)} (${Math.round((1 - outBytes / srcBytes) * 100)}% smaller)`);
console.log('The server serves these automatically; delete data/images-web to go back.');

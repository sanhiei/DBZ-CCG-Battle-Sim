/**
 * Slices every card face out of the TTS atlases into data/images-tts/.
 *
 *   npm run slice -w @dbz/tts -- [--only <n>] [--out <dir>]
 *
 * Resume-safe: cards whose slice already exists are skipped, so an interrupted
 * run can simply be re-run. Writes an index.json mapping card id -> metadata.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCacheIndex, findCached, ttsImageCacheDir } from './cache.js';
import { downloadAtlas, sliceAtlas } from './slice.js';
import type { TtsCard } from './types.js';

interface CatalogFile {
  atlases: Array<{ faceUrl: string; numWidth: number; numHeight: number; cards: number; cachedPath: string | null }>;
  cards: TtsCard[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const mb = (n: number) => `${(n / 1048576).toFixed(0)}MB`;

async function main(): Promise<void> {
  const root = repoRoot();
  const catalogPath = join(root, 'data', 'cards.tts.json');
  if (!existsSync(catalogPath)) {
    console.error(`[slice] ${catalogPath} not found — run \`npm run extract:tts\` first`);
    process.exit(1);
  }

  const outDir = arg('out') ?? join(root, 'data', 'images-tts');
  const downloadDir = join(root, 'data', 'atlas-cache');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogFile;
  const cache = buildCacheIndex(ttsImageCacheDir());

  // Group cards by the atlas they live on so each sheet is decoded once.
  const byAtlas = new Map<string, TtsCard[]>();
  for (const card of catalog.cards) {
    if (!card.atlas.faceUrl) continue;
    const list = byAtlas.get(card.atlas.faceUrl);
    if (list) list.push(card);
    else byAtlas.set(card.atlas.faceUrl, [card]);
  }

  const limit = arg('only') ? Number(arg('only')) : Infinity;
  const atlases = [...byAtlas.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, limit);

  mkdirSync(outDir, { recursive: true });
  console.log(`[slice] ${catalog.cards.length} cards across ${byAtlas.size} atlases -> ${outDir}`);

  let written = 0;
  let skipped = 0;
  let failed = 0;
  const missing: string[] = [];
  const started = Date.now();

  for (const [index, [faceUrl, cards]] of atlases.entries()) {
    const label = `[${index + 1}/${atlases.length}]`;
    let atlasPath = findCached(faceUrl, cache);

    if (!atlasPath) {
      const name = `${faceUrl.replace(/[^a-zA-Z0-9]/g, '').slice(-40)}.img`;
      try {
        process.stdout.write(`${label} downloading ${cards.length} cards... `);
        atlasPath = await downloadAtlas(faceUrl, downloadDir, name);
        console.log(`ok (${mb(statSync(atlasPath).size)})`);
      } catch (err) {
        console.log(`FAILED: ${String(err)}`);
        missing.push(faceUrl);
        failed += cards.length;
        continue;
      }
    }

    try {
      const stats = await sliceAtlas(atlasPath, cards, outDir);
      written += stats.written;
      skipped += stats.skipped;
      failed += stats.failed;
      const note = stats.skipped ? ` (${stats.skipped} already present)` : '';
      console.log(`${label} ${stats.written} sliced${note}${stats.failed ? `, ${stats.failed} failed` : ''}`);
    } catch (err) {
      console.log(`${label} atlas FAILED: ${String(err)}`);
      failed += cards.length;
    }
  }

  // Manifest so the OCR pass and the client can find a card's face.
  const index = catalog.cards
    .map((c) => ({ id: c.id, name: c.name, saga: c.saga, file: `${c.id}.jpg` }))
    .filter((c) => existsSync(join(outDir, c.file)));
  writeFileSync(join(outDir, 'index.json'), JSON.stringify({ count: index.length, cards: index }, null, 2));

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n[slice] done in ${secs}s — ${written} written, ${skipped} skipped, ${failed} failed`);
  console.log(`[slice] ${index.length}/${catalog.cards.length} cards have a face on disk`);
  if (missing.length) {
    console.log(`[slice] ${missing.length} atlas(es) could not be fetched:`);
    for (const url of missing) console.log(`[slice]   ${url}`);
  }
}

main().catch((err: unknown) => {
  console.error('[slice] fatal:', err);
  process.exit(1);
});

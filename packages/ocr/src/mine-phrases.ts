/**
 * Mines sentence templates from data/ocr.tts.json and writes them to
 * data/phrases.tts.json for the corrector, printing the top templates so a
 * human can sanity-check what the corpus believes its own wording is.
 *
 *   node --experimental-strip-types src/mine-phrases.ts [--min=8] [--show=40]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mineTemplates } from './phrases.ts';
import type { OcrRecord } from './shared.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (flag: string, fb: number) => {
    const raw = args.find((a) => a.startsWith(`--${flag}=`))?.split('=')[1];
    return raw && Number.isFinite(Number(raw)) ? Number(raw) : fb;
  };
  const minCount = num('min', 8);
  const show = num('show', 40);

  const records = JSON.parse(await readFile(join(dataDir, 'ocr.tts.json'), 'utf8')) as OcrRecord[];
  const texts = records.map((r) => r.text ?? '').filter(Boolean);
  const templates = mineTemplates(texts, minCount);

  await writeFile(join(dataDir, 'phrases.tts.json'), JSON.stringify({ minCount, templates }, null, 2), 'utf8');
  console.log(`[mine] ${texts.length} texts -> ${templates.length} templates (count >= ${minCount})`);
  for (const t of templates.slice(0, show)) {
    console.log(`  ${String(t.count).padStart(4)}  ${t.canonical.slice(0, 100)}`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

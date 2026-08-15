/**
 * Extracts the card catalog from a Tabletop Simulator mod into data/cards.tts.json.
 *
 *   npm run extract -w @dbz/tts -- [--mod <id-or-path>] [--out <file>] [--tts <dir>]
 *
 * Defaults to the "Dragon Ball Z Score CCG - All Sagas" workshop mod.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCacheIndex, DEFAULT_TTS_DIR, findCached, workshopDir } from './cache.js';
import { extractCards } from './parse.js';
import type { TtsSave } from './types.js';

/** "Dragon Ball Z Score CCG - All Sagas (Errata on Cards)". */
export const DBZ_MOD_ID = '2132906085';

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

function resolveModPath(spec: string, ttsDir: string): string {
  if (isAbsolute(spec) || spec.includes('/') || spec.includes('\\')) return resolve(spec);
  return join(workshopDir(ttsDir), `${spec}.json`);
}

function main(): void {
  const ttsDir = arg('tts') ?? process.env.TTS_DIR ?? DEFAULT_TTS_DIR;
  const modPath = resolveModPath(arg('mod') ?? DBZ_MOD_ID, ttsDir);
  const outPath = arg('out') ?? join(repoRoot(), 'data', 'cards.tts.json');

  if (!existsSync(modPath)) {
    console.error(`[tts] mod not found: ${modPath}`);
    console.error('[tts] pass --mod <workshop-id|path>, or --tts <Tabletop Simulator dir>');
    process.exit(1);
  }

  console.log(`[tts] reading ${modPath}`);
  const save = JSON.parse(readFileSync(modPath, 'utf8')) as TtsSave;
  const result = extractCards(save);

  // Report how much of the imagery is already on disk vs. needs downloading.
  const index = buildCacheIndex(join(ttsDir, 'Mods', 'Images'));
  let cached = 0;
  const missing: string[] = [];
  for (const atlas of result.atlases) {
    if (findCached(atlas.faceUrl, index)) cached++;
    else missing.push(atlas.faceUrl);
  }

  const payload = {
    source: { mod: modPath, saveName: result.saveName },
    stats: { ...result.stats, atlases: result.atlases.length, atlasesCached: cached },
    atlases: result.atlases.map((a) => ({ ...a, cachedPath: findCached(a.faceUrl, index) ?? null })),
    cards: result.cards,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const s = result.stats;
  console.log(`[tts] ${s.cardObjects} card objects -> ${s.uniqueCards} unique cards`);
  console.log(`[tts] errata notes: ${s.withErrata}   unresolved atlas: ${s.unresolvedAtlas}`);
  console.log(`[tts] by saga: ${Object.entries(s.bySaga).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`[tts] atlases: ${result.atlases.length} (${cached} cached locally, ${missing.length} to download)`);
  for (const url of missing.slice(0, 10)) console.log(`[tts]   missing: ${url}`);
  console.log(`[tts] wrote ${outPath}`);
}

main();

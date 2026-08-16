/** Loads the scraped card catalog off disk and indexes it for the engine. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardDb, type EngineCard } from '@dbz/engine';

export interface Catalog {
  db: CardDb;
  /** Flat card list, for the client's card browser. */
  cards: EngineCard[];
  /** Files the catalog was built from. */
  sources: string[];
}

/** Walk up from this file (or $DBZ_DATA_DIR) to find the repo's `data/` directory. */
export function findDataDir(): string {
  const override = process.env.DBZ_DATA_DIR;
  if (override) return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'data');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate data/ directory — set DBZ_DATA_DIR');
}

/**
 * Reads every `cards.*.json` in `dataDir`. Enriched files (which carry the
 * `rules` block the engine needs) win outright when present; later files
 * override earlier ones by card id.
 */
export function loadCatalog(dataDir: string = findDataDir()): Catalog {
  const all = readdirSync(dataDir).filter((f) => f.startsWith('cards.') && f.endsWith('.json'));
  const enriched = all.filter((f) => f.endsWith('.enriched.json'));
  const sources = (enriched.length ? enriched : all).sort();
  if (sources.length === 0) throw new Error(`no cards.*.json found in ${dataDir} — run \`npm run scrape\``);

  const byId = new Map<string, EngineCard>();
  for (const file of sources) {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
    const list = (Array.isArray(raw) ? raw : (raw as { cards?: EngineCard[] }).cards ?? []) as EngineCard[];
    for (const card of list) if (card?.id) byId.set(card.id, card);
  }

  // The gallery catalogs (`saiyan-saga-*`) and the TTS import (`tts-*`) cover
  // the same physical cards under different ids, so one must win per saga or
  // every Saiyan card appears twice and deck ids turn ambiguous.
  //
  // TTS wins. Its data is triangulated — typed LackeyCCG values, vision reads
  // of the card faces, and OCR, cross-checked against each other — while the
  // gallery block is single-source OCR of 400x550 scans. That gap is not
  // theoretical: gallery Tien Lv1 lists [100..1000], missing the zero rung
  // entirely (so every stage reads one rung high), and Lv2 is scrambled
  // ([...800,300,1000,110,1200...]). The TTS entries for the same cards carry
  // the correct [0,100..1000] plus PUR and alignment.
  const ttsSagas = new Set([...byId.values()].filter((c) => c.id.startsWith('tts-')).map((c) => c.saga));
  const cards = [...byId.values()].filter((c) => !(!c.id.startsWith('tts-') && ttsSagas.has(c.saga)));
  return { db: new CardDb(cards), cards, sources };
}

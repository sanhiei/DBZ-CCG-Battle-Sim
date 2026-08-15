/**
 * DBZ CCG card scraper.
 *
 * Crawls the retrodbzccg.com set galleries (Jetpack tiled galleries) and produces
 * a structured catalog at data/cards.json. Each card image is an <img> whose
 * `data-orig-file` is the clean image URL and whose `data-image-title` / `alt`
 * is "<number> <Style> <Name>".
 *
 * Dependency-free: native fetch + regex. Run with Node >= 22 (native TS strip):
 *   node --experimental-strip-types src/scrape.ts [--saga=saiyan|all] [--images]
 *
 * The output shape mirrors CatalogCard in @dbz/shared (kept local so this script
 * runs without building the workspace).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STYLES = ['Red', 'Blue', 'Orange', 'Black', 'Saiyan', 'Namekian', 'Freestyle'] as const;
type Style = (typeof STYLES)[number];
const STYLE_SET = new Set<string>(STYLES);

type Saga =
  | 'Saiyan' | 'Frieza' | 'Trunks' | 'Androids' | 'Cell' | 'Cell Games'
  | 'World Games' | 'Babidi' | 'Buu' | 'Fusion' | 'Kid Buu' | 'Promo' | 'Subset' | 'Other';
type Rarity =
  | 'Common' | 'Uncommon' | 'Rare' | 'Ultra Rare' | 'Starter'
  | 'Promo' | 'Preview' | 'Fixed' | 'Unknown';

interface CatalogCard {
  id: string;
  number: number | null;
  name: string;
  style: Style | null;
  saga: Saga;
  rarity: Rarity;
  imageUrl: string;
  setSlug: string;
  rawLabel: string;
}

/** Each gallery page => saga + rarity. */
interface SetDef { slug: string; saga: Saga; rarity: Rarity }

const HOST = 'https://retrodbzccg.com/card-images';

/** Build the standard 4-6 gallery slugs a main saga uses. */
function mainSaga(prefix: string, saga: Saga, opts: { starter?: boolean } = {}): SetDef[] {
  const sets: SetDef[] = [
    { slug: `${prefix}-commons`, saga, rarity: 'Common' },
    { slug: `${prefix}-uncommons`, saga, rarity: 'Uncommon' },
    { slug: `${prefix}-rares`, saga, rarity: 'Rare' },
    { slug: `${prefix}-ultra-rares`, saga, rarity: 'Ultra Rare' },
    { slug: `${prefix}-promos`, saga, rarity: 'Promo' },
  ];
  if (opts.starter) sets.push({ slug: `${prefix}-starter`, saga, rarity: 'Starter' });
  return sets;
}

/** The 11 main sagas. Subsets/previews/promos can be added over time. */
const SETS: Record<string, SetDef[]> = {
  saiyan: mainSaga('saiyan-saga', 'Saiyan', { starter: true }),
  frieza: mainSaga('frieza-saga', 'Frieza'),
  trunks: mainSaga('trunks-saga', 'Trunks', { starter: true }),
  androids: mainSaga('androids-saga', 'Androids'),
  cell: mainSaga('cell-saga', 'Cell', { starter: true }),
  'cell-games': mainSaga('cell-games-saga', 'Cell Games'),
  'world-games': mainSaga('world-games-saga', 'World Games', { starter: true }),
  babidi: mainSaga('babidi-saga', 'Babidi'),
  buu: mainSaga('buu-saga', 'Buu', { starter: true }),
  fusion: mainSaga('fusion-saga', 'Fusion'),
  'kid-buu': mainSaga('kid-buu-saga', 'Kid Buu'),
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]!) : null;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Parse "60 Blue One-Arm Shoulder Throw" -> {number, style, name}. */
function parseLabel(label: string): { number: number | null; style: Style | null; name: string } {
  const clean = label.replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(\d+)\s+(.*)$/);
  let number: number | null = null;
  let rest = clean;
  if (m) {
    number = Number(m[1]);
    rest = m[2]!;
  }
  const first = rest.split(' ')[0] ?? '';
  if (STYLE_SET.has(first)) {
    return { number, style: first as Style, name: rest.slice(first.length).trim() || rest };
  }
  return { number, style: null, name: rest };
}

/** Extract card entries from one gallery page's HTML. */
function parseGallery(html: string, set: SetDef): CatalogCard[] {
  const cards: CatalogCard[] = [];
  const seen = new Set<string>();
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    const orig = attr(tag, 'data-orig-file');
    const src = attr(tag, 'src');
    const raw = orig ?? (src ? src.split('?')[0]! : null);
    if (!raw || !/wp-content\/uploads/i.test(raw)) continue;
    const imageUrl = raw;
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const label =
      attr(tag, 'data-image-title') ?? attr(tag, 'alt') ?? attr(tag, 'title') ?? '';
    if (!label) continue;
    const { number, style, name } = parseLabel(label);
    const idKey = number != null ? String(number) : slugify(name);
    cards.push({
      id: `${set.slug}-${idKey}`,
      number,
      name,
      style,
      saga: set.saga,
      rarity: set.rarity,
      imageUrl,
      setSlug: set.slug,
      rawLabel: label,
    });
  }
  return cards;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSet(set: SetDef): Promise<CatalogCard[]> {
  const url = `${HOST}/${set.slug}/`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dbz-sim scraper)' } });
    if (!res.ok) {
      console.warn(`  [skip] ${set.slug} -> HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const cards = parseGallery(html, set);
    console.log(`  ${set.slug}: ${cards.length} cards`);
    return cards;
  } catch (err) {
    console.warn(`  [error] ${set.slug}: ${(err as Error).message}`);
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sagaArg = (args.find((a) => a.startsWith('--saga='))?.split('=')[1] ?? 'saiyan').toLowerCase();

  let sets: SetDef[];
  if (sagaArg === 'all') {
    sets = Object.values(SETS).flat();
  } else if (SETS[sagaArg]) {
    sets = SETS[sagaArg]!;
  } else {
    console.error(`Unknown saga "${sagaArg}". Options: all, ${Object.keys(SETS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Scraping ${sets.length} gallery pages (saga=${sagaArg})...`);
  const all: CatalogCard[] = [];
  const byId = new Map<string, CatalogCard>();
  for (const set of sets) {
    const cards = await fetchSet(set);
    for (const c of cards) {
      // Dedup across galleries by id; keep first seen.
      if (!byId.has(c.id)) {
        byId.set(c.id, c);
        all.push(c);
      }
    }
    await sleep(400); // be polite
  }

  all.sort((a, b) =>
    a.saga === b.saga ? (a.number ?? 9999) - (b.number ?? 9999) : a.saga.localeCompare(b.saga),
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(here, '..', '..', '..', 'data');
  await mkdir(dataDir, { recursive: true });
  const outFile = join(dataDir, sagaArg === 'all' ? 'cards.json' : `cards.${sagaArg}.json`);
  await writeFile(outFile, JSON.stringify(all, null, 2), 'utf8');

  const styles = new Map<string, number>();
  for (const c of all) styles.set(c.style ?? '(none)', (styles.get(c.style ?? '(none)') ?? 0) + 1);
  console.log(`\nWrote ${all.length} cards -> ${outFile}`);
  console.log('By style:', Object.fromEntries([...styles].sort()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

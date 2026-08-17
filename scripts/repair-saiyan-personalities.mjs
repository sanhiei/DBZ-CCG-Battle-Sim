/**
 * Repairs personality data in the gallery catalog from the typed LackeyCCG rows.
 *
 * cards.saiyan.enriched.json predates the triangulated pipeline: its power
 * ladders came from OCR of 400x550 scans and are visibly corrupt (rungs out of
 * order, missing the zero rung, duplicated values). The server no longer loads
 * this block — TTS supersedes it for any saga TTS covers — but shipping data
 * that is known to be wrong is a trap for anyone who reads it, so the ladders,
 * PUR, level and alignment are restored from the hand-typed Lackey rows.
 *
 *   node scripts/repair-saiyan-personalities.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');

const cards = JSON.parse(readFileSync(join(dataDir, 'cards.saiyan.enriched.json'), 'utf8'));
const lackey = JSON.parse(readFileSync(join(dataDir, 'cards.lackey.json'), 'utf8'));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Saiyan-saga personalities from the typed data, keyed by name + level.
const typed = new Map();
for (const lc of lackey) {
  if (lc.saga !== 'Saiyan' || !lc.isPersonality || !lc.ladder?.length) continue;
  typed.set(`${norm(lc.nameBare)}|${lc.level ?? ''}`, lc);
}

let repaired = 0;
let unmatched = 0;

for (const c of cards) {
  const p = c.rules?.personality;
  if (!p) continue;
  const key = `${norm(p.personalityName)}|${p.level ?? ''}`;
  const lc = typed.get(key);
  if (!lc) {
    unmatched++;
    (c.rules.needsReview ??= []).push('personality:noTypedSource');
    continue;
  }
  p.powerRatings = lc.ladder;
  p.zeroStageIndex = 0;
  if (lc.pur != null) p.pur = lc.pur;
  if (lc.alignment) p.alignment = lc.alignment;
  p.source = 'lackey';
  repaired++;
}

writeFileSync(join(dataDir, 'cards.saiyan.enriched.json'), JSON.stringify(cards, null, 2));
console.log(`repaired ${repaired} personalities from typed data; ${unmatched} had no typed row`);

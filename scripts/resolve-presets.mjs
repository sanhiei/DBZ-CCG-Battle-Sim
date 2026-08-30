/**
 * Resolve the hand-written preset decks to catalog card ids.
 *
 * The lists are typed from real decklists, so the names are the PRINTED names
 * — which will not always match our OCR'd catalog exactly. Rather than guess,
 * this matches exactly first, then on a normalised key (case, punctuation and
 * spelling of "maneuver"), and reports every name it could not place so the
 * gap is visible instead of becoming a silently smaller deck.
 *
 *   node scripts/resolve-presets.mjs [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cards = JSON.parse(readFileSync(join(root, 'data', 'cards.tts.enriched.json'), 'utf8'));
const presets = JSON.parse(readFileSync(join(root, 'data', 'preset-decks.json'), 'utf8'));
const write = process.argv.includes('--write');

/** Fold the differences that are spelling rather than identity. */
const key = (s) =>
  s
    .toLowerCase()
    .replace(/manuever|manoeuvre/g, 'maneuver')
    .replace(/[^a-z0-9]+/g, '')
    // "Android 20's Absorbing Drill" and "Android 20 Absorbing Drill" are the
    // same card; the possessive after a number is not part of its identity.
    .replace(/(\d)s(?=[a-z])/g, '$1');

const byKey = new Map();
for (const c of cards) {
  const k = key(c.name);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(c);
}

/** Prefer a card that is not a personality unless we are looking for one. */
function pick(name, { personality = false, mastery = false } = {}) {
  const hits = byKey.get(key(name)) ?? [];
  const filtered = hits.filter((c) => {
    const isPers = !!c.rules?.personality;
    const isMastery = c.rules?.type === 'Mastery';
    if (personality) return isPers;
    if (mastery) return isMastery;
    return !isPers;
  });
  return (filtered[0] ?? (personality || mastery ? undefined : hits[0])) ?? undefined;
}

const personalities = cards.filter((c) => c.rules?.personality?.level);

/**
 * Resolve the Main Personality stack.
 *
 * Names alone are not enough: a deck needs levels 1..N with no gaps, and a
 * character has several printings of each level. So each listed name is matched
 * against the printing whose LEVEL matches its position. A single name is taken
 * as the character ("Guldo 1-3") and its own levels 1..3 are used.
 */
function resolveMp(names, deckId) {
  const wantLevels = Math.max(3, names.length);
  if (names.length === 1) {
    const pool = personalities.filter((c) => key(c.rules.personality.personalityName) === key(names[0]));
    const out = [];
    for (let lv = 1; lv <= wantLevels; lv++) {
      const hit = pool.find((c) => c.rules.personality.level === lv);
      if (hit) out.push(hit.id);
      else misses.push(`${deckId}: MP "${names[0]}" level ${lv}`);
    }
    return out;
  }
  const out = [];
  names.forEach((n, i) => {
    const lv = i + 1;
    const hits = (byKey.get(key(n)) ?? []).filter((c) => c.rules?.personality?.level);
    const atLevel = hits.find((c) => c.rules.personality.level === lv);
    if (atLevel) {
      out.push(atLevel.id);
      return;
    }
    // The named printing is not at this level in our catalog — either the card
    // sits at a different level here or we read its level wrong. Fall back to
    // the same CHARACTER's printing at the level the deck needs, and say so,
    // rather than leaving a gap that makes the whole stack illegal.
    const character = hits[0]?.rules.personality.personalityName ?? key(n);
    const sub = personalities.find(
      (c) => key(c.rules.personality.personalityName) === key(character) && c.rules.personality.level === lv,
    );
    if (sub) {
      out.push(sub.id);
      substitutions.push(`${deckId}: level ${lv} "${n}" -> "${sub.name}" [${sub.saga}]${hits.length ? ` ("${n}" is level ${hits.map((h) => h.rules.personality.level).join('/')} here)` : ''}`);
    } else {
      misses.push(`${deckId}: MP "${n}" at level ${lv}`);
    }
  });
  return out;
}

/**
 * Dragon Balls must all come from one set (CRD ~L57), and the same ball is
 * printed in several. Pick the saga that can supply every ball the deck wants.
 */
function sameSetBalls(wanted) {
  const bySaga = new Map();
  for (const [, name] of wanted) {
    for (const c of byKey.get(key(name)) ?? []) {
      if (!/dragon ball/i.test(c.rules?.type ?? '')) continue;
      if (!bySaga.has(c.saga)) bySaga.set(c.saga, new Map());
      bySaga.get(c.saga).set(key(name), c);
    }
  }
  for (const [, found] of [...bySaga.entries()].sort((a, b) => b[1].size - a[1].size)) {
    if (found.size === wanted.length) return found;
  }
  return null;
}

const out = [];
const misses = [];
const substitutions = [];

for (const d of presets.decks) {
  const mpLevels = resolveMp(d.mpLevels, d.id);

  const mastery = d.mastery ? pick(d.mastery, { mastery: true }) : undefined;
  if (d.mastery && !mastery) misses.push(`${d.id}: mastery "${d.mastery}"`);

  // Dragon Balls first, so they all come from one set.
  const ballLines = d.life.filter(([, n]) => /dragon ball/i.test(n));
  const ballSet = ballLines.length ? sameSetBalls(ballLines) : null;
  if (ballLines.length && !ballSet) misses.push(`${d.id}: no single set holds all ${ballLines.length} Dragon Balls`);

  const life = [];
  for (const [qty, n] of d.life) {
    const fromSet = ballSet?.get(key(n));
    const c = fromSet ?? pick(n);
    if (c) life.push({ cardId: c.id, qty });
    else misses.push(`${d.id}: ${qty}x "${n}"`);
  }

  const count = mpLevels.length + (mastery ? 1 : 0) + life.reduce((s, l) => s + l.qty, 0);
  out.push({
    id: d.id,
    name: d.name,
    blurb: d.blurb,
    mpLevels,
    ...(mastery ? { masteryId: mastery.id } : {}),
    life,
    resolvedCount: count,
  });
  console.log(`${d.name.padEnd(24)} ${String(count).padStart(3)} cards  (${life.length}/${d.life.length} lines, ${mpLevels.length}/${d.mpLevels.length} MP levels)`);
}

if (substitutions.length) {
  console.log(`
${substitutions.length} level substitution(s):`);
  for (const s of substitutions) console.log(`  ~ ${s}`);
}

if (misses.length) {
  console.log(`\n${misses.length} name(s) not found in the catalog:`);
  for (const m of misses) console.log(`  ✖ ${m}`);
} else {
  console.log('\nEvery name resolved.');
}

if (write) {
  const path = join(root, 'data', 'preset-decks.resolved.json');
  writeFileSync(path, `${JSON.stringify({ generated: 'resolve-presets', decks: out }, null, 2)}\n`);
  console.log(`\nwrote ${path}`);
}

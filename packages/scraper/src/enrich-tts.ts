/**
 * Fuses the TTS catalog (cards.tts.json) with its OCR pass (ocr.tts.json) into
 * data/cards.tts.enriched.json — the engine-ready, all-sagas catalog.
 *
 *   node --experimental-strip-types src/enrich-tts.ts
 *
 * Coverage ladder per card (same model as the Saiyan catalog):
 *   unknown  — catalog entry only, no usable OCR
 *   metadata — type known, no modelled abilities
 *   partial  — abilities parsed from text (still need human verification)
 *   full     — never assigned here; requires human sign-off against the CRD
 *
 * Personality cards additionally carry the scouter ladder, level and PUR read
 * from the face; every field that failed to read stays absent and is listed in
 * rules.needsReview rather than being guessed.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbility } from '@dbz/engine';
// Reaching into the OCR package's source is deliberate: the corrector operates
// on OCR output and lives with the OCR calibration tooling.
import { correctText, type Template } from '../../ocr/src/phrases.ts';
import { correct } from '../../ocr/src/shared.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '..', 'data');

interface TtsCard {
  id: string;
  name: string;
  saga: string;
  containers: string[];
  errata?: string;
  copies: number;
}

interface OcrRec {
  id: string;
  name: string;
  saga?: string;
  isPersonality: boolean;
  type: string | null;
  text?: string;
  powerRatings?: Array<number | 'Z'>;
  pur?: number | null;
  level?: number;
  confidence: Record<string, number>;
  needsReview: string[];
}

async function main(): Promise<void> {
  const catalog = JSON.parse(await readFile(join(dataDir, 'cards.tts.json'), 'utf8')) as { cards: TtsCard[] };
  const ocr = JSON.parse(await readFile(join(dataDir, 'ocr.tts.json'), 'utf8')) as OcrRec[];
  const ocrById = new Map(ocr.map((r) => [r.id, r]));

  // Corpus templates (run mine-phrases.ts to refresh after an OCR pass).
  const phrasesPath = join(dataDir, 'phrases.tts.json');
  const templates: Template[] = existsSync(phrasesPath)
    ? (JSON.parse(await readFile(phrasesPath, 'utf8')) as { templates: Template[] }).templates
    : [];
  // Lackey plugin: independent human-typed card data for triangulation.
  const lackeyPath = join(dataDir, 'cards.lackey.json');
  interface LackeyCard { name: string; nameBare: string; saga: string; number: string; level: number | null; rarity: string; style: string | null; type: string; alignment: string | null; isPersonality: boolean; pur: number | null; ladder: Array<number | 'Z'> | null; text: string }
  const lackey: LackeyCard[] = existsSync(lackeyPath) ? (JSON.parse(await readFile(lackeyPath, 'utf8')) as LackeyCard[]) : [];
  const normName = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // Lackey prefixes styled card names with the style word ("Orange One Knuckle
  // Punch"); index under both spellings.
  const lackeyByKey = new Map<string, LackeyCard>();
  const lackeyByName = new Map<string, LackeyCard[]>();
  for (const lc of lackey) {
    const keys = [normName(lc.nameBare)];
    // Styled cards may drop the style word in other catalogs.
    const bare = lc.style && keys[0]!.startsWith(normName(lc.style) + ' ') ? keys[0]!.slice(normName(lc.style).length + 1) : null;
    if (bare) keys.push(bare);
    for (const k of keys) {
      const full = k + '|' + lc.saga + '|' + (lc.level ?? '');
      if (!lackeyByKey.has(full)) lackeyByKey.set(full, lc);
      const noLevel = k + '|' + lc.saga + '|';
      if (!lackeyByKey.has(noLevel)) lackeyByKey.set(noLevel, lc);
      const list = lackeyByName.get(k) ?? [];
      list.push(lc);
      lackeyByName.set(k, list);
    }
  }
  /** Promo sets use different names on each side; fall back to a name-only
   *  match when it is unambiguous (one Lackey candidate at that level). */
  const lackeyLoose = (name: string, level: number | undefined): LackeyCard | undefined => {
    const list = lackeyByName.get(normName(name)) ?? [];
    if (level !== undefined) {
      const atLevel = list.filter((x) => x.level === level);
      if (atLevel.length === 1 && !atLevel[0]!.isPersonality) return atLevel[0];
    }
    // Personalities exist as multiple distinct prints with different ladders;
    // a cross-saga name match cannot identify the print (vision proved this).
    return list.length === 1 && !list[0]!.isPersonality ? list[0] : undefined;
  };
  const lackeyByIdStyle = new Map<string, string | null>();
  const MARTIAL = new Set(['Red', 'Blue', 'Orange', 'Black', 'Saiyan', 'Namekian']);
  const normalizeStyle = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const first = raw.split('/')[0]!.trim();
    const cased = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    return MARTIAL.has(cased) ? cased : null;
  };
  const simNorm = (t: string) => t.toLowerCase().replace(/[^a-z0-9+]/g, '');
  /** Cheap similarity: shared-trigram ratio. */
  const similar = (a: string, b: string): number => {
    const A = simNorm(a); const B = simNorm(b);
    if (!A.length || !B.length) return 0;
    const tri = (x: string) => { const s = new Set<string>(); for (let i = 0; i < x.length - 2; i++) s.add(x.slice(i, i + 3)); return s; };
    const ta = tri(A); const tb = tri(B);
    let hit = 0; for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.max(ta.size, tb.size, 1);
  };
  // Vision fleet readings of the card faces (see the vision-card-extraction
  // workflow): the printed face outranks every transcription of it.
  interface VisionCard { id: string; isPersonality?: boolean; ladder?: string[]; level?: number; pur?: number; alignment?: string; text?: string; confidence: string; doubleRead?: boolean }
  const visionPath = join(dataDir, 'vision.tts.json');
  const visionById = new Map<string, VisionCard>();
  if (existsSync(visionPath)) {
    for (const v of (JSON.parse(await readFile(visionPath, 'utf8')) as { cards: VisionCard[] }).cards) {
      if (v.confidence !== 'low') visionById.set(v.id, v);
    }
  }
  const visionLadder = (v: VisionCard): Array<number | 'Z'> | null => {
    if (!v.ladder || v.ladder.length < 6) return null;
    const out = v.ladder.map((r) => (/^z$/i.test(r) ? ('Z' as const) : Number(String(r).replace(/[^0-9]/g, ''))));
    if (out.some((x) => typeof x === 'number' && !Number.isFinite(x))) return null;
    return out;
  };
  let matched = 0; let verified = 0; let laddersVerified = 0; let visionApplied = 0; let enduranceFound = 0;
  /**
   * Repair a single misread rung by arithmetic. A scouter ladder is an
   * arithmetic sequence, so when exactly one rung breaks the ordering and the
   * other gaps agree on a step, the true value is DETERMINED (prev + step)
   * rather than guessed. In practice these are dropped leading digits:
   * 1,000,000 read as 100000, or 2,150,000 as 1150000.
   *
   * This lives in the pipeline, not in a post-hoc script: enrichment rebuilds
   * the catalog from source every run, so a repair applied afterwards is
   * silently undone the next time anyone re-enriches.
   */
  const repairLadder = (ladder: Array<number | 'Z'>): { ladder: Array<number | 'Z'>; from: number; to: number } | null => {
    if (!Array.isArray(ladder) || ladder.length < 5) return null;
    if (ladder.some((v) => typeof v !== 'number')) return null; // 'Z' sits outside the ordering
    const nums = ladder as number[];
    const breaks: number[] = [];
    for (let i = 1; i < nums.length; i++) if (nums[i]! <= nums[i - 1]!) breaks.push(i);
    if (breaks.length === 0 || breaks.length > 2) return null;
    // Gaps above stage 0; the 0 -> first rung gap is the card's base, not the step.
    const gaps: number[] = [];
    for (let i = 2; i < nums.length; i++) gaps.push(nums[i]! - nums[i - 1]!);
    const healthy = gaps.filter((g) => g > 0);
    const counts = new Map<number, number>();
    for (const g of healthy) counts.set(g, (counts.get(g) ?? 0) + 1);
    let step = 0;
    let best = 0;
    for (const [g, n] of counts) if (n > best) { best = n; step = g; }
    if (step <= 0 || best < healthy.length - 1 || best < 3) return null;
    // The break registers at the rung AFTER the bad value as often as at the
    // bad value itself (a rung read too HIGH only trips the comparison on its
    // successor), so try both and accept whichever yields a clean sequence.
    for (const idx of [breaks[0]!, breaks[0]! - 1]) {
      if (idx < 1 || idx >= nums.length) continue;
      const expected = nums[idx - 1]! + step;
      const next = nums[idx + 1];
      if (next !== undefined && next - expected !== step) continue;
      const out = nums.slice();
      out[idx] = expected;
      let clean = true;
      for (let i = 1; i < out.length; i++) if (out[i]! <= out[i - 1]!) { clean = false; break; }
      if (clean) return { ladder: out, from: nums[idx]!, to: expected };
    }
    return null;
  };
  let laddersRepaired = 0;
  /**
   * Endurance is printed at the START of a card's rules text as "Endurance #"
   * (CRD ~L1118). Anchoring to the start avoids picking up prose that merely
   * mentions the keyword, and the value is capped at a sane range — OCR
   * occasionally reads "Endurance 2" as 10 or 100.
   */
  const enduranceOf = (text: unknown): number | undefined => {
    if (typeof text !== 'string') return undefined;
    // Strip leading OCR punctuation noise, then require the keyword first.
    const head = text.replace(/^[^A-Za-z0-9]+/, '').slice(0, 24);
    const m = /^endurance[^0-9]{0,3}([0-9]{1,2})/i.exec(head);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 1 && n <= 9 ? n : undefined;
  };
  let snappedTotal = 0;
  let cardsSnapped = 0;
  const fixText = (raw: string): string => {
    const cleaned = correct(raw);
    if (!templates.length) return cleaned;
    const { text, snappedCount } = correctText(cleaned, templates);
    if (snappedCount > 0) {
      snappedTotal += snappedCount;
      cardsSnapped++;
    }
    return text;
  };

  /**
   * Hand-verified levels, trusted over every reader. See
   * data/level-overrides.json for why this exists.
   */
  const overridePath = join(dataDir, 'level-overrides.json');
  const levelOverrides: Record<string, { level: number; name?: string; note?: string }> = existsSync(overridePath)
    ? ((JSON.parse(await readFile(overridePath, 'utf8')) as { levels?: Record<string, { level: number }> }).levels ?? {})
    : {};
  let levelsOverridden = 0;

  let personalities = 0;
  let withAbilities = 0;
  const coverage: Record<string, number> = {};
  const effectKinds: Record<string, number> = {};

  /**
 * The printed card types. Anything read off a card face has to land on one
 * of these exactly, because the engine matches type strings literally: a
 * stray space in "Non Combat" is the difference between Senzu Bean being
 * playable and the engine refusing it as an unknown card type.
 */
const CARD_TYPES = ['Personality', 'Physical Combat', 'Energy Combat', 'Combat', 'Non-Combat', 'Drill', 'Location', 'Battleground', 'Mastery', 'Dragon Ball', 'Sensei'];
const TYPE_BY_KEY = new Map(CARD_TYPES.map((t) => [t.toLowerCase().replace(/[^a-z]/g, ''), t]));

/**
 * Fold OCR damage in the type line back onto a printed type.
 *
 * The line is read off the face, so it arrives as "Non Combat",
 * "Non-combat", "Non- Combat", "Physical-Combat" — all of which the engine
 * treated as unknown types. Comparing on letters alone collapses them.
 *
 * A card carrying personality data IS a Personality whatever its type line
 * said: four cards read their ALIGNMENT ("Villian") as their type.
 */
function canonicalType(raw: string | undefined, isPersonality: boolean): string {
  if (isPersonality) return 'Personality';
  const key = (raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return TYPE_BY_KEY.get(key) ?? raw ?? 'Unknown';
}

/**
 * Words that prefix a character rather than name one.
 *
 * "King Piccolo" is not Piccolo and "Super Saiyan Trunks" is not Trunks, so
 * a leading run of these is kept and the first real word after them is the
 * character.
 */
const NAME_PREFIXES = new Set(['king', 'majin', 'kid', 'future', 'super', 'saiyan', 'great', 'captain', 'dr.', 'mr.', 'android', 'baby', 'ultimate', 'mystic', 'general', 'commander', 'lord']);

/**
 * The CHARACTER a personality card belongs to.
 *
 * A Main Personality is three-plus consecutive levels "of the same
 * Personality" (CRD ~L64) — and in this game each LEVEL carries its own
 * subtitle: the Cell saga Piccolo runs "Piccolo, the Warrior" Lv1, "Piccolo,
 * the Champion" Lv2, "Piccolo, Earth\'s Protector" Lv3, "Piccolo, the Namek"
 * Lv4. Keying identity on the full card title split that one legal stack into
 * four one-card groups, none of them playable, which is why the deck builder
 * offered 22 Main Personalities out of 572 personality cards.
 */
function characterOf(name: string): string {
  const head = name.split(',')[0] ?? name;
  const tokens = head.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    out.push(tok);
    if (!NAME_PREFIXES.has(tok.toLowerCase())) break;
  }
  return out.join(' ') || name;
}

/**
 * Does this card carry a personality POWER box?
 *
 * "Power:" and "Constant Combat Power:" are printed on personality cards and
 * essentially nowhere else — of 215 cards saying "Constant Combat Power", 200
 * were already typed Personality and the other 15 were mislabelled. This is
 * the signal that catches personalities the typed database does not cover:
 * every mislabelled one found had NO LackeyCCG row, because Lackey thins out
 * badly in the later sets (World Games, Buu, Fusion, Kid Buu).
 */
const hasPowerBox = (text: string | undefined): boolean =>
  /\b(constant\s+combat\s+)?power\s*:/i.test(text ?? "");

const cards = catalog.cards.map((c) => {
    const rec = ocrById.get(c.id);
    const needsReview = [...(rec?.needsReview ?? [])];
    const type = rec?.isPersonality ? 'Personality' : rec?.type ?? 'Unknown';

    const rules: Record<string, unknown> = { type, coverage: 'unknown', needsReview };
    const ocrText = rec?.text ? fixText(rec.text) : undefined;
    if (ocrText) rules.text = ocrText;
    if (c.errata) rules.errata = c.errata;

    // Triangulate with the Lackey database (matched by name+saga, +level for
    // personalities). Typed text supersedes OCR; agreement between the two
    // independent transcriptions marks the text verified.
    const lk = lackeyByKey.get(normName(c.name) + '|' + c.saga + '|' + (rec?.level ?? ''))
      ?? lackeyByKey.get(normName(c.name) + '|' + c.saga + '|')
      ?? lackeyLoose(c.name, rec?.level);
    if (lk) {
      matched++;
      lackeyByIdStyle.set(c.id, lk.style);
      // Agreement: two independent transcriptions -> take the typed one, mark
      // verified. Disagreement: the card FACE (errata'd, most-recent wording)
      // outranks Lackey's original-printing text, which is kept as evidence —
      // Saiyan Truce Card's errata rewrite showed why this must not be a
      // blind replacement.
      const sim = ocrText ? similar(lk.text, ocrText) : 0;
      if (sim >= 0.55) {
        verified++;
        rules.text = lk.text;
        rules.textVerified = true;
      } else {
        rules.textOriginal = lk.text;
        if (ocrText) needsReview.push('textDisagreement');
        else rules.text = lk.text; // no OCR at all -> typed text beats nothing
      }
      if (lk.type) rules.type = lk.type;
      rules.lackey = { number: lk.number, rarity: lk.rarity, style: lk.style, ...(lk.pur != null ? { pur: lk.pur } : {}), ...(lk.level != null ? { level: lk.level } : {}) };
    }
    const vis = visionById.get(c.id);
    if (vis) {
      visionApplied++;
      if (vis.text && vis.text.length >= 12) {
        rules.text = vis.text;
        rules.textVerified = 'vision';
        const ix = needsReview.indexOf('textDisagreement'); if (ix !== -1) needsReview.splice(ix, 1);
        const tx = needsReview.indexOf('text'); if (tx !== -1) needsReview.splice(tx, 1);
      }
    }

    // Personality classification by source precedence: the face (vision) beats
    // the typed database, which beats OCR. A veto matters as much as a claim —
    // OCR's ladder detector reads digits out of card art and has declared
    // Combat cards to be personalities; a typed "Combat" row overrules it.
    // A card with a power ladder and/or a PUR is a Personality — that is the
    // whole rule. The typed database is still trusted first where it has a
    // row, because a human wrote it; it simply has no row for ~600 of these
    // cards. For those, the face and the power box decide.
    const ocrLadder = (rec?.powerRatings ?? []).length >= 6;
    const ocrPur = typeof rec?.pur === "number" && rec.pur > 0;
    const powerBox = hasPowerBox(rules.text as string | undefined);
    // "Constant Combat Power" is printed on personalities and essentially
    // nowhere else, so it stands on its own. A bare "Power:" does not — cards
    // like "Straining Tien's Mafuba Move" open with it too — so that one needs
    // a ladder or a PUR beside it.
    const constantCombatPower = /constant\s+combat\s+power/i.test((rules.text as string) ?? '');
    const isPersonality =
      lk ? lk.isPersonality
      : vis?.isPersonality !== undefined ? vis.isPersonality
      // Two independent signals, because OCR alone reads digits out of card
      // art and has declared Combat cards to be personalities.
      : (ocrLadder && (ocrPur || powerBox)) || (powerBox && ocrPur) || constantCombatPower
        ? true
        : rec?.isPersonality ?? false;
    // A power box with nothing else behind it is a strong hint we have a
    // personality whose ladder nobody could read. Say so rather than silently
    // filing it as a Combat card.
    if (!isPersonality && powerBox) needsReview.push('possiblePersonality');
    rules.type = canonicalType(rules.type as string, isPersonality);
    if (isPersonality) {
      personalities++;
      const personality: Record<string, unknown> = {
        // The character, not the card title — see characterOf().
        personalityName: lk?.nameBare ? characterOf(lk.nameBare) : characterOf(c.name),
        // Alignment is not printed as text; needs the hero/villain frame colour
        // or a curated list. Rogue is the CRD's explicit "neither" bucket.
        alignment: 'Rogue',
        powerRatings: rec?.powerRatings ?? [],
        zeroStageIndex: 0,
        pur: (lk?.pur ?? rec?.pur) ?? null,
        canBeAlly: true,
      };
      // Typed ladder from Lackey is primary; the OCR ladder cross-checks it.
      // Verified = most OCR-read rungs appear in the typed ladder.
      if (lk?.ladder?.length) {
        personality.powerRatings = lk.ladder;
        const ocrLadder = rec?.powerRatings ?? [];
        if (ocrLadder.length >= 4) {
          const inTyped = ocrLadder.filter((r) => (lk.ladder as Array<number | 'Z'>).includes(r)).length;
          if (inTyped / ocrLadder.length >= 0.6) { personality.ladderVerified = true; laddersVerified++; }
          else needsReview.push('ladderDisagreement');
        }
      } else if ((personality.powerRatings as unknown[]).length < 6) {
        needsReview.push('powerRatings');
      }
      if (lk?.alignment) personality.alignment = lk.alignment;
      else if (!needsReview.includes('alignment')) needsReview.push('alignment');
      const lvl = lk?.level ?? rec?.level;
      if (lvl !== undefined && lvl !== null) personality.level = lvl;
      else needsReview.push('level');
      // The face is final: vision readings override on the fields they cover.
      if (vis) {
        const vl = visionLadder(vis);
        if (vl && (needsReview.includes('ladderDisagreement') || !(lk?.ladder?.length))) {
          personality.powerRatings = vl;
          personality.ladderVerified = vis.doubleRead ? 'double-read' : 'vision';
          const ix = needsReview.indexOf('ladderDisagreement'); if (ix !== -1) needsReview.splice(ix, 1);
          const px = needsReview.indexOf('powerRatings'); if (px !== -1) needsReview.splice(px, 1);
        }
        if (vis.level !== undefined) { personality.level = vis.level; const ix = needsReview.indexOf('level'); if (ix !== -1) needsReview.splice(ix, 1); }
        if (vis.pur !== undefined) personality.pur = vis.pur;
        if (vis.alignment && vis.alignment !== 'unknown') { personality.alignment = vis.alignment; const ix = needsReview.indexOf('alignment'); if (ix !== -1) needsReview.splice(ix, 1); }
      }
      // Level badges are small stylised digits and BOTH readers get them wrong:
      // where vision and OCR each read a level they disagree 38 times out of
      // 207, and 369 personalities have no LackeyCCG row to settle it. A wrong
      // level is not cosmetic — it decides which slot a card fills in a Main
      // Personality stack, so one misread level can make a legal stack look
      // like it has two level 1s and no level 2.
      if (vis?.level !== undefined && rec?.level !== undefined && rec.level !== null && vis.level !== rec.level) {
        needsReview.push('levelDisagreement');
      }
      // A hand-verified level beats every reader, and is how a misread gets
      // fixed permanently without re-running the pipeline.
      const override = levelOverrides[c.id];
      if (override) {
        personality.level = override.level;
        for (const flag of ['level', 'levelDisagreement']) {
          const ix = needsReview.indexOf(flag);
          if (ix !== -1) needsReview.splice(ix, 1);
        }
        levelsOverridden++;
      }

      // Final pass: a single arithmetic misread is repairable and flagged.
      const fixed = repairLadder(personality.powerRatings as Array<number | 'Z'>);
      if (fixed) {
        personality.powerRatings = fixed.ladder;
        needsReview.push('ladder:arithmeticRepair');
        laddersRepaired++;
      }
      rules.personality = personality;
    }

    // Parse abilities off the rules text. The parser is conservative: cards it
    // cannot confidently read stay manual.
    if (rules.text && (rules.type ?? type) !== 'Personality') {
      const ability = parseAbility(rules.text as string, (rules.type as string) ?? type);
      if (ability) {
        rules.abilities = [ability];
        withAbilities++;
        for (const e of ability.effects) effectKinds[e.kind] = (effectKinds[e.kind] ?? 0) + 1;
        if (ability.needsReview?.length) needsReview.push(...ability.needsReview.map((n) => `ability:${n}`));
      }
    }

    const endurance = enduranceOf(rules.text as string | undefined);
    if (endurance !== undefined) {
      rules.endurance = endurance;
      enduranceFound++;
    }

    rules.coverage = rules.abilities
      ? 'partial'
      : type !== 'Unknown'
        ? 'metadata'
        : 'unknown';
    coverage[rules.coverage as string] = (coverage[rules.coverage as string] ?? 0) + 1;

    return {
      id: c.id,
      number: null,
      name: c.name,
      // Style is a deck-construction rule (Tokui-Waza), so it is promoted to a
      // top-level field. "Colorless"/"Named" are not Martial Arts styles.
      style: normalizeStyle(lackeyByIdStyle.get(c.id)),
      saga: c.saga,
      rarity: 'Unknown',
      imageUrl: `images-tts/${c.id}.jpg`,
      rules,
    };
  });

  const out = join(dataDir, 'cards.tts.enriched.json');
  await writeFile(out, JSON.stringify(cards, null, 2), 'utf8');

  console.log(`[enrich-tts] ${cards.length} cards -> ${out}`);
  console.log(`[enrich-tts] personalities: ${personalities}, with parsed abilities: ${withAbilities}`);
  console.log(`[enrich-tts] coverage: ${JSON.stringify(coverage)}`);
  console.log(`[enrich-tts] effect kinds: ${JSON.stringify(effectKinds)}`);
  console.log(`[enrich-tts] template snaps: ${snappedTotal} sentences on ${cardsSnapped} cards (${templates.length} templates)`);
  console.log(`[enrich-tts] lackey: ${lackey.length} cards loaded, ${matched} matched, ${verified} text-verified by OCR agreement`);
  console.log(`[enrich-tts] ladders verified (typed vs OCR agreement): ${laddersVerified}`);
  console.log(`[enrich-tts] vision readings applied: ${visionApplied}`);
  console.log(`[enrich-tts] levels overridden by hand: ${levelsOverridden}`);
  console.log(`[enrich-tts] endurance values parsed: ${enduranceFound}`);
  console.log(`[enrich-tts] ladders repaired by arithmetic: ${laddersRepaired}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

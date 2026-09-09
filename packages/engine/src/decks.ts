/**
 * Deck legality (CRD §2 "Deck Building", ~L45-97). The client is untrusted, so
 * every submitted DeckList is re-validated here before it can start a game.
 *
 * Enforced:
 *  - Deck size 50..85, or 50..90 for a Namekian Tokui-Waza (MP levels +
 *    Mastery + Sensei card + Life Deck cards).
 *  - MP: >=3 consecutive levels of one personality, starting at 1, no skips, max 5.
 *  - Copy limits: Personality/Mastery/Sensei/Dragon Ball 1; most cards 3;
 *    named cards matching the MP's name 4.
 *  - All Dragon Balls from a single set.
 *
 *  - Tokui-Waza legality when a Mastery is present: every Styled card must
 *    match the Mastery's style, plus at least one Martial Arts Styled card.
 *
 * Not yet enforced: Sensei Deck size limits (printed on the Sensei card, which
 * we do not have as data).
 */
import type { DeckList } from '@dbz/shared';
import type { CardDb, EngineCard } from './loader.js';
import { checkTokuiWaza, styleOf } from './mastery.js';

export const MIN_DECK_SIZE = 50;
export const MAX_DECK_SIZE = 85;
/** CRD ~L45: "If you declare a Namekian Tokui-Waza, you may have up to 90". */
export const MAX_DECK_SIZE_NAMEKIAN = 90;
export const MIN_MP_LEVELS = 3;
/**
 * A Main Personality runs to level 5 — and to 6 in the GT sets. The catalog
 * currently tops out at 5 because this card pool has no GT printings, so this
 * is headroom rather than a live case; it should not be the cap that rejects a
 * GT deck the day those cards are added.
 */
export const MAX_MP_LEVEL = 6;

export interface DeckValidationOptions {
  /** Dev/testing escape hatch for the 50-card minimum. */
  enforceSize?: boolean;
}

/** By TYPE only — matching the title caught 10 ordinary cards that merely
 *  mention a Dragon Ball, capping them at 1 per deck and forcing them into the
 *  single-set rule. All 52 printed balls carry the type. */
const isDragonBall = (c: EngineCard): boolean => /dragon ball/i.test(c.rules?.type ?? '');

/**
 * Per-deck copy limit for one card.
 *
 * CRD ~L51: cards "are limited to 3 copies per deck unless they are named cards
 * or say otherwise in the rules text." The printed limit was never read, so all
 * 168 cards that say "Limit 1 per deck" or "Limit 2 per deck" could be run at 3
 * — or at 4 when the title happened to contain the MP's name, which is exactly
 * the case the printed limit exists to stop.
 */
function printedLimit(card: EngineCard): number | undefined {
  const m = /limit\s*(\d+)\s*per\s*deck/i.exec(card.rules?.text ?? '');
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function copyLimit(card: EngineCard, mpName: string | undefined): number {
  const type = card.rules?.type ?? 'Unknown';
  if (card.rules?.personality || type === 'Personality') return 1;
  if (/mastery|sensei/i.test(type) || isDragonBall(card)) return 1;
  const base = mpName && card.name.toLowerCase().includes(mpName.toLowerCase()) ? 4 : 3;
  // A printed limit overrides the default, and overrides the named-card bonus:
  // "say otherwise in the rules text" is the exception to both.
  const printed = printedLimit(card);
  return printed === undefined ? base : Math.min(printed, base);
}

/** Cheap shape check — this data arrives straight off a socket. */
function malformed(deck: DeckList): string | undefined {
  if (!deck || typeof deck !== 'object') return 'deck is not an object';
  if (typeof deck.name !== 'string' || deck.name.length === 0) return 'deck has no name';
  if (deck.name.length > 60) return 'deck name too long';
  if (!Array.isArray(deck.mpLevels)) return 'mpLevels must be an array';
  if (!Array.isArray(deck.life)) return 'life must be an array';
  if (deck.senseiDeck !== undefined && !Array.isArray(deck.senseiDeck)) return 'senseiDeck must be an array';
  for (const entry of [...deck.life, ...(deck.senseiDeck ?? [])]) {
    if (!entry || typeof entry.cardId !== 'string') return 'deck entry missing cardId';
    if (!Number.isInteger(entry.qty) || entry.qty < 1 || entry.qty > 99) {
      return `bad quantity for ${entry.cardId}`;
    }
  }
  for (const id of deck.mpLevels) if (typeof id !== 'string') return 'mpLevels must be card ids';
  return undefined;
}

/** Returns a list of rule violations; empty means the deck is legal. */
export function validateDeck(deck: DeckList, db: CardDb, opts: DeckValidationOptions = {}): string[] {
  const shapeError = malformed(deck);
  if (shapeError) return [shapeError];

  const errors: string[] = [];
  const enforceSize = opts.enforceSize ?? true;

  // --- Main Personality: >=3 consecutive levels from 1, same personality ---
  const mpCards = deck.mpLevels.map((id) => db.get(id));
  const missingMp = deck.mpLevels.filter((id) => !db.get(id));
  if (missingMp.length) errors.push(`unknown MP level card(s): ${missingMp.join(', ')}`);

  let mpName: string | undefined;
  if (mpCards.length < MIN_MP_LEVELS) {
    errors.push(`Main Personality needs at least ${MIN_MP_LEVELS} levels (got ${mpCards.length})`);
  }
  if (mpCards.length > MAX_MP_LEVEL) {
    errors.push(`Main Personality may not exceed level ${MAX_MP_LEVEL}`);
  }
  if (missingMp.length === 0 && mpCards.length > 0) {
    const personalities = mpCards.map((c) => c!.rules?.personality);
    if (personalities.some((p) => !p)) {
      errors.push('every mpLevels entry must be a Personality card');
    } else {
      const names = new Set(personalities.map((p) => p!.personalityName));
      if (names.size > 1) errors.push(`MP levels mix personalities: ${[...names].join(', ')}`);
      else mpName = personalities[0]!.personalityName;

      const levels = personalities.map((p) => p!.level);
      if (levels[0] !== 1) errors.push('MP levels must start at level 1');
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] !== levels[i - 1]! + 1) {
          errors.push('MP levels must be consecutive with no gaps');
          break;
        }
      }
    }
  }

  // --- Copy limits across the whole deck (Life Deck + Sensei Deck) ---
  //
  // Counted by card IDENTITY, not by catalog id. The same physical card is
  // sliced more than once out of the Tabletop Simulator mod — 66 name+saga
  // groups have a duplicate entry, 54 of them Personalities — and each copy
  // carries its own id. Counting ids let a deck hold "one" of each duplicate
  // and so run two copies of a card limited to one: a Personality level, a
  // Mastery, a Dragon Ball, or anything printing "Limit 1 per deck".
  // The LEVEL is part of a personality's identity: "Guldo" level 1, 2 and 3
  // share a name and a saga and are three different cards. Without it the whole
  // Main Personality stack collapses into one card and reads as three copies.
  const identityOf = (id: string): string => {
    const card = db.get(id);
    if (!card) return id;
    const level = card.rules?.personality?.level;
    return `${card.name.toLowerCase()}|${card.saga}|${level ?? ''}`;
  };
  const counts = new Map<string, number>();
  const idFor = new Map<string, string>();
  const bump = (id: string, qty: number) => {
    const k = identityOf(id);
    if (!idFor.has(k)) idFor.set(k, id);
    counts.set(k, (counts.get(k) ?? 0) + qty);
  };
  for (const id of deck.mpLevels) bump(id, 1);
  if (deck.masteryId) bump(deck.masteryId, 1);
  if (deck.senseiId) bump(deck.senseiId, 1);
  for (const { cardId, qty } of deck.life) bump(cardId, qty);
  for (const { cardId, qty } of deck.senseiDeck ?? []) bump(cardId, qty);

  const unknown: string[] = [];
  for (const [identity, qty] of counts) {
    const card = db.get(idFor.get(identity) ?? identity);
    if (!card) {
      unknown.push(idFor.get(identity) ?? identity);
      continue;
    }
    const limit = copyLimit(card, mpName);
    if (qty > limit) errors.push(`${card.name} is limit ${limit} per deck (found ${qty})`);
  }
  if (unknown.length) {
    errors.push(`unknown card id(s): ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`);
  }

  // --- "Sensei Deck only" cards may not start in the Life Deck ---
  //
  // ~L106: they "must start the game in your Sensei Deck. If you are found to
  // have Sensei Deck only cards in your Life Deck ... you will receive a game
  // loss." 31 cards say it, and nothing checked, so they sat in Life Decks and
  // were drawn like anything else.
  const senseiOnly = deck.life
    .map((entry) => db.get(entry.cardId))
    .filter((c): c is EngineCard => !!c && /sensei\s+deck\s+only/i.test(c.rules?.text ?? ''));
  for (const card of senseiOnly) {
    errors.push(`${card.name} is a "Sensei Deck only" card and cannot start in the Life Deck`);
  }

  // --- Dragon Balls must all come from one set ---
  const ballSets = new Set(
    [...counts.keys()]
      // counts is keyed by identity now, so go back through a real card id.
      .map((identity) => db.get(idFor.get(identity) ?? identity))
      .filter((c): c is EngineCard => !!c && isDragonBall(c))
      .map((c) => c.saga),
  );
  if (ballSets.size > 1) errors.push(`Dragon Balls must all be from one set (found ${[...ballSets].join(', ')})`);

  // --- Tokui-Waza: a Mastery may only be played with a legal declaration ---
  if (deck.masteryId) {
    const all = [...deck.mpLevels, ...deck.life.map((l) => l.cardId), ...(deck.senseiDeck ?? []).map((l) => l.cardId)];
    errors.push(...checkTokuiWaza(deck.masteryId, all, db).errors);
  }

  // --- Deck size (Sensei Deck cards do not count) ---
  const lifeCount = deck.life.reduce((n, e) => n + e.qty, 0);
  const total = deck.mpLevels.length + (deck.masteryId ? 1 : 0) + (deck.senseiId ? 1 : 0) + lifeCount;
  // A Namekian Tokui-Waza raises the ceiling to 90 (CRD ~L45). This was left
  // unenforced for "catalog data we don't have", but the Mastery's own style is
  // in the catalog and playing the Mastery IS the declaration, so Namekian
  // decks were being rejected at 86 cards for a limit that does not apply.
  const namekian = deck.masteryId ? styleOf(db.get(deck.masteryId)) === 'Namekian' : false;
  const maxSize = namekian ? MAX_DECK_SIZE_NAMEKIAN : MAX_DECK_SIZE;
  if (enforceSize && total < MIN_DECK_SIZE) errors.push(`deck has ${total} cards, minimum is ${MIN_DECK_SIZE}`);
  if (total > maxSize) errors.push(`deck has ${total} cards, maximum is ${maxSize}`);

  return errors;
}

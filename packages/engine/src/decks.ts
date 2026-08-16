/**
 * Deck legality (CRD §2 "Deck Building", ~L45-97). The client is untrusted, so
 * every submitted DeckList is re-validated here before it can start a game.
 *
 * Enforced:
 *  - Deck size 50..85 (MP levels + Mastery + Sensei card + Life Deck cards).
 *  - MP: >=3 consecutive levels of one personality, starting at 1, no skips, max 5.
 *  - Copy limits: Personality/Mastery/Sensei/Dragon Ball 1; most cards 3;
 *    named cards matching the MP's name 4.
 *  - All Dragon Balls from a single set.
 *
 *  - Tokui-Waza legality when a Mastery is present: every Styled card must
 *    match the Mastery's style, plus at least one Martial Arts Styled card.
 *
 * Not yet enforced (needs catalog data we don't have): the Namekian
 * Tokui-Waza 90-card ceiling and Sensei Deck size limits (printed on the
 * Sensei card).
 */
import type { DeckList } from '@dbz/shared';
import type { CardDb, EngineCard } from './loader.js';
import { checkTokuiWaza } from './mastery.js';

export const MIN_DECK_SIZE = 50;
export const MAX_DECK_SIZE = 85;
export const MIN_MP_LEVELS = 3;
export const MAX_MP_LEVEL = 5;

export interface DeckValidationOptions {
  /** Dev/testing escape hatch for the 50-card minimum. */
  enforceSize?: boolean;
}

const isDragonBall = (c: EngineCard): boolean =>
  /dragon ball/i.test(c.rules?.type ?? '') || /dragon ball/i.test(c.name);

/** Per-deck copy limit for one card. */
function copyLimit(card: EngineCard, mpName: string | undefined): number {
  const type = card.rules?.type ?? 'Unknown';
  if (card.rules?.personality || type === 'Personality') return 1;
  if (/mastery|sensei/i.test(type) || isDragonBall(card)) return 1;
  if (mpName && card.name.toLowerCase().includes(mpName.toLowerCase())) return 4;
  return 3;
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
  const counts = new Map<string, number>();
  const bump = (id: string, qty: number) => counts.set(id, (counts.get(id) ?? 0) + qty);
  for (const id of deck.mpLevels) bump(id, 1);
  if (deck.masteryId) bump(deck.masteryId, 1);
  if (deck.senseiId) bump(deck.senseiId, 1);
  for (const { cardId, qty } of deck.life) bump(cardId, qty);
  for (const { cardId, qty } of deck.senseiDeck ?? []) bump(cardId, qty);

  const unknown: string[] = [];
  for (const [cardId, qty] of counts) {
    const card = db.get(cardId);
    if (!card) {
      unknown.push(cardId);
      continue;
    }
    const limit = copyLimit(card, mpName);
    if (qty > limit) errors.push(`${card.name} is limit ${limit} per deck (found ${qty})`);
  }
  if (unknown.length) {
    errors.push(`unknown card id(s): ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`);
  }

  // --- Dragon Balls must all come from one set ---
  const ballSets = new Set(
    [...counts.keys()]
      .map((id) => db.get(id))
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
  if (enforceSize && total < MIN_DECK_SIZE) errors.push(`deck has ${total} cards, minimum is ${MIN_DECK_SIZE}`);
  if (total > MAX_DECK_SIZE) errors.push(`deck has ${total} cards, maximum is ${MAX_DECK_SIZE}`);

  return errors;
}

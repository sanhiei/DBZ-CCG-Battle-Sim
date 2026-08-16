/**
 * Life-card discarding, and the Dragon Ball rules tangled up in it.
 *
 * The CRD draws a sharp line between the two ways life cards leave a deck:
 *
 *  - DAMAGE (CRD ~L699): "Dragon Ball cards do not count as damage when you
 *    discard them from your Life Deck as damage from an attack. You must flip
 *    over a different card for damage if you uncover a Dragon Ball." An
 *    uncovered ball is not in play, so per ~L695 it goes face-down to the
 *    BOTTOM of the Life Deck and another card is flipped.
 *  - EFFECTS (CRD ~L703): "When you discard life cards that are NOT a result of
 *    damage from an attack, the Dragon Balls DO count as cards discarded."
 *
 * The damage rule creates the Dragon Ball Loop: a player who owes damage but
 * holds nothing except Dragon Balls can never pay it, and loses.
 */
import type { CardInstance, GameState } from '@dbz/shared';
import type { CardDb } from './loader.js';

/** A successful attack dealing at least this many life cards allows a capture. */
export const LIFE_CARD_CAPTURE_THRESHOLD = 5;

export function isDragonBall(card: CardInstance, db: CardDb): boolean {
  const c = db.get(card.cardId);
  if (!c) return false;
  return /dragon ball/i.test(c.rules?.type ?? '') || /dragon ball/i.test(c.name);
}

export interface DamageResult {
  /** Life cards that actually counted as damage. */
  discarded: number;
  /** Dragon Balls uncovered and returned to the bottom of the deck. */
  dragonBallsSkipped: number;
  /**
   * True when the full amount could not be paid — either the deck ran out or
   * only Dragon Balls remain (the Dragon Ball Loop). Either way the player has
   * lost; the caller ends the game.
   */
  exhausted: boolean;
}

/**
 * Discard `n` life cards as DAMAGE. Dragon Balls are skipped, cycled to the
 * bottom, and do not count.
 */
export function discardForDamage(state: GameState, playerIdx: number, n: number, db: CardDb): DamageResult {
  const player = state.players[playerIdx];
  if (!player) return { discarded: 0, dragonBallsSkipped: 0, exhausted: true };

  const deck = player.zones.lifeDeck;
  let discarded = 0;
  let dragonBallsSkipped = 0;
  // At most one full pass: if every remaining card is a Dragon Ball we would
  // otherwise cycle them forever.
  let guard = deck.length;

  while (discarded < n && deck.length > 0 && guard-- > 0) {
    const top = deck.shift()!;
    if (isDragonBall(top, db)) {
      deck.push({ ...top, faceDown: true });
      dragonBallsSkipped++;
      continue;
    }
    player.zones.discard.push({ ...top, faceDown: false });
    discarded++;
  }

  return { discarded, dragonBallsSkipped, exhausted: discarded < n };
}

/**
 * Discard `n` life cards for a CARD EFFECT. Dragon Balls count normally here,
 * and a discarded ball that is not already in play returns to the bottom of the
 * Life Deck rather than sitting in the discard pile (CRD ~L695).
 */
export function discardForEffect(state: GameState, playerIdx: number, n: number, db: CardDb): number {
  const player = state.players[playerIdx];
  if (!player) return 0;
  const taken = player.zones.lifeDeck.splice(0, n);
  for (const card of taken) {
    if (isDragonBall(card, db)) {
      const inPlay = player.dragonBalls.some((b) => b.cardId === card.cardId);
      // Already in play -> removed from the game; otherwise back to the bottom.
      if (inPlay) player.zones.removed.push({ ...card, faceDown: false });
      else player.zones.lifeDeck.push({ ...card, faceDown: true });
    } else {
      player.zones.discard.push({ ...card, faceDown: false });
    }
  }
  return taken.length;
}

/**
 * Dragon Balls the defender has in play that an attacker may capture after
 * dealing enough life-card damage (CRD ~L685).
 */
export function capturableBalls(state: GameState, defenderIdx: number): CardInstance[] {
  return state.players[defenderIdx]?.dragonBalls ?? [];
}

/**
 * Move one Dragon Ball from `fromIdx` to `toIdx`. Returns false when the ball
 * is not under the source player's control.
 */
export function captureBall(state: GameState, fromIdx: number, toIdx: number, ballUid: string): boolean {
  const from = state.players[fromIdx];
  const to = state.players[toIdx];
  if (!from || !to) return false;
  const at = from.dragonBalls.findIndex((b) => b.uid === ballUid);
  if (at === -1) return false;
  const [ball] = from.dragonBalls.splice(at, 1);
  to.dragonBalls.push(ball!);
  state.log.push(`${to.name} captures a Dragon Ball from ${from.name}.`);
  return true;
}

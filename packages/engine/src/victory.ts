/**
 * Victory conditions (CRD §"Winning the Game", ~L147-172).
 *
 * Three ways to win, all checked centrally by `checkVictory` after any state
 * change that could trigger one. Keeping the checks here (rather than at each
 * damage site) means a life card removed by ANY route — combat damage, a card
 * effect, a discard — is caught by the same rule.
 *
 *  1. Survival — "You win the instant your opponent has no life cards in his
 *     Life Deck." Note the CRD wording: it is the deck being empty that wins,
 *     not the attempt to draw from it.
 *  2. Dragon Ball — control all 7 of one set. Capturing the 7th FROM an
 *     opponent defers the win to the start of your next turn, which is modelled
 *     as a pending claim rather than an immediate result.
 *  3. Most Powerful Personality — your MP reaches the highest level any
 *     personality in this game can reach, AND got there by anger.
 */
import type { GameEvent, GameState, VictoryType } from '@dbz/shared';
import type { CardDb } from './loader.js';

/** A full set of Dragon Balls. */
export const DRAGON_BALL_SET_SIZE = 7;

function endGame(state: GameState, winnerIdx: number, victoryType: VictoryType, events: GameEvent[]): true {
  state.phase = 'ended';
  state.winnerIdx = winnerIdx;
  state.victoryType = victoryType;
  events.push({ type: 'gameEnded', winnerIdx, victoryType });
  state.log.push(`${state.players[winnerIdx]?.name ?? 'Player'} wins — ${victoryType} victory.`);
  return true;
}

/**
 * Group a player's Dragon Balls by set and report the largest complete-ish
 * group. Balls are identified by set (saga) and by their number within it, so
 * two copies of the same ball never count twice.
 */
function dragonBallProgress(
  state: GameState,
  playerIdx: number,
  db: CardDb,
): { set: string; count: number } | undefined {
  const player = state.players[playerIdx];
  if (!player) return undefined;
  const bySet = new Map<string, Set<string>>();
  for (const inst of player.dragonBalls) {
    const card = db.get(inst.cardId);
    if (!card) continue;
    const set = card.saga || 'unknown';
    const key = String(card.number ?? card.name);
    const seen = bySet.get(set) ?? new Set<string>();
    seen.add(key);
    bySet.set(set, seen);
  }
  let best: { set: string; count: number } | undefined;
  for (const [set, seen] of bySet) {
    if (!best || seen.size > best.count) best = { set, count: seen.size };
  }
  return best;
}

/** Highest level any personality in this game can reach (MP stacks are 3-5). */
export function highestPossibleLevel(state: GameState): number {
  let max = 1;
  for (const p of state.players) max = Math.max(max, p.mp.levelCardIds.length);
  return max;
}

export interface VictoryOptions {
  /**
   * The MP that just advanced by anger, if any. The CRD grants the Most
   * Powerful Personality win only when the top level is reached BY ANGER, so
   * an advance from a card effect must not trigger it.
   */
  advancedByAngerUid?: string;
}

/**
 * Evaluate every victory condition. Returns true when the game ended.
 * Safe to call after any mutation; it is a no-op once `phase` is 'ended'.
 */
export function checkVictory(
  state: GameState,
  db: CardDb,
  events: GameEvent[],
  opts: VictoryOptions = {},
): boolean {
  if (state.phase === 'ended') return false;

  // A deferred Dragon Ball claim matures at the start of its owner's turn.
  if (
    state.pendingDragonVictory !== undefined &&
    state.activePlayerIdx === state.pendingDragonVictory &&
    state.step === 'draw'
  ) {
    const idx = state.pendingDragonVictory;
    const progress = dragonBallProgress(state, idx, db);
    delete state.pendingDragonVictory;
    // Only if the set is still intact — the balls can be recaptured meanwhile.
    if (progress && progress.count >= DRAGON_BALL_SET_SIZE) {
      return endGame(state, idx, 'dragonBall', events);
    }
  }

  for (const player of state.players) {
    // 1. Survival — an empty Life Deck loses immediately.
    if (player.zones.lifeDeck.length === 0) {
      const winner = state.players.find((p) => p.idx !== player.idx);
      if (winner) return endGame(state, winner.idx, 'survival', events);
    }

    // 2. Dragon Ball — 7 of one set under one player's control.
    const balls = dragonBallProgress(state, player.idx, db);
    if (balls && balls.count >= DRAGON_BALL_SET_SIZE && state.pendingDragonVictory === undefined) {
      return endGame(state, player.idx, 'dragonBall', events);
    }

    // 3. Most Powerful Personality — top level, reached by anger.
    if (
      opts.advancedByAngerUid === player.mp.uid &&
      player.mp.currentLevel >= highestPossibleLevel(state) &&
      player.mp.currentLevel === player.mp.levelCardIds.length
    ) {
      return endGame(state, player.idx, 'mostPowerful', events);
    }
  }

  return false;
}

/**
 * Record a Dragon Ball win that must wait. Called when the 7th ball of a set is
 * captured from an opponent: the win lands at the start of the capturer's next
 * turn, and only if they still hold the set.
 */
export function deferDragonVictory(state: GameState, playerIdx: number): void {
  state.pendingDragonVictory = playerIdx;
  state.log.push(
    `${state.players[playerIdx]?.name ?? 'Player'} holds all 7 Dragon Balls — victory at the start of their next turn.`,
  );
}

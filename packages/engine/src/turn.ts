/**
 * Turn machinery: step sequencing, draw, power-up, anger -> advancement.
 * These functions MUTATE the passed state (the reducer clones first) and push
 * GameEvents into `events`. See docs/RULES-NOTES.md.
 */
import type { GameEvent, GameState, PersonalityInPlay, PowerRating, Step } from '@dbz/shared';
import { STEPS } from '@dbz/shared';
import type { CardDb } from './loader.js';
import { TOKUI_WAZA_PUR_BONUS } from './mastery.js';

export const ANGER_TO_ADVANCE = 5;

function ratingAt(ratings: PowerRating[], idx: number): PowerRating {
  if (ratings.length === 0) return 0;
  return ratings[Math.max(0, Math.min(idx, ratings.length - 1))]!;
}

export function findPersonality(state: GameState, uid: string): PersonalityInPlay | undefined {
  for (const p of state.players) {
    if (p.mp.uid === uid) return p.mp;
    const ally = p.allies.find((a) => a.uid === uid);
    if (ally) return ally;
  }
  return undefined;
}

function ownerOf(state: GameState, uid: string): number {
  for (const p of state.players) {
    if (p.mp.uid === uid || p.allies.some((a) => a.uid === uid)) return p.idx;
  }
  return -1;
}

/** Advance to the next step; wraps to the next player's Draw Step after Rejuvenation. */
export function advanceStep(state: GameState, events: GameEvent[]): void {
  const i = STEPS.indexOf(state.step);
  const next: Step = STEPS[(i + 1) % STEPS.length]!;
  if (next === 'draw') {
    // New turn.
    state.activePlayerIdx = (state.activePlayerIdx + 1) % state.players.length;
    state.turnNumber += 1;
    delete state.combat;
  }
  state.step = next;
  events.push({ type: 'stepChanged', step: next, turnNumber: state.turnNumber, activePlayerIdx: state.activePlayerIdx });
  state.log.push(`${state.players[state.activePlayerIdx]!.name}: ${next} step`);
}

/** Draw n cards from the top of a player's Life Deck into hand (as many as exist). */
export function draw(state: GameState, playerIdx: number, n: number): void {
  const p = state.players[playerIdx];
  if (!p) return;
  const taken = p.zones.lifeDeck.splice(0, n).map((c) => ({ ...c, faceDown: false }));
  p.zones.hand.push(...taken);
}

function purOf(state: GameState, playerIdx: number, mp: PersonalityInPlay, db: CardDb): number {
  const cardId = mp.levelCardIds[mp.currentLevel - 1];
  const pur = cardId ? db.personality(cardId)?.pur : null;
  const base = typeof pur === 'number' && pur > 0 ? pur : 1;
  // Declaring a Tokui-Waza grants +1 PUR for the remainder of the game (CRD ~L76).
  const bonus = state.players[playerIdx]?.tokuiWazaDeclared ? TOKUI_WAZA_PUR_BONUS : 0;
  return base + bonus;
}

export function currentRatings(p: PersonalityInPlay, db: CardDb): PowerRating[] {
  const cardId = p.levelCardIds[p.currentLevel - 1];
  return (cardId ? db.personality(cardId)?.powerRatings : undefined) ?? [0];
}

/** Recompute a personality's cached currentRating from its stageIndex + level card. */
export function syncRating(p: PersonalityInPlay, db: CardDb): void {
  p.currentRating = ratingAt(currentRatings(p, db), p.stageIndex);
}

function moveStage(state: GameState, p: PersonalityInPlay, delta: number, db: CardDb, events: GameEvent[]): void {
  const ratings = currentRatings(p, db);
  const from = p.stageIndex;
  p.stageIndex = Math.max(0, Math.min(p.stageIndex + delta, ratings.length - 1));
  p.currentRating = ratingAt(ratings, p.stageIndex);
  if (p.stageIndex !== from) {
    events.push({ type: 'stageChanged', personalityUid: p.uid, from, to: p.stageIndex });
  }
}

/** Power-Up Step: MP gains PUR stages; each Ally gains exactly 1 (CRD ~L561). */
export function powerUp(state: GameState, playerIdx: number, db: CardDb, events: GameEvent[]): void {
  const p = state.players[playerIdx];
  if (!p) return;
  moveStage(state, p.mp, purOf(state, playerIdx, p.mp, db), db, events);
  for (const ally of p.allies) moveStage(state, ally, 1, db, events);
  events.push({ type: 'poweredUp', playerIdx });
}

/** Set a personality's scouter stage directly (manual / effect). */
export function setStage(state: GameState, uid: string, stageIndex: number, db: CardDb, events: GameEvent[]): void {
  const p = findPersonality(state, uid);
  if (!p) return;
  const ratings = currentRatings(p, db);
  const from = p.stageIndex;
  p.stageIndex = Math.max(0, Math.min(stageIndex, ratings.length - 1));
  p.currentRating = ratingAt(ratings, p.stageIndex);
  if (p.stageIndex !== from) events.push({ type: 'stageChanged', personalityUid: uid, from, to: p.stageIndex });
}

/** Advance a Main Personality one level (anger reset, drills discarded). */
export function advanceLevel(state: GameState, mp: PersonalityInPlay, db: CardDb, events: GameEvent[]): void {
  if (mp.isAlly) return;
  if (mp.currentLevel >= mp.levelCardIds.length) return; // already at highest
  mp.currentLevel += 1;
  mp.anger = 0;
  // Keep the same stage position, clamped to the new level card's ladder.
  const ratings = currentRatings(mp, db);
  mp.stageIndex = Math.min(mp.stageIndex, ratings.length - 1);
  mp.currentRating = ratingAt(ratings, mp.stageIndex);
  events.push({ type: 'personalityAdvanced', personalityUid: mp.uid, toLevel: mp.currentLevel });
  // Discard this player's Drills (CRD Drill rule).
  const idx = ownerOf(state, mp.uid);
  const p = state.players[idx];
  if (p) {
    const drills = p.zones.inPlay.filter((c) => db.type(c.cardId) === 'Drill');
    if (drills.length) {
      p.zones.inPlay = p.zones.inPlay.filter((c) => db.type(c.cardId) !== 'Drill');
      p.zones.discard.push(...drills);
    }
  }
  state.log.push(`${mp.personalityName} advances to level ${mp.currentLevel}!`);
}

/**
 * Set anger; at 5+ the MP immediately advances a level (CRD ~L519).
 * Returns the uid when THIS call advanced the MP by anger — the Most Powerful
 * Personality victory requires the top level to be reached by anger, so the
 * caller must be able to tell an anger advance from a card-effect one.
 */
export function setAnger(
  state: GameState,
  uid: string,
  anger: number,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const p = findPersonality(state, uid);
  if (!p || p.isAlly) return undefined;
  const from = p.anger;
  p.anger = Math.max(0, anger);
  if (p.anger !== from) events.push({ type: 'angerChanged', personalityUid: uid, from, to: p.anger });
  if (p.anger >= ANGER_TO_ADVANCE) {
    const before = p.currentLevel;
    advanceLevel(state, p, db, events);
    if (p.currentLevel > before) return uid;
  }
  return undefined;
}

export function addAnger(
  state: GameState,
  uid: string,
  delta: number,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const p = findPersonality(state, uid);
  if (!p) return undefined;
  return setAnger(state, uid, p.anger + delta, db, events);
}

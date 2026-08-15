/** Build the initial GameState from two decks (CRD pre-game setup, ~L186). */
import type {
  CardInstance,
  DeckList,
  GameState,
  PersonalityInPlay,
  PlayerState,
  PowerRating,
  Zone,
} from '@dbz/shared';
import type { CardDb } from './loader.js';
import { makeRng, shuffle, type Rng } from './rng.js';
import { bracketOf, isZ } from './pat.js';

/** Power stages above 0 where scouters start (CRD setup step 3). */
export const START_STAGES_ABOVE_ZERO = 5;

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}${uidCounter}`;
}

function emptyZones(): Record<Zone, CardInstance[]> {
  return { lifeDeck: [], hand: [], discard: [], inPlay: [], removed: [], sensei: [] };
}

function instance(cardId: string, faceDown: boolean): CardInstance {
  return { uid: uid('c'), cardId, faceDown };
}

function ratingAt(ratings: PowerRating[], idx: number): PowerRating {
  if (ratings.length === 0) return 0;
  const i = Math.max(0, Math.min(idx, ratings.length - 1));
  return ratings[i]!;
}

function buildMp(deck: DeckList, db: CardDb): PersonalityInPlay {
  const level1Id = deck.mpLevels[0]!;
  const p = db.personality(level1Id);
  const ratings = p?.powerRatings ?? [0];
  const zero = p?.zeroStageIndex ?? 0;
  const stageIndex = Math.min(zero + START_STAGES_ABOVE_ZERO, Math.max(0, ratings.length - 1));
  return {
    uid: uid('mp'),
    personalityName: p?.personalityName ?? 'Unknown',
    alignment: p?.alignment ?? 'Rogue',
    levelCardIds: deck.mpLevels.slice(),
    currentLevel: 1,
    stageIndex,
    currentRating: ratingAt(ratings, stageIndex),
    anger: 0,
    isAlly: false,
  };
}

function buildLifeDeck(deck: DeckList, rng: Rng): CardInstance[] {
  const cards: CardInstance[] = [];
  for (const { cardId, qty } of deck.life) {
    for (let i = 0; i < qty; i++) cards.push(instance(cardId, true));
  }
  return shuffle(cards, rng);
}

function buildPlayer(idx: number, name: string, deck: DeckList, db: CardDb, rng: Rng): PlayerState {
  const mp = buildMp(deck, db);
  const zones = emptyZones();
  zones.lifeDeck = buildLifeDeck(deck, rng);
  const player: PlayerState = {
    idx,
    name,
    connected: true,
    alignment: mp.alignment,
    mp,
    allies: [],
    zones,
    dragonBalls: [],
    ready: true,
  };
  if (deck.masteryId) player.masteryCardId = deck.masteryId;
  if (deck.senseiId) player.senseiCardId = deck.senseiId;
  return player;
}

/**
 * D-Power Rule (CRD setup step 4): whoever's MP at "5 above 0" is in a lower PAT
 * bracket goes first; ties (or any Z) are random.
 */
function chooseFirstPlayer(r0: PowerRating, r1: PowerRating, db: CardDb, rng: Rng): number {
  if (isZ(r0) || isZ(r1)) return rng.next() < 0.5 ? 0 : 1;
  // "D bracket or higher": find 'D' index in the active table (falls back to mid).
  const dLike = (r: number) => bracketOf(r) >= 3;
  const h0 = dLike(r0);
  const h1 = dLike(r1);
  if (h0 !== h1) return h0 ? 1 : 0; // the lower-bracket player goes first
  return rng.next() < 0.5 ? 0 : 1;
}

export interface NewGameOptions {
  seed: number;
  players: Array<{ name: string; deck: DeckList }>;
}

export function createGame(opts: NewGameOptions, db: CardDb): GameState {
  uidCounter = 0;
  const rng = makeRng(opts.seed);
  const players = opts.players.map((p, i) => buildPlayer(i, p.name, p.deck, db, rng));

  const first =
    players.length === 2
      ? chooseFirstPlayer(players[0]!.mp.currentRating, players[1]!.mp.currentRating, db, rng)
      : 0;

  return {
    seed: opts.seed,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: first,
    step: 'draw',
    players,
    log: [`Game start — ${players[first]!.name} goes first.`],
  };
}

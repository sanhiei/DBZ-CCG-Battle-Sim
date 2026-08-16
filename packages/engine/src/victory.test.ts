/** Victory conditions against the CRD's exact wording. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameEvent, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { checkVictory, deferDragonVictory, DRAGON_BALL_SET_SIZE, highestPossibleLevel } from './victory.js';
import { reduce } from './reducer.js';

/* ---------- fixtures ---------- */

const ball = (n: number, saga = 'Saiyan'): EngineCard => ({
  id: `db-${saga}-${n}`,
  number: n,
  name: `Dragon Ball ${n}`,
  style: null,
  saga,
  rarity: 'Rare',
  imageUrl: '',
  rules: { type: 'Dragon Ball', coverage: 'metadata' },
});

const personality = (id: string, level: number, name: string): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: {
      level,
      personalityName: name,
      alignment: 'Hero',
      powerRatings: [0, 100, 200, 300, 400, 500],
      zeroStageIndex: 0,
      pur: 1,
      canBeAlly: false,
    },
  },
});

const db = new CardDb([
  ...Array.from({ length: 8 }, (_, i) => ball(i + 1)),
  ...Array.from({ length: 3 }, (_, i) => ball(i + 1, 'Frieza')),
  ...['a', 'b', 'c'].map((s, i) => personality(`goku-${i + 1}`, i + 1, 'Goku')),
  ...['a', 'b', 'c'].map((s, i) => personality(`vegeta-${i + 1}`, i + 1, 'Vegeta')),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `i${uid++}`, cardId, faceDown: true });

function makeState(over: Partial<GameState> = {}): GameState {
  const mk = (idx: number, name: string, prefix: string, levels: number): GameState['players'][number] => ({
    idx,
    name,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: name,
      alignment: 'Hero',
      levelCardIds: Array.from({ length: levels }, (_, i) => `${prefix}-${i + 1}`),
      currentLevel: 1,
      stageIndex: 3,
      currentRating: 300,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: Array.from({ length: 5 }, () => inst('goku-1')),
      hand: [],
      discard: [],
      inPlay: [],
      removed: [],
      sensei: [],
    },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'draw',
    players: [mk(0, 'Goku', 'goku', 3), mk(1, 'Vegeta', 'vegeta', 3)],
    log: [],
    ...over,
  };
}

/* ---------- survival ---------- */

test('survival: an empty Life Deck loses immediately', () => {
  const s = makeState();
  s.players[1]!.zones.lifeDeck = [];
  const events: GameEvent[] = [];
  assert.equal(checkVictory(s, db, events), true);
  assert.equal(s.phase, 'ended');
  assert.equal(s.winnerIdx, 0);
  assert.equal(s.victoryType, 'survival');
  assert.ok(events.some((e) => e.type === 'gameEnded'));
});

test('survival: one card left is not a loss', () => {
  const s = makeState();
  s.players[1]!.zones.lifeDeck = [inst('goku-1')];
  assert.equal(checkVictory(s, db, []), false);
  assert.equal(s.phase, 'playing');
});

test('survival fires through the reducer when a draw empties the deck', () => {
  const s = makeState();
  s.players[0]!.zones.lifeDeck = [inst('goku-1'), inst('goku-1')];
  const r = reduce(s, { type: 'drawCards', playerIdx: 0, count: 2 }, db, 0);
  assert.equal(r.state.phase, 'ended');
  assert.equal(r.state.victoryType, 'survival');
  assert.equal(r.state.winnerIdx, 1, 'the player who emptied their own deck loses');
});

/* ---------- dragon balls ---------- */

test('dragon ball: 7 of one set wins', () => {
  const s = makeState();
  s.players[0]!.dragonBalls = Array.from({ length: DRAGON_BALL_SET_SIZE }, (_, i) => inst(`db-Saiyan-${i + 1}`));
  assert.equal(checkVictory(s, db, []), true);
  assert.equal(s.victoryType, 'dragonBall');
  assert.equal(s.winnerIdx, 0);
});

test('dragon ball: duplicates of the same ball do not count twice', () => {
  const s = makeState();
  s.players[0]!.dragonBalls = Array.from({ length: DRAGON_BALL_SET_SIZE }, () => inst('db-Saiyan-1'));
  assert.equal(checkVictory(s, db, []), false, 'seven copies of ball #1 is not a set');
  assert.equal(s.phase, 'playing');
});

test('dragon ball: balls from different sets do not combine', () => {
  const s = makeState();
  s.players[0]!.dragonBalls = [
    ...Array.from({ length: 4 }, (_, i) => inst(`db-Saiyan-${i + 1}`)),
    ...Array.from({ length: 3 }, (_, i) => inst(`db-Frieza-${i + 1}`)),
  ];
  assert.equal(checkVictory(s, db, []), false, 'CRD requires 7 of the SAME set');
});

test('dragon ball: a captured 7th defers to the start of the next turn', () => {
  const s = makeState();
  s.players[0]!.dragonBalls = Array.from({ length: DRAGON_BALL_SET_SIZE }, (_, i) => inst(`db-Saiyan-${i + 1}`));
  deferDragonVictory(s, 0);

  // Not yet — it is player 0's turn but the claim was only just made.
  s.activePlayerIdx = 1;
  s.step = 'draw';
  assert.equal(checkVictory(s, db, []), false);
  assert.equal(s.phase, 'playing');

  // Start of the capturer's next turn: the win lands.
  s.activePlayerIdx = 0;
  s.step = 'draw';
  assert.equal(checkVictory(s, db, []), true);
  assert.equal(s.victoryType, 'dragonBall');
});

test('dragon ball: a deferred win is lost if the set is broken first', () => {
  const s = makeState();
  s.players[0]!.dragonBalls = Array.from({ length: DRAGON_BALL_SET_SIZE }, (_, i) => inst(`db-Saiyan-${i + 1}`));
  deferDragonVictory(s, 0);
  // Opponent recaptures one before the claim matures.
  s.players[0]!.dragonBalls.pop();
  s.activePlayerIdx = 0;
  s.step = 'draw';
  assert.equal(checkVictory(s, db, []), false);
  assert.equal(s.phase, 'playing');
  assert.equal(s.pendingDragonVictory, undefined, 'the stale claim is cleared');
});

/* ---------- most powerful personality ---------- */

test('highestPossibleLevel spans every MP in the game', () => {
  const s = makeState();
  s.players[1]!.mp.levelCardIds = ['vegeta-1', 'vegeta-2', 'vegeta-3', 'vegeta-4', 'vegeta-5'];
  assert.equal(highestPossibleLevel(s), 5);
});

test('most powerful: reaching the top level by anger wins', () => {
  const s = makeState();
  s.players[0]!.mp.currentLevel = 3; // top of a 3-level stack, and no MP has more
  assert.equal(checkVictory(s, db, [], { advancedByAngerUid: 'mp0' }), true);
  assert.equal(s.victoryType, 'mostPowerful');
  assert.equal(s.winnerIdx, 0);
});

test('most powerful: the same level WITHOUT an anger advance does not win', () => {
  const s = makeState();
  s.players[0]!.mp.currentLevel = 3;
  assert.equal(checkVictory(s, db, []), false, 'CRD grants this only when reached by anger');
  assert.equal(s.phase, 'playing');
});

test('most powerful: not the highest level in the game is no win', () => {
  const s = makeState();
  s.players[1]!.mp.levelCardIds = ['vegeta-1', 'vegeta-2', 'vegeta-3', 'vegeta-4', 'vegeta-5'];
  s.players[0]!.mp.currentLevel = 3; // top of ITS stack, but 5 is possible here
  assert.equal(checkVictory(s, db, [], { advancedByAngerUid: 'mp0' }), false);
});

test('most powerful fires through the reducer on an anger advance', () => {
  const s = makeState();
  s.players[0]!.mp.currentLevel = 2;
  const r = reduce(s, { type: 'setAnger', personalityUid: 'mp0', anger: 5 }, db, 0);
  assert.equal(r.state.players[0]!.mp.currentLevel, 3);
  assert.equal(r.state.phase, 'ended');
  assert.equal(r.state.victoryType, 'mostPowerful');
});

/* ---------- guards ---------- */

test('an ended game is not re-decided', () => {
  const s = makeState();
  s.phase = 'ended';
  s.winnerIdx = 1;
  s.victoryType = 'concede';
  s.players[1]!.zones.lifeDeck = [];
  assert.equal(checkVictory(s, db, []), false);
  assert.equal(s.victoryType, 'concede', 'the original result stands');
});

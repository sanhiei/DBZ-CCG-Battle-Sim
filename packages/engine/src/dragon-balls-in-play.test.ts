/**
 * Dragon Balls reaching the table at all.
 *
 * CRD ~L216 lists Dragon Balls among the cards you may play in your Non-Combat
 * Step, and they were missing from the playable set — so 53 cards could never
 * leave hand. Everything downstream was already built and tested: capture off
 * life-card damage, the seven-of-a-set win, the deferred claim, the Dragon Ball
 * Loop. A whole victory condition had no on-ramp.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { playCard } from './noncombat.js';
import { checkVictory } from './victory.js';

const ball = (n: number, saga = 'Saiyan'): EngineCard => ({
  id: `db${n}-${saga}`,
  number: n,
  name: `Earth Dragon Ball ${n}`,
  style: null,
  saga,
  rarity: 'Rare',
  imageUrl: '',
  rules: { type: 'Dragon Ball', coverage: 'metadata' },
});

const mpCard: EngineCard = {
  id: 'mp1',
  number: null,
  name: 'Goku',
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: [0, 100, 200], zeroStageIndex: 0, pur: 1, canBeAlly: false },
  },
};

const plain: EngineCard = {
  id: 'plain',
  number: null,
  name: 'Plain Card',
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: { type: 'Non-Combat', coverage: 'metadata' },
};

const db = new CardDb([mpCard, plain, ...Array.from({ length: 7 }, (_, i) => ball(i + 1))]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function state(hand: CardInstance[]): GameState {
  const player = (idx: number, h: CardInstance[]): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: 'Goku',
      alignment: 'Hero',
      levelCardIds: ['mp1'],
      currentLevel: 1,
      stageIndex: 1,
      currentRating: 100,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: [inst('plain'), inst('plain')], hand: h, discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'nonCombat',
    players: [player(0, hand), player(1, [])],
    log: [],
  };
}

test('a Dragon Ball can be played from hand', () => {
  const b = inst('db1-Saiyan');
  const s = state([b]);
  assert.equal(playCard(s, 0, b.uid, db, []), undefined);
  assert.equal(s.players[0]!.zones.hand.length, 0, 'it left hand');
});

test('a played Dragon Ball is CONTROLLED, not just in play', () => {
  // The victory condition counts control, so it has to land in dragonBalls —
  // sitting in inPlay with the Drills would never have counted.
  const b = inst('db1-Saiyan');
  const s = state([b]);
  playCard(s, 0, b.uid, db, []);
  assert.equal(s.players[0]!.dragonBalls.length, 1);
  assert.equal(s.players[0]!.zones.inPlay.length, 0);
});

test('playing the seventh Dragon Ball of a set wins the game', () => {
  // CRD ~L163: "You win the game the moment you control all 7 Dragon Balls of
  // the same set." Unreachable until they could be played at all.
  const balls = Array.from({ length: 7 }, (_, i) => inst(`db${i + 1}-Saiyan`));
  // Hand a COPY: playCard splices the hand array, and iterating the same array
  // while it is being spliced silently skips half the balls.
  const s = state([...balls]);
  for (const b of balls) assert.equal(playCard(s, 0, b.uid, db, []), undefined);

  assert.equal(s.players[0]!.dragonBalls.length, 7);
  assert.equal(checkVictory(s, db, []), true);
  assert.equal(s.winnerIdx, 0);
  assert.equal(s.victoryType, 'dragonBall');
});

test('six is not seven', () => {
  const balls = Array.from({ length: 6 }, (_, i) => inst(`db${i + 1}-Saiyan`));
  // Hand a COPY: playCard splices the hand array, and iterating the same array
  // while it is being spliced silently skips half the balls.
  const s = state([...balls]);
  for (const b of balls) playCard(s, 0, b.uid, db, []);
  assert.equal(checkVictory(s, db, []), false);
  assert.equal(s.phase, 'playing');
});

test('Dragon Balls still cannot be played outside the Non-Combat Step', () => {
  const b = inst('db1-Saiyan');
  const s = state([b]);
  s.step = 'combat';
  assert.match(playCard(s, 0, b.uid, db, []) ?? '', /Non-Combat Step/);
});

/**
 * A deferred Dragon Ball claim belongs to one player, not to the rule.
 *
 * Capturing a 7th ball defers the win to the start of your next turn (CRD
 * ~L167). That deferral was stored as a single global flag and then used to
 * suppress the immediate Dragon Ball victory for EVERY player — so while one
 * player's claim matured, the other could hold seven balls of their own, or
 * play the last one, and not win. CRD ~L164/~L666: playing the last of the 7
 * wins immediately.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { checkVictory } from './victory.js';

const ball = (n: number): EngineCard => ({
  id: `db${n}`,
  number: n,
  name: `Earth Dragon Ball ${n}`,
  style: null,
  saga: 'Saiyan',
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
const db = new CardDb([mpCard, ...Array.from({ length: 7 }, (_, i) => ball(i + 1))]);

const sevenBalls = (): CardInstance[] => Array.from({ length: 7 }, (_, i) => ({ uid: `b${i}`, cardId: `db${i + 1}`, faceDown: false }));

function state(opts: { ballsFor?: number; pending?: number }): GameState {
  const player = (idx: number): GameState['players'][number] => ({
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
    zones: { lifeDeck: Array.from({ length: 5 }, (_, i) => ({ uid: `l${idx}-${i}`, cardId: 'mp1', faceDown: true }) as CardInstance), hand: [], discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: opts.ballsFor === idx ? sevenBalls() : [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 3,
    activePlayerIdx: 0,
    step: 'nonCombat',
    players: [player(0), player(1)],
    log: [],
    ...(opts.pending !== undefined ? { pendingDragonVictory: opts.pending } : {}),
  };
}

test('seven balls wins immediately when nothing is pending', () => {
  const s = state({ ballsFor: 1 });
  assert.equal(checkVictory(s, db, []), true);
  assert.equal(s.winnerIdx, 1);
  assert.equal(s.victoryType, 'dragonBall');
});

test("one player's deferred claim does not block the OTHER player's win", () => {
  // Player 0 has a claim maturing; player 1 holds seven of their own.
  const s = state({ ballsFor: 1, pending: 0 });
  assert.equal(checkVictory(s, db, []), true);
  assert.equal(s.winnerIdx, 1, 'player 1 wins now');
});

test('a player with a pending claim does not also win immediately', () => {
  // Their own claim is deferred, which is the whole point of the flag.
  const s = state({ ballsFor: 0, pending: 0 });
  s.activePlayerIdx = 1; // not the start of their turn, so it cannot mature yet
  assert.equal(checkVictory(s, db, []), false);
  assert.equal(s.phase, 'playing');
});

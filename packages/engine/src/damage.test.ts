/**
 * Life-card damage and the Dragon Ball rules woven through it (CRD ~L685-703).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { capturableBalls, captureBall, discardForDamage, discardForEffect, isDragonBall } from './damage.js';

const plain = (n: number): EngineCard => ({
  id: `c${n}`,
  number: n,
  name: `Card ${n}`,
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: { type: 'Physical Combat', coverage: 'metadata' },
});

const ball = (n: number): EngineCard => ({
  id: `db${n}`,
  number: n,
  name: `Dragon Ball ${n}`,
  style: null,
  saga: 'Saiyan',
  rarity: 'Rare',
  imageUrl: '',
  rules: { type: 'Dragon Ball', coverage: 'metadata' },
});

const db = new CardDb([...Array.from({ length: 12 }, (_, i) => plain(i + 1)), ...Array.from({ length: 7 }, (_, i) => ball(i + 1))]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: true });

function stateWithDeck(deck: CardInstance[], balls: CardInstance[] = []): GameState {
  const mk = (idx: number, lifeDeck: CardInstance[], dragonBalls: CardInstance[]): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: 'X',
      alignment: 'Hero',
      levelCardIds: ['c1'],
      currentLevel: 1,
      stageIndex: 3,
      currentRating: 300,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck, hand: [], discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls,
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [mk(0, deck, balls), mk(1, [inst('c1'), inst('c2')], [])],
    log: [],
  };
}

test('isDragonBall recognises the type', () => {
  assert.equal(isDragonBall(inst('db1'), db), true);
  assert.equal(isDragonBall(inst('c1'), db), false);
});

test('damage discards ordinary cards from the top', () => {
  const s = stateWithDeck([inst('c1'), inst('c2'), inst('c3'), inst('c4')]);
  const r = discardForDamage(s, 0, 3, db);
  assert.deepEqual([r.discarded, r.dragonBallsSkipped, r.exhausted], [3, 0, false]);
  assert.equal(s.players[0]!.zones.discard.length, 3);
  assert.equal(s.players[0]!.zones.lifeDeck.length, 1);
});

test('an uncovered Dragon Ball does not count and goes to the bottom', () => {
  // Deck: DB, c1, c2 — 2 damage should discard c1 and c2, cycling the ball.
  const s = stateWithDeck([inst('db1'), inst('c1'), inst('c2')]);
  const r = discardForDamage(s, 0, 2, db);
  assert.equal(r.discarded, 2);
  assert.equal(r.dragonBallsSkipped, 1);
  assert.equal(r.exhausted, false);
  const deck = s.players[0]!.zones.lifeDeck;
  assert.equal(deck.length, 1);
  assert.equal(db.get(deck[0]!.cardId)?.rules?.type, 'Dragon Ball', 'the ball is back in the deck');
  assert.ok(deck[0]!.faceDown, 'and returns face-down');
  assert.ok(s.players[0]!.zones.discard.every((c) => !isDragonBall(c, db)), 'no ball reached the discard');
});

test('Dragon Ball Loop: only balls left means the damage cannot be paid', () => {
  const s = stateWithDeck([inst('db1'), inst('db2'), inst('db3')]);
  const r = discardForDamage(s, 0, 2, db);
  assert.equal(r.discarded, 0);
  assert.equal(r.exhausted, true, 'unpayable damage — this loses the game');
  assert.equal(s.players[0]!.zones.lifeDeck.length, 3, 'the balls are still there');
});

test('damage is exhausted when the deck runs out', () => {
  const s = stateWithDeck([inst('c1'), inst('c2')]);
  const r = discardForDamage(s, 5, 5, db);
  void r;
  const r2 = discardForDamage(stateWithDeck([inst('c1'), inst('c2')]), 0, 5, db);
  assert.equal(r2.discarded, 2);
  assert.equal(r2.exhausted, true);
});

test('effect discards DO count Dragon Balls (CRD ~L703)', () => {
  const s = stateWithDeck([inst('db1'), inst('c1')]);
  const taken = discardForEffect(s, 0, 2, db);
  assert.equal(taken, 2, 'both cards counted toward the effect');
  // The ball was not in play, so it returns to the bottom rather than staying discarded.
  assert.equal(s.players[0]!.zones.discard.length, 1);
  assert.equal(s.players[0]!.zones.lifeDeck.length, 1);
  assert.ok(isDragonBall(s.players[0]!.zones.lifeDeck[0]!, db));
});

test('an effect-discarded ball already in play is removed from the game', () => {
  const ballInPlay = inst('db1');
  const s = stateWithDeck([inst('db1')], [ballInPlay]);
  discardForEffect(s, 0, 1, db);
  assert.equal(s.players[0]!.zones.removed.length, 1);
  assert.equal(s.players[0]!.zones.lifeDeck.length, 0);
});

test('capture moves a ball between players', () => {
  const b = inst('db1');
  const s = stateWithDeck([inst('c1')], []);
  s.players[1]!.dragonBalls = [b];
  assert.deepEqual(capturableBalls(s, 1), [b]);
  assert.equal(captureBall(s, 1, 0, b.uid), true);
  assert.equal(s.players[0]!.dragonBalls.length, 1);
  assert.equal(s.players[1]!.dragonBalls.length, 0);
});

test('capturing a ball the opponent does not hold fails', () => {
  const s = stateWithDeck([inst('c1')], []);
  assert.equal(captureBall(s, 1, 0, 'nope'), false);
});

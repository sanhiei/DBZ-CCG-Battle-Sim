/** Endurance (CRD ~L1114-1147). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { canUseEndurance, discardForDamageWithEndurance, enduranceValue, spendEndurance } from './damage.js';

const mk = (id: string, name: string, type: string, endurance?: number): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: 'metadata', ...(endurance !== undefined ? { endurance } : {}) },
});

const db = new CardDb([
  mk('plain', 'Plain Card', 'Physical Combat'),
  mk('end2', 'Tough Card', 'Physical Combat', 2),
  mk('end4', 'Very Tough', 'Combat', 4),
  mk('mastery', 'Red Style Mastery', 'Mastery'),
  mk('ball', 'Dragon Ball 1', 'Dragon Ball'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: true });

function makeState(deck: CardInstance[], opts: { tokui?: boolean; mastery?: boolean } = {}): GameState {
  const player = (idx: number, lifeDeck: CardInstance[]): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    ...(opts.tokui ? { tokuiWazaDeclared: true } : {}),
    mp: {
      uid: `mp${idx}`,
      personalityName: 'X',
      alignment: 'Hero',
      levelCardIds: ['plain'],
      currentLevel: 1,
      stageIndex: 3,
      currentRating: 300,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck,
      hand: [],
      discard: [],
      inPlay: opts.mastery ? [inst('mastery')] : [],
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
    step: 'combat',
    players: [player(0, deck), player(1, [inst('plain')])],
    log: [],
  };
}

test('enduranceValue reads the parsed field', () => {
  assert.equal(enduranceValue(inst('end2'), db), 2);
  assert.equal(enduranceValue(inst('plain'), db), undefined);
});

test('Endurance needs BOTH a Tokui-Waza and a Mastery in play', () => {
  assert.equal(canUseEndurance(makeState([], {}), 0, db), false);
  assert.equal(canUseEndurance(makeState([], { tokui: true }), 0, db), false, 'Tokui-Waza alone is not enough');
  assert.equal(canUseEndurance(makeState([], { mastery: true }), 0, db), false, 'a Mastery alone is not enough');
  assert.equal(canUseEndurance(makeState([], { tokui: true, mastery: true }), 0, db), true);
});

test('an ineligible player is never offered Endurance', () => {
  const s = makeState([inst('end2'), inst('plain'), inst('plain')]);
  const r = discardForDamageWithEndurance(s, 0, 2, db);
  assert.equal(r.offer, undefined);
  assert.equal(r.discarded, 2, 'the Endurance card is just ordinary damage');
});

test('an eligible player is paused at the Endurance card', () => {
  const s = makeState([inst('plain'), inst('end2'), inst('plain')], { tokui: true, mastery: true });
  const r = discardForDamageWithEndurance(s, 0, 3, db);
  assert.equal(r.discarded, 1, 'the plain card ahead of it was discarded');
  assert.ok(r.offer, 'paused at the Endurance card');
  assert.equal(r.offer!.value, 2);
  assert.equal(r.offer!.remaining, 2, 'two life cards still owed');
  assert.ok(
    s.players[0]!.zones.lifeDeck.some((c) => c.uid === r.offer!.uid),
    'the offered card is still in the deck until answered',
  );
});

test('spending Endurance removes the card and covers 1 + value', () => {
  const s = makeState([inst('end2'), inst('plain'), inst('plain'), inst('plain')], { tokui: true, mastery: true });
  const r = discardForDamageWithEndurance(s, 0, 4, db);
  assert.ok(r.offer);
  const stillOwed = spendEndurance(s, 0, r.offer!);
  // Owed 4; the card itself counts as 1 and prevents 2 more -> 1 left.
  assert.equal(stillOwed, 1);
  assert.equal(s.players[0]!.zones.removed.length, 1, 'removed from the game, not discarded');
  assert.equal(s.players[0]!.zones.discard.length, 0);
});

test('leftover Endurance is not stockpiled', () => {
  const s = makeState([inst('end4'), inst('plain')], { tokui: true, mastery: true });
  const r = discardForDamageWithEndurance(s, 0, 2, db);
  assert.ok(r.offer);
  // Owed 2, Endurance 4 -> covers everything, remainder is discarded not banked.
  assert.equal(spendEndurance(s, 0, r.offer!), 0);
});

test('Dragon Balls are still skipped while looking for Endurance', () => {
  const s = makeState([inst('ball'), inst('end2'), inst('plain')], { tokui: true, mastery: true });
  const r = discardForDamageWithEndurance(s, 0, 2, db);
  assert.equal(r.dragonBallsSkipped, 1);
  assert.ok(r.offer, 'the ball was cycled and the Endurance card surfaced');
});

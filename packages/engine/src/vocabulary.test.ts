/**
 * Rejuvenation and hand-discard vocabulary.
 *
 * Every input string here is real text from the card corpus (OCR warts and
 * all), and the negative cases are the specific misfires a naive regex makes:
 * the corpus mentions the discard pile constantly for searching, removing and
 * counting, and none of those are rejuvenation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, Effect, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { discardFromHand, parseAbility, rejuvenate } from './abilities.js';

const kinds = (effects: Effect[]): string[] => effects.map((e) => e.kind);
const find = <K extends Effect['kind']>(effects: Effect[], k: K) =>
  effects.find((e) => e.kind === k) as Extract<Effect, { kind: K }> | undefined;

/* ---------- parsing ---------- */

test('rejuvenation: bottom N cards from the discard pile', () => {
  const a = parseAbility(
    'Villains only. Place the bottom 4 cards from your discard pile at the bottom of your Life Deck.',
    'Non-Combat',
  )!;
  const r = find(a.effects, 'rejuvenate')!;
  assert.equal(r.count, 4);
  assert.equal(r.from, 'bottom');
});

test('rejuvenation: the top card of the discard pile', () => {
  const a = parseAbility(
    'Use when needed. Place the top card from your discard pile at the bottom of your Life Deck.',
    'Non-Combat',
  )!;
  const r = find(a.effects, 'rejuvenate')!;
  assert.equal(r.count, 1);
  assert.equal(r.from, 'top');
});

test('rejuvenation: a chosen number of cards', () => {
  const a = parseAbility(
    'Use when needed. Raise all personalities in play to their highest power stage. Choose 3 cards from your discard pile, and put them on the bottom of your Life Deck. Remove from the game after use.',
    'Non-Combat',
  )!;
  const r = find(a.effects, 'rejuvenate')!;
  assert.equal(r.count, 3);
  assert.equal(r.from, 'choose');
});

test('searching the discard pile is NOT rejuvenation', () => {
  const a = parseAbility(
    'Use when needed. Search your discard pile for 1 card with "Android" in the card title and place it in your hand.',
    'Non-Combat',
  );
  // Either unparsed, or parsed without inventing a rejuvenate effect.
  if (a) assert.equal(kinds(a.effects).includes('rejuvenate'), false);
});

test('removing cards from the discard pile is NOT rejuvenation', () => {
  const a = parseAbility(
    'Villains only. Choose 1 opponent and remove all of his Drills in play from the game. Limit 1 per deck.',
    'Combat',
  );
  if (a) assert.equal(kinds(a.effects).includes('rejuvenate'), false);
});

test('hand discard: an effect on the opponent', () => {
  const a = parseAbility(
    'Endurance 3. Focused physical attack doing +3 power stages of damage. If Namek Dragon Ball 4 is in play, your opponent must discard 2 cards from his hand.',
    'Physical Combat',
  )!;
  const d = find(a.effects, 'discardCards')!;
  assert.equal(d.target, 'foe');
  assert.equal(d.count, 2);
});

test('hand discard: a cost the user pays', () => {
  const a = parseAbility(
    'Use when needed. You may discard 2 cards from your hand to raise your anger 1 level.',
    'Non-Combat',
  )!;
  const d = find(a.effects, 'discardCards')!;
  assert.equal(d.target, 'user');
  assert.equal(d.count, 2);
});

test('a bare mention of discarding does not become an effect', () => {
  const a = parseAbility('Use when needed. Your opponent cannot use cards from his discard pile.', 'Non-Combat');
  if (a) assert.equal(kinds(a.effects).includes('discardCards'), false);
});

/* ---------- execution ---------- */

const db = new CardDb([
  { id: 'c', number: null, name: 'Card', style: null, saga: 'Buu', rarity: 'Common', imageUrl: '', rules: { type: 'Physical Combat', coverage: 'metadata' } } satisfies EngineCard,
]);

let uid = 0;
const inst = (): CardInstance => ({ uid: `u${uid++}`, cardId: 'c', faceDown: false });

function state(discard: number, hand: number): GameState {
  const mk = (idx: number): GameState['players'][number] => ({
    idx, name: `P${idx}`, connected: true, alignment: 'Hero',
    mp: { uid: `mp${idx}`, personalityName: 'X', alignment: 'Hero', levelCardIds: ['c'], currentLevel: 1, stageIndex: 3, currentRating: 300, anger: 0, isAlly: false },
    allies: [],
    zones: {
      lifeDeck: [inst()],
      hand: Array.from({ length: hand }, inst),
      discard: Array.from({ length: discard }, inst),
      inPlay: [], removed: [], sensei: [],
    },
    dragonBalls: [], ready: true,
  });
  return { seed: 1, phase: 'playing', turnNumber: 1, activePlayerIdx: 0, step: 'combat', players: [mk(0), mk(1)], log: [] };
}

test('rejuvenate moves cards to the BOTTOM of the Life Deck', () => {
  const s = state(5, 0);
  const before = s.players[0]!.zones.lifeDeck.length;
  assert.equal(rejuvenate(s, 0, 3, 'bottom'), 3);
  assert.equal(s.players[0]!.zones.discard.length, 2);
  assert.equal(s.players[0]!.zones.lifeDeck.length, before + 3);
  // Appended, i.e. drawn last — and face-down, since they are back in the deck.
  assert.ok(s.players[0]!.zones.lifeDeck.slice(-3).every((c) => c.faceDown));
});

test('rejuvenate takes what it can when the pile is short', () => {
  const s = state(2, 0);
  assert.equal(rejuvenate(s, 0, 4, 'bottom'), 2);
  assert.equal(s.players[0]!.zones.discard.length, 0);
});

test('rejuvenate from the top takes the most recent discards', () => {
  const s = state(4, 0);
  const topUid = s.players[0]!.zones.discard.at(-1)!.uid;
  rejuvenate(s, 0, 1, 'top');
  assert.equal(s.players[0]!.zones.lifeDeck.at(-1)!.uid, topUid);
});

test('discardFromHand moves hand cards to the discard pile', () => {
  const s = state(0, 4);
  assert.equal(discardFromHand(s, 1, 2), 2);
  assert.equal(s.players[1]!.zones.hand.length, 2);
  assert.equal(s.players[1]!.zones.discard.length, 2);
});

test('discarding an empty hand is a no-op', () => {
  const s = state(0, 0);
  assert.equal(discardFromHand(s, 0, 3), 0);
});

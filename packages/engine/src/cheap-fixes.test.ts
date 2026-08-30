/**
 * Four small CRD conformance fixes, each with an outsized consequence.
 *
 * Dragon Balls identified by title rather than type; the Namekian deck ceiling;
 * an energy attack that states power-stage damage; and playAlly enforcing none
 * of the rules about when and whose Ally may enter play.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, DeckList, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { isDragonBall } from './damage.js';
import { validateDeck, MAX_DECK_SIZE, MAX_DECK_SIZE_NAMEKIAN } from './decks.js';
import { reduce } from './reducer.js';

const card = (id: string, name: string, type: string, style: string | null = null): EngineCard => ({
  id,
  number: null,
  name,
  style,
  saga: 'Namek',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: 'metadata' },
});

const personality = (id: string, level: number): EngineCard => ({
  id,
  number: null,
  name: `Goku Lv${level}`,
  style: null,
  saga: 'Namek',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: { level, personalityName: 'Goku', alignment: 'Hero', powerRatings: [0, 100, 200, 300, 400, 500], zeroStageIndex: 0, pur: 1, canBeAlly: false },
  },
});

const ally: EngineCard = {
  id: 'ally1',
  number: null,
  name: 'Krillin',
  style: null,
  saga: 'Namek',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: { level: 1, personalityName: 'Krillin', alignment: 'Hero', powerRatings: [0, 100, 200, 300], zeroStageIndex: 0, pur: 1, canBeAlly: true },
  },
};

const db = new CardDb([
  card('ball1', 'Namek Dragon Ball 1', 'Dragon Ball'),
  card('quest', "Goku's Dragon Ball Quest", 'Combat'),
  card('nm', 'Namekian Style Mastery', 'Mastery', 'Namekian'),
  card('rm', 'Red Style Mastery', 'Mastery', 'Red'),
  card('nstyle', 'Namekian Punch', 'Physical Combat', 'Namekian'),
  card('plain', 'Plain Card', 'Physical Combat'),
  ...[1, 2, 3].map((lv) => personality(`g${lv}`, lv)),
  ally,
]);

/* ---------- Dragon Balls are a TYPE, not a word in the title ---------- */

test('a card merely NAMED after a Dragon Ball is not one', () => {
  // A false ball in a Life Deck is skipped when paying life-card damage and
  // cycled to the bottom, so the card silently refused to be damage.
  assert.equal(isDragonBall({ uid: 'a', cardId: 'quest', faceDown: true }, db), false);
});

test('a real Dragon Ball still is one', () => {
  assert.equal(isDragonBall({ uid: 'b', cardId: 'ball1', faceDown: true }, db), true);
});

/* ---------- the Namekian deck ceiling ---------- */

test('a Namekian Tokui-Waza deck may hold 90 cards', () => {
  assert.equal(MAX_DECK_SIZE, 85);
  assert.equal(MAX_DECK_SIZE_NAMEKIAN, 90);
  // 3 MP levels + mastery + 86 life cards = 90 exactly.
  const deck: DeckList = { name: 'namek', mpLevels: ['g1', 'g2', 'g3'], masteryId: 'nm', life: [{ cardId: 'nstyle', qty: 86 }] };
  const errs = validateDeck(deck, db, { enforceSize: true });
  assert.equal(errs.some((e) => /maximum/.test(e)), false, `unexpected size error: ${errs.join('; ')}`);
});

test('a non-Namekian deck is still capped at 85', () => {
  const deck: DeckList = { name: 'red', mpLevels: ['g1', 'g2', 'g3'], masteryId: 'rm', life: [{ cardId: 'plain', qty: 86 }] };
  const errs = validateDeck(deck, db, { enforceSize: true });
  assert.ok(errs.some((e) => /maximum is 85/.test(e)), `expected an 85 cap: ${errs.join('; ')}`);
});

/* ---------- playAlly is gated ---------- */

function nonCombatState(step: GameState['step'] = 'nonCombat'): GameState {
  const player = (idx: number, hand: CardInstance[]): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: 'Goku',
      alignment: 'Hero',
      levelCardIds: ['g1', 'g2', 'g3'],
      currentLevel: 3,
      stageIndex: 4,
      currentRating: 400,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: [], hand, discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step,
    players: [player(0, [{ uid: 'a1', cardId: 'ally1', faceDown: false }]), player(1, [{ uid: 'a2', cardId: 'ally1', faceDown: false }])],
    log: [],
  };
}

test('an Ally enters play from your hand in your Non-Combat Step', () => {
  const r = reduce(nonCombatState(), { type: 'playAlly', playerIdx: 0, cardUid: 'a1' }, db, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.state.players[0]!.allies.length, 1);
});

test('an Ally cannot be played outside the Non-Combat Step', () => {
  const r = reduce(nonCombatState('combat'), { type: 'playAlly', playerIdx: 0, cardUid: 'a1' }, db, 0);
  assert.match(r.error ?? '', /Non-Combat Step/);
});

test('the inactive player cannot field an Ally', () => {
  const r = reduce(nonCombatState(), { type: 'playAlly', playerIdx: 1, cardUid: 'a2' }, db, 1);
  assert.match(r.error ?? '', /only the active player/);
});

test('you cannot field an Ally out of the opponent’s hand', () => {
  // findInstance searched every zone of both players, so this used to work.
  const r = reduce(nonCombatState(), { type: 'playAlly', playerIdx: 0, cardUid: 'a2' }, db, 0);
  assert.match(r.error ?? '', /not in your hand/);
});

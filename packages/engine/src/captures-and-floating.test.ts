/**
 * The last four gaps: floating stops, the Sensei Deck, and the two capture
 * routes that were not the life-card one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ability, CardInstance, DeckList, GameState, PersonalityInPlay } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, resolveDefense, resolvePersonalityCapture } from './combat.js';
import { parseAbility } from './abilities.js';
import { validateDeck } from './decks.js';
import { createGame } from './setup.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const mk = (id: string, name: string, type: string, abilities?: Ability[], text = ''): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: abilities ? 'partial' : 'metadata', text, ...(abilities ? { abilities } : {}) },
});

const mp = (id: string, name: string, level: number): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: { level, personalityName: name, alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 1, canBeAlly: true },
  },
});

const ball = (id: string, n: number): EngineCard => ({
  id,
  number: n,
  name: `Namek Dragon Ball ${n}`,
  style: null,
  saga: 'Namek',
  rarity: 'Common',
  imageUrl: '',
  rules: { type: 'Dragon Ball', coverage: 'metadata' },
});

const db = new CardDb([
  mp('mp1', 'Goku', 1),
  mp('mp2', 'Goku', 2),
  mp('mp3', 'Goku', 3),
  mk('atk', 'Big Punch', 'Physical Combat'),
  mk('senseiOnly', 'Blue Protective Bubble', 'Combat', undefined, 'Sensei Deck only. Stops a physical or energy attack.'),
  mk('sensei', 'Master Roshi Sensei', 'Sensei', undefined, 'Deck Size: 9'),
  ball('b1', 1),
  ball('b2', 2),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

/* ------------------------------------------------------- Card Captures */

test('"capture a Dragon Ball" is a real effect now', () => {
  // Card Captures were unimplemented: no Effect carried them, so a card whose
  // whole point is taking a ball did nothing when it resolved.
  const a = parseAbility("Physical attack. If successful, also capture an opponent's Dragon Ball.", 'Physical Combat')!;
  assert.ok(a.effects.some((e) => e.kind === 'captureDragonBall'));
});

test('text that merely mentions capturing is not an instruction to capture', () => {
  const a = parseAbility('This Dragon Ball cannot be captured.', 'Dragon Ball');
  assert.equal(a?.effects.some((e) => e.kind === 'captureDragonBall') ?? false, false);
});

/* --------------------------------------- the Personality Capture Rule ~L688 */

function captureState(allyName: string, defenderBalls: string[]): GameState {
  const player = (idx: number, allies: PersonalityInPlay[], balls: string[]): GameState['players'][number] => ({
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
      stageIndex: 4,
      currentRating: LADDER[4]!,
      anger: 0,
      isAlly: false,
    },
    allies,
    zones: {
      lifeDeck: Array.from({ length: 40 }, () => inst('atk')),
      hand: [],
      discard: [],
      inPlay: [],
      removed: [],
      sensei: [],
    },
    dragonBalls: balls.map(inst),
    ready: true,
  });
  const ally: PersonalityInPlay = {
    uid: 'ally-1',
    personalityName: allyName,
    alignment: 'Hero',
    levelCardIds: ['mp1'],
    currentLevel: 1,
    stageIndex: 3,
    currentRating: LADDER[3]!,
    anger: 0,
    isAlly: true,
    inControlOfCombat: true,
  };
  const s: GameState = {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [player(0, [ally], []), player(1, [], defenderBalls)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/** Seat 0's Ally makes an energy attack (4 life cards) at seat 1. */
function energyAttack(s: GameState): void {
  const weapon = inst('atk');
  s.players[0]!.zones.hand.push(weapon);
  assert.equal(declareAttack(s, 'energy', weapon.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
}

test('a named Ally is offered the ball instead of the life cards', () => {
  // Battle-sequence step 11, and it did not exist at all — an Ally built for
  // this could never do the one thing it was built for.
  const s = captureState('Krillin', ['b1']);
  energyAttack(s);
  assert.equal(s.pendingPrompt?.type, 'personalityCapture');
});

test('taking the ball deals NO life cards', () => {
  // "rather than deal any life cards of damage" — instead-of, not as-well-as.
  const s = captureState('Krillin', ['b1']);
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  energyAttack(s);
  const ballUid = s.players[1]!.dragonBalls[0]!.uid;
  assert.equal(resolvePersonalityCapture(s, ballUid, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.players[1]!.zones.lifeDeck.length, deckBefore, 'no life cards lost');
  assert.equal(s.players[0]!.dragonBalls.length, 1, 'and the ball changed hands');
  assert.equal(s.players[1]!.dragonBalls.length, 0);
});

test('declining deals the damage as normal', () => {
  const s = captureState('Krillin', ['b1']);
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  energyAttack(s);
  assert.equal(resolvePersonalityCapture(s, null, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(deckBefore - s.players[1]!.zones.lifeDeck.length, 4);
  assert.equal(s.players[1]!.dragonBalls.length, 1, 'they keep the ball');
});

test('an Ally the rule does not name gets no offer', () => {
  // Eleven Allies are named and no others qualify.
  const s = captureState('Nappa', ['b1']);
  energyAttack(s);
  assert.notEqual(s.pendingPrompt?.type, 'personalityCapture');
});

test('the Main Personality never qualifies, however named', () => {
  // "the attacker must be an Ally".
  const s = captureState('Krillin', ['b1']);
  delete s.players[0]!.allies[0]!.inControlOfCombat;
  energyAttack(s);
  assert.notEqual(s.pendingPrompt?.type, 'personalityCapture');
});

test('no ball in play means no offer', () => {
  const s = captureState('Krillin', []);
  energyAttack(s);
  assert.notEqual(s.pendingPrompt?.type, 'personalityCapture');
});

/* ------------------------------------------------------- the Sensei Deck */

test('the Sensei Deck is actually built at setup', () => {
  // Its cards were dropped, so everything a player put in it never entered the
  // game at all.
  const deck: DeckList = {
    name: 'd',
    mpLevels: ['mp1', 'mp2', 'mp3'],
    senseiId: 'sensei',
    life: [{ cardId: 'atk', qty: 50 }],
    senseiDeck: [{ cardId: 'senseiOnly', qty: 3 }],
  };
  const g = createGame({ seed: 1, players: [{ name: 'A', deck }, { name: 'B', deck }] }, db);
  const sensei = g.players[0]!.zones.sensei;
  assert.equal(sensei.filter((c) => c.cardId === 'senseiOnly').length, 3, 'the three cards are there');
  assert.ok(sensei.some((c) => c.cardId === 'sensei'), 'and so is the Sensei card itself');
});

test('a "Sensei Deck only" card may not start in the Life Deck', () => {
  // ~L106: doing so "will receive a game loss". 31 cards say it and nothing
  // checked, so they sat in Life Decks and were drawn like anything else.
  const deck: DeckList = {
    name: 'd',
    mpLevels: ['mp1', 'mp2', 'mp3'],
    life: [{ cardId: 'senseiOnly', qty: 1 }, { cardId: 'atk', qty: 50 }],
  };
  assert.ok(
    validateDeck(deck, db, { enforceSize: false }).some((e) => /Sensei Deck only/.test(e)),
  );
});

test('the same card is legal in the Sensei Deck', () => {
  const deck: DeckList = {
    name: 'd',
    mpLevels: ['mp1', 'mp2', 'mp3'],
    life: [{ cardId: 'atk', qty: 50 }],
    senseiDeck: [{ cardId: 'senseiOnly', qty: 1 }],
  };
  assert.equal(
    validateDeck(deck, db, { enforceSize: false }).some((e) => /Sensei Deck only/.test(e)),
    false,
  );
});

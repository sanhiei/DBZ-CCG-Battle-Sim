/**
 * Answering an attack once, and not being too strict about who may answer.
 *
 * These are regressions from the combat-integrity change, found by an
 * adversarial review of it. Converting power-stage overflow into life cards
 * routed physical attacks into the life-card path for the first time — and
 * that path PAUSES for an Endurance or capture prompt, leaving the attack on
 * the table. `resolveDefense` had no guard against being called again, so the
 * same attack could be resolved repeatedly, or retroactively stopped after its
 * damage had already landed.
 *
 * The other half is the opposite mistake: the hand-only card check deleted the
 * CRD's second legal defense (a card already in play, ~L305).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ability, CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, redirectDamage, resolveDefense } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const card = (id: string, name: string, type: string, ability?: Ability, text?: string): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type,
    coverage: ability ? 'partial' : 'metadata',
    ...(ability ? { abilities: [ability] } : {}),
    ...(text ? { text } : {}),
  },
});

const stopAny: Ability = {
  trigger: 'defense',
  effects: [{ kind: 'stopAttack', attackType: 'any', window: 'thisAttack' }],
  source: 'parsed',
};
const stopLater: Ability = {
  trigger: 'defense',
  effects: [{ kind: 'stopAttack', attackType: 'physical', window: 'nextPhase' }],
  source: 'parsed',
};

const mp: EngineCard = {
  id: 'mp1',
  number: null,
  name: 'Goku',
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 1, canBeAlly: false },
  },
};

const db = new CardDb([
  mp,
  card('shield', 'Defense Shield Drill', 'Non-Combat', stopAny),
  card('block', 'Plain Block', 'Combat', stopAny),
  card('later', 'Next Phase Block', 'Combat', stopLater),
  card('mystery', 'Unreadable Card', 'Unknown', stopAny),
  card('twice', "Broly's Supreme Power", 'Physical Combat', stopAny, 'Stops a physical attack. This card stays on the table to be used 1 more time this Combat.'),
  card('filler', 'Filler', 'Physical Combat'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(opts: { defenderHand?: CardInstance[]; defenderInPlay?: CardInstance[]; defenderStage?: number; ally?: boolean } = {}): GameState {
  const player = (idx: number, hand: CardInstance[], inPlay: CardInstance[], stageIndex: number): GameState['players'][number] => ({
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
      stageIndex,
      currentRating: LADDER[stageIndex]!,
      anger: 0,
      isAlly: false,
    },
    allies:
      idx === 1 && opts.ally
        ? [
            {
              uid: 'ally-1',
              personalityName: 'Krillin',
              alignment: 'Hero',
              levelCardIds: ['mp1'],
              currentLevel: 1,
              stageIndex: 3,
              currentRating: 300,
              anger: 0,
              isAlly: true,
            },
          ]
        : [],
    zones: { lifeDeck: Array.from({ length: 25 }, () => inst('filler')), hand, discard: [], inPlay, removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  const s: GameState = {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [player(0, [], [], 4), player(1, opts.defenderHand ?? [], opts.defenderInPlay ?? [], opts.defenderStage ?? 4)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/* ---------- an attack is answered exactly once ---------- */

test('the same attack cannot be resolved twice', () => {
  // Defender at 0 stages, so all damage overflows into life cards and the
  // attack finishes on the life-card path.
  const s = combatState({ defenderStage: 0 });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []), undefined);
  const afterFirst = s.players[1]!.zones.discard.length;

  const err = resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.ok(err, 'the second answer is refused');
  assert.equal(s.players[1]!.zones.discard.length, afterFirst, 'and deals no further damage');
});

test('an attack whose damage already landed cannot be retroactively stopped', () => {
  const block = inst('block');
  const s = combatState({ defenderStage: 0, defenderHand: [block] });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  const dealt = s.players[1]!.zones.discard.length;

  const err = resolveDefense(s, { cardUid: block.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.ok(err, 'the stop is refused');
  assert.equal(s.players[1]!.zones.discard.length, dealt, 'the damage stands and the block is not spent');
  assert.ok(s.players[1]!.zones.hand.some((c) => c.uid === block.uid), 'the card stays in hand');
});

/* ---------- but a legal defender is not turned away ---------- */

test('a card already in play may defend (CRD ~L305)', () => {
  // Every Defense Shield Drill and defensive Mastery lives in play and never
  // touches hand; a hand-only check deleted the option entirely.
  const shield = inst('shield');
  const s = combatState({ defenderInPlay: [shield] });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: shield.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  // A successful stop ends the attack, so currentAttack is already cleared.
  assert.equal(s.combat!.currentAttack, undefined);
  assert.ok(s.log.some((l) => l.includes('stops the attack')));
});

test('a card that defended from play stays in play', () => {
  const shield = inst('shield');
  const s = combatState({ defenderInPlay: [shield] });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: shield.uid }, { actingPlayerIdx: 1 }, db, []);
  const z = s.players[1]!.zones;
  assert.equal(z.inPlay.filter((c) => c.uid === shield.uid).length, 1, 'a permanent is not spent');
  assert.equal(z.discard.length, 0);
});

test('a card whose type line could not be read is still playable', () => {
  // 'Unknown' means OCR failed, not that the card is illegal. Refusing it took
  // 59 real cards out of the game.
  const odd = inst('mystery');
  const s = combatState({ defenderHand: [odd] });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: odd.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
});

/* ---------- the stop has to apply now, and the card is spent correctly ---------- */

test('a stop deferred to a later phase does not stop the current attack', () => {
  const later = inst('later');
  const s = combatState({ defenderHand: [later] });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: later.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /does not stop physical attacks right now/);
  assert.ok(s.players[1]!.zones.hand.some((c) => c.uid === later.uid), 'and is not spent for it');
});

test('"stays on the table" keeps the card available instead of discarding it', () => {
  const twice = inst('twice');
  const s = combatState({ defenderHand: [twice] });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: twice.uid }, { actingPlayerIdx: 1 }, db, []);
  const z = s.players[1]!.zones;
  assert.equal(z.discard.filter((c) => c.uid === twice.uid).length, 0, 'not thrown away');
  assert.equal(z.inPlay.filter((c) => c.uid === twice.uid).length, 1, 'still on the table');
});

/* ---------- redirect targets are checked ---------- */

test('damage cannot be redirected to a personality that was never offered', () => {
  // Naming any other uid found no personality and the whole attack evaporated:
  // no stages, no life cards, no if-successful chain, and no card spent.
  const s = combatState({ ally: true, defenderStage: 4 });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.pendingPrompt?.type, 'redirect', 'the ally makes redirect available');

  const err = redirectDamage(s, 'mp0', { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /not a legal redirect target/);
  assert.equal(s.pendingPrompt?.type, 'redirect', 'the prompt is still waiting for a real answer');
});

test('a legal redirect still works', () => {
  const s = combatState({ ally: true, defenderStage: 4 });
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(redirectDamage(s, 'ally-1', { actingPlayerIdx: 1 }, db, []), undefined);
  assert.ok(s.players[1]!.allies[0]!.stageIndex < 3, 'the ally took the damage');
});

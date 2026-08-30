/**
 * When an attack's riders happen.
 *
 * CRD battle-sequence step 3 resolves an attacker's secondary effects at
 * DECLARATION, but excludes two cases: an effect with "If successful" attached,
 * and an effect sharing a sentence with the attack — "An effect in the same
 * sentence as an attack is considered an 'If successful' effect."
 *
 * All of them used to fire the moment the attack was declared, so the attacker
 * banked their anger and their card draw before the defender was even offered
 * a defence, and kept the lot when the attack was stopped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, Effect, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { parseAbility } from './abilities.js';
import { beginCombat, declareAttack, resolveDefense } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];
const anger = (effects: Effect[]) => effects.find((e) => e.kind === 'changeAnger');

/* ---------- the parser marks what has to wait ---------- */

test('an "If successful" rider is deferred', () => {
  const a = parseAbility('Physical attack. If successful, raise your anger 1 level.', 'Physical Combat')!;
  assert.equal(anger(a.effects)?.ifSuccessful, true);
});

test('a rider in the SAME SENTENCE as the attack is deferred', () => {
  // The CRD says so explicitly, and it is the case people miss.
  const a = parseAbility('Physical attack doing 2 life cards of damage and raise your anger 1 level.', 'Physical Combat')!;
  assert.equal(anger(a.effects)?.ifSuccessful, true);
});

test('an unconditional rider in its own sentence is NOT deferred', () => {
  // Step 3 resolves these at declaration, stopped or not.
  const a = parseAbility('Physical attack. Raise your anger 1 level.', 'Physical Combat')!;
  assert.equal(anger(a.effects)?.ifSuccessful, undefined);
});

/* ---------- and the engine honours it ---------- */

const attackCard = (id: string, text: string): EngineCard => ({
  id,
  number: null,
  name: id,
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: { type: 'Physical Combat', coverage: 'partial', text, abilities: [parseAbility(text, 'Physical Combat')!] },
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
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 1, canBeAlly: false },
  },
};

const block: EngineCard = {
  id: 'block',
  number: null,
  name: 'Plain Block',
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Combat',
    coverage: 'partial',
    abilities: [{ trigger: 'defense', effects: [{ kind: 'stopAttack', attackType: 'any', window: 'thisAttack' }], source: 'parsed' }],
  },
};

const db = new CardDb([
  mpCard,
  block,
  attackCard('gated', 'Physical attack. If successful, raise your anger 1 level.'),
  attackCard('ungated', 'Physical attack. Raise your anger 1 level.'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(attackerHand: CardInstance[], defenderHand: CardInstance[]): GameState {
  const player = (idx: number, hand: CardInstance[]): GameState['players'][number] => ({
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
      currentRating: 400,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: Array.from({ length: 25 }, () => inst('block')), hand, discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  const s: GameState = {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [player(0, attackerHand), player(1, defenderHand)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

const abilityOf = (id: string) => db.get(id)!.rules!.abilities![0]!;

test('a deferred rider does NOT happen while the defence is still open', () => {
  const card = inst('gated');
  const s = combatState([card], []);
  declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, [], abilityOf('gated'));
  assert.ok(s.pendingPrompt, 'the defender has a window');
  assert.equal(s.players[0]!.mp.anger, 0, 'the attacker has banked nothing yet');
});

test('a deferred rider is LOST when the attack is stopped', () => {
  const card = inst('gated');
  const blk = inst('block');
  const s = combatState([card], [blk]);
  declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, [], abilityOf('gated'));
  resolveDefense(s, { cardUid: blk.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[0]!.mp.anger, 0, 'stopping the attack denies the rider');
});

test('a deferred rider happens when the attack lands', () => {
  const card = inst('gated');
  const s = combatState([card], []);
  declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, [], abilityOf('gated'));
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[0]!.mp.anger, 1, 'the rider resolves on success');
});

test('an unconditional rider still happens at declaration, stopped or not', () => {
  const card = inst('ungated');
  const blk = inst('block');
  const s = combatState([card], [blk]);
  declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, [], abilityOf('ungated'));
  assert.equal(s.players[0]!.mp.anger, 1, 'resolved at declaration (CRD step 3)');
  resolveDefense(s, { cardUid: blk.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[0]!.mp.anger, 1, 'and a stop does not take it back');
});

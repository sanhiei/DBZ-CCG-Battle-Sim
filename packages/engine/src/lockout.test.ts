/**
 * Combat-long attack lockouts.
 *
 * Parsing "stops all energy attacks for the rest of this combat" correctly is
 * only half the fix — the engine has to REFUSE those attacks afterwards, or the
 * card still does nothing beyond the attack it answered.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, resolveDefense } from './combat.js';

const lockCard = (id: string, name: string, attackType: 'physical' | 'energy' | undefined): EngineCard => ({
  id, number: null, name, style: null, saga: 'Buu', rarity: 'Common', imageUrl: '',
  rules: {
    type: 'Combat', coverage: 'partial',
    abilities: [{
      trigger: 'defense',
      effects: [{ kind: 'stopAttack', ...(attackType ? { attackType } : { attackType: 'any' as const }), window: 'thisCombat' as const, scope: 'all' as const }],
      source: 'parsed',
    }],
  },
});

const plainDefense = (id: string): EngineCard => ({
  id, number: null, name: 'Plain Block', style: null, saga: 'Buu', rarity: 'Common', imageUrl: '',
  rules: {
    type: 'Combat', coverage: 'partial',
    abilities: [{ trigger: 'defense', effects: [{ kind: 'stopAttack', attackType: 'any' as const, window: 'thisAttack' as const }], source: 'parsed' }],
  },
});

const mp = (id: string): EngineCard => ({
  id, number: null, name: 'Goku', style: null, saga: 'Buu', rarity: 'Common', imageUrl: '',
  rules: {
    type: 'Personality', coverage: 'metadata',
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: [0, 100, 200, 300, 400, 500], zeroStageIndex: 0, pur: 1, canBeAlly: false },
  },
});

const db = new CardDb([
  lockCard('lock-energy', 'Straining Focusing Move', 'energy'),
  lockCard('lock-all', "Mommy's Coming Dear", undefined),
  plainDefense('plain'),
  mp('mp1'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(defenderHand: CardInstance[]): GameState {
  const player = (idx: number, hand: CardInstance[]): GameState['players'][number] => ({
    idx, name: `P${idx}`, connected: true, alignment: 'Hero',
    mp: { uid: `mp${idx}`, personalityName: 'Goku', alignment: 'Hero', levelCardIds: ['mp1'], currentLevel: 1, stageIndex: 4, currentRating: 400, anger: 0, isAlly: false },
    allies: [],
    zones: { lifeDeck: Array.from({ length: 20 }, () => inst('plain')), hand, discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [], ready: true,
  });
  const s: GameState = {
    seed: 1, phase: 'playing', turnNumber: 1, activePlayerIdx: 0, step: 'combat',
    players: [player(0, []), player(1, defenderHand)], log: [],
  };
  beginCombat(s, db, []);
  return s;
}

test('a combat-long energy stop blocks later energy attacks', () => {
  const card = inst('lock-energy');
  const s = combatState([card]);
  // Attacker (seat 0) attacks; defender answers with the lockout card.
  assert.equal(declareAttack(s, 'energy', undefined, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);

  // Back to the attacker's phase: energy is now barred, physical is not.
  s.combat!.phasePlayerIdx = 0;
  const energyAgain = declareAttack(s, 'energy', undefined, { actingPlayerIdx: 0 }, db, []);
  assert.match(energyAgain ?? '', /energy attacks are stopped for the remainder/i);

  assert.equal(declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []), undefined,
    'a physical attack is unaffected by an energy lockout');
});

test('a combat-long "all attacks" stop blocks both kinds', () => {
  const card = inst('lock-all');
  const s = combatState([card]);
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  s.combat!.phasePlayerIdx = 0;
  assert.match(declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []) ?? '', /All attacks are stopped/i);
  assert.match(declareAttack(s, 'energy', undefined, { actingPlayerIdx: 0 }, db, []) ?? '', /All attacks are stopped/i);
});

test('an ordinary defense card creates no lockout', () => {
  const card = inst('plain');
  const s = combatState([card]);
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  s.combat!.phasePlayerIdx = 0;
  assert.equal(s.combat!.lockouts, undefined);
  assert.equal(declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []), undefined);
});

test('the lockout only binds the player it was played against', () => {
  const card = inst('lock-all');
  const s = combatState([card]);
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  // The defender's own phase: they may still attack.
  assert.equal(s.combat!.phasePlayerIdx, 1);
  assert.equal(declareAttack(s, 'physical', undefined, { actingPlayerIdx: 1 }, db, []), undefined);
});

test('lockouts do not survive into the next combat', () => {
  const card = inst('lock-all');
  const s = combatState([card]);
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.ok(s.combat!.lockouts?.length);
  // A fresh Combat Step rebuilds combat from scratch.
  beginCombat(s, db, []);
  assert.equal(s.combat!.lockouts, undefined);
});

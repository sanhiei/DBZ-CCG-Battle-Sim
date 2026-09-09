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

/**
 * Put a card that can attack into a player's hand and return its uid.
 *
 * An attack has to come from somewhere — CRD ~L286 lists what an Attack Phase
 * may be spent on and every attacking option names a source. These tests are
 * about what happens AFTER an attack is declared, so this supplies the source
 * and gets out of the way.
 */
function armAttack(s: GameState, playerIdx: number): string {
  const card = inst('plain');
  s.players[playerIdx]!.zones.hand.push(card);
  return card.uid;
}


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

/**
 * Attack into a lockout and report whether it was stopped.
 *
 * A lockout stops the ATTACK, it does not bar the declaration — CRD ~L387:
 * "If the attack is stopped, the effects are NOT stopped." Refusing at the
 * declaration meant the card was never played, so its secondary effects never
 * resolved and the card was never spent. The declaration succeeds now and the
 * attack comes back already stopped.
 */
function attackInto(s: GameState, type: 'physical' | 'energy', seat = 0): { error?: string; spent: boolean } {
  const uid = armAttack(s, seat);
  const before = s.players[seat]!.zones.hand.length;
  const error = declareAttack(s, type, uid, { actingPlayerIdx: seat }, db, []);
  return {
    ...(error !== undefined ? { error } : {}),
    spent: s.players[seat]!.zones.hand.length < before,
  };
}

test('an ATTACK card that also locks out actually locks the defender out', () => {
  // "...and stops all physical attacks for the remainder of Combat" on an
  // attack card reached applyIfSuccessful, which logged "Effect: stops a
  // physical attack" and did nothing — the log claimed a lockout that was
  // never recorded, so the defender kept attacking freely.
  const s = combatState([]);
  const ability = {
    trigger: 'attack' as const,
    effects: [
      { kind: 'physicalAttack' as const },
      { kind: 'stopAttack' as const, attackType: 'physical' as const, window: 'thisCombat' as const, scope: 'all' as const },
    ],
    source: 'parsed' as const,
  };
  assert.equal(declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, [], ability), undefined);
  assert.equal(resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []), undefined);

  // Seat 1 (the defender) is now barred from physical attacks this combat: the
  // declaration is legal, the attack is stopped, and the card is spent for it.
  const barred = attackInto(s, 'physical', 1);
  assert.equal(barred.error, undefined);
  assert.equal(barred.spent, true);
  assert.match(s.log.join('\n'), /physical attacks are stopped for the remainder/i);

  s.combat!.phasePlayerIdx = 1;
  assert.equal(declareAttack(s, 'energy', armAttack(s, 1), { actingPlayerIdx: 1 }, db, []), undefined, 'energy is untouched');
});

test('a combat-long energy stop blocks later energy attacks', () => {
  const card = inst('lock-energy');
  const s = combatState([card]);
  // Attacker (seat 0) attacks; defender answers with the lockout card.
  assert.equal(declareAttack(s, 'energy', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);

  // Back to the attacker's phase: energy is now barred, physical is not.
  s.combat!.phasePlayerIdx = 0;
  const energyAgain = attackInto(s, 'energy');
  assert.equal(energyAgain.error, undefined, 'the declaration is legal');
  assert.match(s.log.join('\n'), /attack is stopped/i, 'but the attack is stopped');
  assert.equal(energyAgain.spent, true, 'and the card is spent for it');

  s.combat!.phasePlayerIdx = 0;
  assert.equal(declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []), undefined,
    'a physical attack is unaffected by an energy lockout');
});

test('a combat-long "all attacks" stop blocks both kinds', () => {
  const card = inst('lock-all');
  const s = combatState([card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  s.combat!.phasePlayerIdx = 0;
  const phys = attackInto(s, 'physical');
  assert.equal(phys.error, undefined);
  assert.equal(phys.spent, true, 'declared, stopped, and the card spent');
  assert.match(s.log.join('\n'), /all attacks are stopped for the remainder/i);

  s.combat!.phasePlayerIdx = 0;
  const energy = attackInto(s, 'energy');
  assert.equal(energy.error, undefined);
  assert.equal(energy.spent, true);
});

test('an ordinary defense card creates no lockout', () => {
  const card = inst('plain');
  const s = combatState([card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  s.combat!.phasePlayerIdx = 0;
  assert.equal(s.combat!.lockouts, undefined);
  assert.equal(declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []), undefined);
});

test('the lockout only binds the player it was played against', () => {
  const card = inst('lock-all');
  const s = combatState([card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  // The defender's own phase: they may still attack.
  assert.equal(s.combat!.phasePlayerIdx, 1);
  assert.equal(declareAttack(s, 'physical', armAttack(s, 1), { actingPlayerIdx: 1 }, db, []), undefined);
});

test('lockouts do not survive into the next combat', () => {
  const card = inst('lock-all');
  const s = combatState([card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.ok(s.combat!.lockouts?.length);
  // A fresh Combat Step rebuilds combat from scratch.
  beginCombat(s, db, []);
  assert.equal(s.combat!.lockouts, undefined);
});

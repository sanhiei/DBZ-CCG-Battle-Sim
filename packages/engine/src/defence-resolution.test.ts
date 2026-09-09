/**
 * What a card played as a defence actually does.
 *
 * Everything the defender played resolved as a complete stop. That is the
 * strongest possible outcome, and it was applied to cards that only reduce
 * damage, to cards that stop a different kind of attack, and to cards that do
 * neither — so the defender's worst answer was as good as their best one, and
 * the attacker lost successes they had earned.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ability, CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, passPhase, resolveDefense } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const mk = (id: string, name: string, type: string, abilities?: Ability[]): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: abilities ? 'partial' : 'metadata', ...(abilities ? { abilities } : {}) },
});

const def = (effects: Ability['effects']): Ability[] => [{ trigger: 'defense', effects, source: 'parsed' }];

const db = new CardDb([
  {
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
  } as EngineCard,
  mk('atk', 'Big Punch', 'Physical Combat'),
  // Prevention only: reduces the damage, does not stop anything.
  mk('prevent2', 'Orange Hiding Drill', 'Combat', def([{ kind: 'preventLifeCards', amount: 2, attackType: 'any' }])),
  // A real combat-long stop: "stops ALL ... for the remainder of Combat".
  mk('lock', "Mommy's Coming Dear", 'Combat', def([{ kind: 'stopAttack', attackType: 'any', window: 'thisCombat', scope: 'all' }])),
  // The 17-card shape: window says thisCombat but the card stops ONE attack.
  mk('oneshot', 'Fall 7 Times', 'Combat', def([{ kind: 'stopAttack', attackType: 'any', window: 'thisCombat' }])),
  // Read, defensive, and it neither stops nor prevents.
  mk('rider', 'Just A Rider', 'Combat', def([{ kind: 'changeAnger', target: 'user', delta: 1 }])),
  // Nothing parsed at all.
  mk('unread', 'Unreadable Card', 'Combat'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(defenderHand: CardInstance[], attackerHand: CardInstance[] = []): GameState {
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
      currentRating: LADDER[4]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: Array.from({ length: 30 }, () => inst('atk')),
      hand,
      discard: [],
      inPlay: [],
      removed: [],
      sensei: [],
    },
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

/** Declare an energy attack (4 life cards) from seat 0. */
function energyAttack(s: GameState): void {
  const weapon = inst('atk');
  s.players[0]!.zones.hand.push(weapon);
  const err = declareAttack(s, 'energy', weapon.uid, { actingPlayerIdx: 0 }, db, []);
  assert.equal(err, undefined, `attack refused: ${err}`);
}

/* ------------------------------------ prevention reduces, it does not stop */

test('a prevent-2 card reduces the damage instead of cancelling the attack', () => {
  // preventLifeCards was parsed onto 20 cards, typed in the shared Effect
  // union, and read by NOTHING, so it fell through to "no modelled stop" and
  // cancelled the attack outright.
  const card = inst('prevent2');
  const s = combatState([card]);
  energyAttack(s);
  const before = s.players[1]!.zones.lifeDeck.length;
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  assert.equal(before - s.players[1]!.zones.lifeDeck.length, 2, 'energy 4 less prevented 2');
});

test('an attack that is only prevented is still successful', () => {
  // CRD ~L340 step 8: "an attack is considered successful even if it deals no
  // damage." The success is what carries the Dragon Ball capture and every "if
  // successful" rider on the card the attacker spent.
  const card = inst('prevent2');
  const s = combatState([card]);
  energyAttack(s);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(s.log.join('\n'), /prevents 2 life card/);
  assert.doesNotMatch(s.log.join('\n'), /stops the attack/);
});

test('the prevention card is spent, and so is the attack card', () => {
  const card = inst('prevent2');
  const weapon = inst('atk');
  const s = combatState([card], [weapon]);
  assert.equal(declareAttack(s, 'energy', weapon.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[1]!.zones.hand.some((c) => c.uid === card.uid), false, 'defence spent');
  assert.equal(s.players[0]!.zones.hand.some((c) => c.uid === weapon.uid), false, 'attack spent');
  assert.equal(s.players[0]!.zones.discard.filter((c) => c.uid === weapon.uid).length, 1, 'spent exactly once');
});

/* ----------------------------------------- a card has to do something here */

test('a card that neither stops nor prevents is refused', () => {
  // It was accepted and resolved as a full stop, which invented a rule the
  // card does not have.
  const card = inst('rider');
  const s = combatState([card]);
  energyAttack(s);
  assert.match(
    resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []) ?? '',
    /does not stop or prevent/,
  );
  // beginCombat deals the defender 3, so count the card itself, not the hand.
  assert.equal(s.players[1]!.zones.hand.some((c) => c.uid === card.uid), true, 'and it is not spent');
});

test('a card the parser could not read at all is still allowed', () => {
  // Coverage is partial by design; refusing every unread card would take legal
  // play away on missing data. It costs the defender the card either way.
  const card = inst('unread');
  const s = combatState([card]);
  energyAttack(s);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  assert.match(s.log.join('\n'), /no modelled effect/);
});

/* ------------------------------------------- a lockout has to mean lockout */

test('a one-shot "this Combat" stop does not lock the attacker out', () => {
  // 17 cards carry window 'thisCombat' without scope 'all'. Reading them, none
  // means it: most print "Stops an energy attack" and mention the remainder of
  // Combat for some other rider, and the rest are Defense Shields that stop
  // "the first unstopped attack this combat". Any one of them used to end the
  // opponent's entire offence for the Combat Step.
  const shield = inst('oneshot');
  const s = combatState([shield]);
  energyAttack(s);
  resolveDefense(s, { cardUid: shield.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.equal((s.combat?.lockouts ?? []).length, 0, 'no combat-long lockout');

  passPhase(s, { actingPlayerIdx: 1 }, []);
  const again = inst('atk');
  s.players[0]!.zones.hand.push(again);
  assert.equal(declareAttack(s, 'energy', again.uid, { actingPlayerIdx: 0 }, db, []), undefined, 'can attack again');
});

test('a real "stops all for the remainder of Combat" still locks out', () => {
  const card = inst('lock');
  const s = combatState([card]);
  energyAttack(s);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.equal((s.combat?.lockouts ?? []).length, 1);

  passPhase(s, { actingPlayerIdx: 1 }, []);
  const again = inst('atk');
  s.players[0]!.zones.hand.push(again);
  // The declaration is legal — a lockout stops the ATTACK (~L387), it does not
  // bar the card from being played — and the attack comes back stopped.
  assert.equal(declareAttack(s, 'energy', again.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.match(s.log.join('\n'), /attack is stopped/i);
  assert.equal(s.players[0]!.zones.hand.some((c) => c.uid === again.uid), false, 'and the card is spent');
});

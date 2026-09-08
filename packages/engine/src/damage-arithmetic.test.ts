/**
 * The terms that never got added.
 *
 * Damage was modelled as either/or: an attack dealt power stages or life cards,
 * never both, and in opposite directions for the two kinds — the physical
 * branch read life cards and threw away the stages, the energy branch read
 * stages and threw away the life cards. On top of that a "+N life cards"
 * modifier had no Effect to be carried by at all, so 51 abilities lost the
 * life-card half of their printed damage.
 *
 * CRD ~L436 is the rule: a modifier lands "even if the attack doesn't deal the
 * kind of damage that is being modified", and steps 12 and 13 deal each
 * resource in turn.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ability, CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, resolveDefense } from './combat.js';
import { applyOnPlay, firstAttackAbility, parseAbility } from './abilities.js';
import { computeBaseDamage } from './pat.js';

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

const atkAbility = (effects: Ability['effects']): Ability[] => [{ trigger: 'attack', effects, source: 'parsed' }];

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
  mk('plain', 'Plain Punch', 'Physical Combat'),
  // "Physical attack doing +2 life cards of damage" — PAT stages AND 2 cards.
  mk('physPlusLife', "Goku's Right Knee Smash", 'Physical Combat', atkAbility([
    { kind: 'physicalAttack' },
    { kind: 'damageLifeCards', cards: 2 },
  ])),
  // Black Jump Kick: states both resources outright.
  mk('bothPhys', 'Black Jump Kick', 'Physical Combat', atkAbility([
    { kind: 'physicalAttack', lifeCards: 1, powerStages: 1 },
  ])),
  // Black Strike: an energy attack stating both.
  mk('bothEnergy', 'Black Strike', 'Energy Combat', atkAbility([
    { kind: 'energyAttack', lifeCards: 2, powerStages: 2 },
  ])),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(attackerHand: CardInstance[], defenderStage = 4): GameState {
  const player = (idx: number, hand: CardInstance[], stage: number): GameState['players'][number] => ({
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
      stageIndex: stage,
      currentRating: LADDER[stage]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: Array.from({ length: 40 }, () => inst('plain')),
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
    players: [player(0, attackerHand, 4), player(1, [], defenderStage)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/** Fire `cardId` from seat 0 and let the defender take it. Returns what landed. */
function land(cardId: string, type: 'physical' | 'energy', defenderStage = 4): { stages: number; cards: number } {
  const card = inst(cardId);
  const s = combatState([card], defenderStage);
  const stageBefore = s.players[1]!.mp.stageIndex;
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  // The reducer looks the card's attack ability up and hands it to
  // declareAttack; calling declareAttack directly has to do the same, or the
  // card's printed damage is never read at all.
  const err = declareAttack(s, type, card.uid, { actingPlayerIdx: 0 }, db, [], firstAttackAbility(db.get(cardId)));
  assert.equal(err, undefined, `attack refused: ${err}`);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  return {
    stages: stageBefore - s.players[1]!.mp.stageIndex,
    cards: deckBefore - s.players[1]!.zones.lifeDeck.length,
  };
}

/* --------------------------------------- "+N life cards" is a real modifier */

test('the parser carries the amount of a "+N life cards" modifier', () => {
  // It used to set a bare boolean with no Effect to hold it, and flag the
  // ability for review. The number was read and then dropped.
  const a = parseAbility('Physical attack doing +2 life cards of damage.', 'Physical Combat')!;
  const mod = a.effects.find((e) => e.kind === 'damageLifeCards');
  assert.equal(mod?.kind === 'damageLifeCards' ? mod.cards : undefined, 2);
});

test('a physical attack with "+2 life cards" deals the PAT stages AND the 2 cards', () => {
  // ~L436: the modifier lands "even if the attack doesn't deal the kind of
  // damage that is being modified".
  const expectedStages = computeBaseDamage(LADDER[4]!, LADDER[4]!);
  const got = land('physPlusLife', 'physical');
  assert.equal(got.stages, expectedStages, 'PAT stages still land');
  assert.equal(got.cards, 2, 'and so do the life cards');
});

/* ---------------------------------------- an attack that states both, deals both */

test('a physical attack stating both resources deals both', () => {
  // Black Jump Kick: "1 life card of damage and 1 power stage of damage". The
  // physical branch read the life cards and threw the stages away.
  const got = land('bothPhys', 'physical');
  assert.equal(got.stages, 1);
  assert.equal(got.cards, 1);
});

test('an energy attack stating both resources deals both', () => {
  // Black Strike: "2 life cards and 2 power stages of damage". The energy
  // branch read the stages and threw the life cards away — the opposite half.
  const got = land('bothEnergy', 'energy');
  assert.equal(got.stages, 2);
  assert.equal(got.cards, 2);
});

test('an energy attack that states nothing still deals the default 4', () => {
  const card = inst('plain');
  const s = combatState([card]);
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  declareAttack(s, 'energy', card.uid, { actingPlayerIdx: 0 }, db, [], firstAttackAbility(db.get('plain')));
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(deckBefore - s.players[1]!.zones.lifeDeck.length, 4);
});

/* ---------------------------- a stated life-card amount replaces the PAT base */

test('a stated stage count is used instead of the PAT', () => {
  // "Base Damage ... unless it is already stated on the physical attack"
  // (~L343). Black Jump Kick states 1 stage; against a defender at stage 1 the
  // PAT says 2, so consulting the table anyway is visible here. (At equal
  // ratings the table also says 1, which is why this test drops the defender.)
  assert.equal(computeBaseDamage(LADDER[4]!, LADDER[1]!), 2, 'fixture needs the two to differ');
  assert.equal(land('bothPhys', 'physical', 1).stages, 1);
});

/* ------------------------- a card-effect drain below 0 costs life cards ~L390 */

test('"to a minimum of 0" is recorded by the parser', () => {
  const a = parseAbility('Stops a physical attack. Your opponent loses 4 power stages, to a minimum of 0.', 'Physical Combat')!;
  const e = a.effects.find((x) => x.kind === 'changePowerStages');
  assert.equal(e?.kind === 'changePowerStages' ? e.minimumZero : undefined, true);
});

test('a drain with no minimum is NOT flagged', () => {
  const a = parseAbility('Stops a physical attack. Your opponent loses 4 power stages.', 'Physical Combat')!;
  const e = a.effects.find((x) => x.kind === 'changePowerStages');
  assert.equal(e?.kind === 'changePowerStages' ? e.minimumZero : undefined, undefined);
});

test('a drain past 0 with no minimum discards the leftover from the Life Deck', () => {
  // ~L390: "if you go below 0, you must discard the top card of your life deck
  // for every power stage left over." The floor swallowed the remainder, so
  // six cards that print a drain with no minimum did nothing at all once the
  // target was already near the bottom — and discardForEffect, which exists
  // for exactly this, had no caller anywhere in the engine.
  const drain = mk('drain', 'Hard Drain', 'Physical Combat', [
    { trigger: 'onPlay', effects: [{ kind: 'changePowerStages', target: 'foe', delta: -4 }], source: 'parsed' },
  ]);
  const db2 = new CardDb([db.get('mp1')!, mk('plain', 'Plain Punch', 'Physical Combat'), drain]);
  const s = combatState([]);
  // Rebuild against db2 so the drain card resolves, and put the target at 1.
  s.players[1]!.mp.stageIndex = 1;
  s.players[1]!.mp.currentRating = LADDER[1]!;
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  applyOnPlay(s, 0, 1, [{ kind: 'changePowerStages', target: 'foe', delta: -4 }], db2, []);
  assert.equal(s.players[1]!.mp.stageIndex, 0, 'stages emptied first');
  assert.equal(deckBefore - s.players[1]!.zones.lifeDeck.length, 3, '4 asked for, 1 paid in stages, 3 in cards');
});

test('a drain that says "to a minimum of 0" stops at the bottom', () => {
  const s = combatState([]);
  s.players[1]!.mp.stageIndex = 1;
  s.players[1]!.mp.currentRating = LADDER[1]!;
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  applyOnPlay(s, 0, 1, [{ kind: 'changePowerStages', target: 'foe', delta: -4, minimumZero: true }], db, []);
  assert.equal(s.players[1]!.mp.stageIndex, 0);
  assert.equal(s.players[1]!.zones.lifeDeck.length, deckBefore, 'no life cards lost');
});

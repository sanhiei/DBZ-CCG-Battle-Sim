/**
 * What it costs to attack, and when the Physical Attack Table is read.
 *
 * An attack used to need nothing at all: no card, no power stages, no cost, and
 * the only thing that ended a Combat Step was both players volunteering to
 * stop. A scripted playthrough declared ~50 free attacks in one Combat Step and
 * emptied a 59-card Life Deck on turn 2. With a source required, the same
 * script plays 19-25 turn games.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState, PersonalityInPlay } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import {
  beginCombat,
  declareAttack,
  finalPhysicalAttack,
  passPhase,
  redirectDamage,
  resolveControlOfCombat,
  resolveDefense,
} from './combat.js';
import { computeBaseDamage } from './pat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const personality = (id: string, name: string, canBeAlly: boolean): EngineCard => ({
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
    personality: { level: 1, personalityName: name, alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 2, canBeAlly },
  },
});

const plain = (id: string, name: string, type = 'Physical Combat'): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: 'metadata' },
});

const db = new CardDb([
  personality('mp1', 'Goku', false),
  personality('ally1', 'Krillin', true),
  plain('atk', 'Big Punch'),
  plain('atk2', 'Another Punch'),
  plain('nc', 'Senzu Bean', 'Non-Combat'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

const ally = (stageIndex: number): PersonalityInPlay => ({
  uid: 'ally-1',
  personalityName: 'Krillin',
  alignment: 'Hero',
  levelCardIds: ['ally1'],
  currentLevel: 1,
  stageIndex,
  currentRating: LADDER[stageIndex]!,
  anger: 0,
  isAlly: true,
});

/** Attacker is seat 0. */
function combatState(opts: {
  attackerHand?: CardInstance[];
  defenderHand?: CardInstance[];
  attackerStage?: number;
  defenderStage?: number;
  defenderAlly?: PersonalityInPlay;
} = {}): GameState {
  const player = (idx: number, hand: CardInstance[], stageIndex: number, allies: PersonalityInPlay[]): GameState['players'][number] => ({
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
    allies,
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
    players: [
      player(0, opts.attackerHand ?? [], opts.attackerStage ?? 4, []),
      player(1, opts.defenderHand ?? [], opts.defenderStage ?? 4, opts.defenderAlly ? [opts.defenderAlly] : []),
    ],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/* ------------------------------------------------ an attack needs a source */

test('an attack with no card is refused', () => {
  // CRD ~L286-291 lists what an Attack Phase may be spent on. Every attacking
  // option names a source; "attack with nothing" is not one of them.
  const s = combatState();
  const err = declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  assert.match(err ?? '', /needs a card/);
  assert.equal(s.combat?.currentAttack, undefined);
});

test('an attack with a card in hand works, and spends the card', () => {
  const card = inst('atk');
  const s = combatState({ attackerHand: [card] });
  assert.equal(declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[0]!.zones.hand.length, 0, 'the card left hand');
  assert.equal(s.players[0]!.zones.discard.some((c) => c.uid === card.uid), true);
});

test('running out of cards ends the attacking', () => {
  // This is the whole point: attacks are finite because hands are.
  const card = inst('atk');
  const s = combatState({ attackerHand: [card] });
  declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  passPhase(s, { actingPlayerIdx: 1 }, []);
  assert.match(
    declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, []) ?? '',
    /not in your hand or in play/,
  );
});

/* ------------------------------------------------------- costs are payable */

test('an energy attack you cannot pay for is refused', () => {
  // "Energy attacks that don't have their cost listed always cost 2 power
  // stages" (~L452) and a cost is compulsory (~L806). The cost was taken with
  // a helper that caps at the bottom of the ladder and returns the unpayable
  // remainder — and the remainder was thrown away, so a personality at 0 power
  // stages performed energy attacks free, forever.
  const card = inst('atk');
  const s = combatState({ attackerHand: [card], attackerStage: 1 });
  const err = declareAttack(s, 'energy', card.uid, { actingPlayerIdx: 0 }, db, []);
  assert.match(err ?? '', /cannot pay the 2 power stage cost/);
  assert.equal(s.combat?.currentAttack, undefined);
  assert.equal(s.players[0]!.mp.stageIndex, 1, 'nothing was spent on the refusal');
});

test('an energy attack that is affordable costs exactly 2 stages', () => {
  const card = inst('atk');
  const s = combatState({ attackerHand: [card], attackerStage: 4 });
  assert.equal(declareAttack(s, 'energy', card.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.players[0]!.mp.stageIndex, 2);
});

/* ------------------------------- the PAT is read after the Control question */

test('naming an Ally changes the base damage, because the PAT is read after', () => {
  // Battle sequence step 4 is naming Control of Combat; step 9 is "Determine
  // the Base Damage" (~L343). Reading the table at declaration meant a defender
  // who used the Control rule correctly still took the damage calculated
  // against the personality they had just replaced — and the window only opens
  // when the MP is at its bottom two stages, exactly where the PAT gap is
  // widest, so the rule punished them for using it.
  const card = inst('atk');
  const s = combatState({
    attackerHand: [card],
    attackerStage: 5,
    defenderStage: 1, // MP is down, so an Ally may take over
    defenderAlly: ally(3),
  });
  assert.equal(declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.pendingPrompt?.type, 'controlOfCombat', 'the Control question is asked first');

  const againstMp = computeBaseDamage(LADDER[5]!, LADDER[1]!);
  const againstAlly = computeBaseDamage(LADDER[5]!, LADDER[3]!);
  assert.notEqual(againstMp, againstAlly, 'fixture needs the two to differ');

  resolveControlOfCombat(s, 'ally-1', { actingPlayerIdx: 1 }, db, []);
  const allyBefore = s.players[1]!.allies[0]!.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  // With the Ally in control the MP becomes a redirect target, so the damage
  // waits on that question. Decline it: this test is about the number, not
  // about who ends up wearing it.
  const afterDefence: string | undefined = s.pendingPrompt?.type;
  if (afterDefence === 'redirect') {
    redirectDamage(s, null, { actingPlayerIdx: 1 }, db, []);
  }

  const lost = allyBefore - s.players[1]!.allies[0]!.stageIndex;
  assert.equal(lost, againstAlly, 'damage was worked out against the Ally that took over');
});

/* --------------------------------------------- Final Physical Attack ~L408 */

test('a Final Physical Attack discards a card and lands PAT damage', () => {
  const cost = inst('atk');
  const s = combatState({ attackerHand: [cost], attackerStage: 4, defenderStage: 4 });
  assert.equal(finalPhysicalAttack(s, cost.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.players[0]!.zones.hand.length, 0, 'the cost was paid');
  assert.equal(s.players[0]!.zones.discard.some((c) => c.uid === cost.uid), true);

  const before = s.players[1]!.mp.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(before - s.players[1]!.mp.stageIndex, computeBaseDamage(LADDER[4]!, LADDER[4]!));
});

test('a Final Physical Attack needs a card to discard', () => {
  const s = combatState({ attackerHand: [] });
  assert.match(finalPhysicalAttack(s, 'nothing', { actingPlayerIdx: 0 }, db, []) ?? '', /discard a card/);
});

test('after a Final Physical Attack you must pass', () => {
  const cost = inst('atk');
  const later = inst('atk2');
  const s = combatState({ attackerHand: [cost, later] });
  finalPhysicalAttack(s, cost.uid, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  passPhase(s, { actingPlayerIdx: 1 }, []);
  assert.match(
    declareAttack(s, 'physical', later.uid, { actingPlayerIdx: 0 }, db, []) ?? '',
    /must pass after a Final Physical Attack/,
  );
});

test('only one Final Physical Attack per Combat', () => {
  const a = inst('atk');
  const b = inst('atk2');
  const s = combatState({ attackerHand: [a, b] });
  finalPhysicalAttack(s, a.uid, { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  passPhase(s, { actingPlayerIdx: 1 }, []);
  assert.match(
    finalPhysicalAttack(s, b.uid, { actingPlayerIdx: 0 }, db, []) ?? '',
    /already performed a Final Physical Attack/,
  );
});

test('a player who used their Final Physical Attack is not asked to defend', () => {
  // They cannot defend (~L412), so prompting them produced a question only they
  // could answer and every answer was refused. The game wedged there with no
  // legal move for either player — found by the scripted playthrough, not by a
  // unit test.
  const cost = inst('atk');
  const shield = inst('atk2');
  const counter = inst('atk');
  // Seat 1 goes first here so they can spend their Final Physical Attack and
  // then be attacked.
  const s = combatState({ attackerHand: [counter], defenderHand: [cost, shield] });
  passPhase(s, { actingPlayerIdx: 0 }, []); // hand the phase to seat 1
  assert.equal(finalPhysicalAttack(s, cost.uid, { actingPlayerIdx: 1 }, db, []), undefined);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 0 }, db, []);

  const before = s.players[1]!.mp.stageIndex;
  assert.equal(declareAttack(s, 'physical', counter.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.pendingPrompt, undefined, 'no unanswerable defend prompt');
  assert.ok(s.players[1]!.mp.stageIndex < before, 'the attack simply landed');
  assert.equal(s.players[1]!.zones.hand.some((c) => c.uid === shield.uid), true, 'their card was not spent');
});

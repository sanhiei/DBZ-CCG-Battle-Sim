/**
 * Damage modifiers from the cards on the table.
 *
 * Battle-sequence step 10 adds "any modifiers, from the attack, Drills,
 * personality powers, etc." to the Base Damage. Only the attack's own were ever
 * read — no code anywhere looked at either player's inPlay — so 45 cards
 * printing a signed damage clause were inert in BOTH directions: the +5 Drills
 * and the defensive ones that reduce incoming damage alike.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, resolveDefense } from './combat.js';
import { parseAbility } from './abilities.js';
import { computeBaseDamage } from './pat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

/** Build an in-play card straight from its printed text, through the parser. */
const printed = (id: string, name: string, type: string, text: string): EngineCard => {
  const ability = parseAbility(text, type);
  return {
    id,
    number: null,
    name,
    style: null,
    saga: 'Buu',
    rarity: 'Common',
    imageUrl: '',
    rules: { type, coverage: 'partial', text, ...(ability ? { abilities: [ability] } : {}) },
  };
};

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
  { id: 'atk', number: null, name: 'Big Punch', style: null, saga: 'Buu', rarity: 'Common', imageUrl: '', rules: { type: 'Physical Combat', coverage: 'metadata' } } as EngineCard,
  printed('boost', 'Black Striking Drill', 'Non-Combat', 'All of your physical attacks do +2 power stages of damage.'),
  printed('guard', 'Black Shadow Drill', 'Non-Combat', 'All physical attacks performed against you do 2 less power stages of damage to a minimum of 0.'),
  printed('energyGuard', 'Black Defender Drill', 'Non-Combat', 'All energy attacks performed against you do 1 less life card of damage, to a minimum of 0.'),
  printed('neutral', 'Hyperbolic Time Chamber', 'Battleground', 'All physical attacks do +1 power stage of damage.'),
  printed('conditional', 'Conditional Drill', 'Non-Combat', 'If you declared a Tokui-Waza, all of your physical attacks do +4 power stages of damage.'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(attackerInPlay: string[] = [], defenderInPlay: string[] = []): GameState {
  const player = (idx: number, inPlay: string[]): GameState['players'][number] => ({
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
      stageIndex: 5,
      currentRating: LADDER[5]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: Array.from({ length: 40 }, () => inst('atk')),
      hand: [],
      discard: [],
      inPlay: inPlay.map(inst),
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
    players: [player(0, attackerInPlay), player(1, defenderInPlay)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/** Seat 0 attacks; seat 1 takes it. Returns what actually landed. */
function land(type: 'physical' | 'energy', attackerInPlay: string[] = [], defenderInPlay: string[] = []) {
  const s = combatState(attackerInPlay, defenderInPlay);
  const weapon = inst('atk');
  s.players[0]!.zones.hand.push(weapon);
  const stageBefore = s.players[1]!.mp.stageIndex;
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  const err = declareAttack(s, type, weapon.uid, { actingPlayerIdx: 0 }, db, []);
  assert.equal(err, undefined, `attack refused: ${err}`);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  return {
    stages: stageBefore - s.players[1]!.mp.stageIndex,
    cards: deckBefore - s.players[1]!.zones.lifeDeck.length,
  };
}

/** The PAT result for this fixture, both personalities at the top of the ladder. */
const BASE = computeBaseDamage(LADDER[5]!, LADDER[5]!);

/* ---------------------------------------------------------- reading them */

test('the printed shapes parse to the right owner and resource', () => {
  const yours = parseAbility('All of your physical attacks do +2 power stages of damage.', 'Non-Combat')!;
  assert.deepEqual(yours.effects, [
    { kind: 'constantDamageModifier', amount: 2, resource: 'stages', attackType: 'physical', applies: 'yours' },
  ]);

  const against = parseAbility('All energy attacks performed against you do 1 less life card of damage.', 'Non-Combat')!;
  assert.deepEqual(against.effects, [
    { kind: 'constantDamageModifier', amount: -1, resource: 'lifeCards', attackType: 'energy', applies: 'againstYou' },
  ]);

  const neutral = parseAbility('All physical attacks do +1 power stage of damage.', 'Battleground')!;
  assert.deepEqual(neutral.effects, [
    { kind: 'constantDamageModifier', amount: 1, resource: 'stages', attackType: 'physical', applies: 'all' },
  ]);
});

test('a signed amount keeps its magnitude', () => {
  // toNum only accepts bare digits and silently falls back to 1 for anything
  // else, so "+2" was reading as +1 — a misparse is worse than no parse.
  const a = parseAbility('All of your physical attacks do +5 power stages of damage.', 'Non-Combat')!;
  assert.equal(a.effects[0]?.kind === 'constantDamageModifier' ? a.effects[0].amount : 0, 5);
});

test('a conditional clause is not treated as board state', () => {
  // "If you declared a Tokui-Waza..." is not continuous, and guessing at it
  // would apply a bonus nobody earned.
  assert.equal(parseAbility('If you declared a Tokui-Waza, all of your physical attacks do +4 power stages of damage.', 'Non-Combat'), null);
});

/* ------------------------------------------------------- applying them */

test('nothing on the table means the PAT result, unchanged', () => {
  assert.equal(land('physical').stages, BASE);
});

test("the attacker's Drill adds to their own attacks", () => {
  assert.equal(land('physical', ['boost']).stages, BASE + 2);
});

test("the attacker's Drill does nothing when the DEFENDER has it", () => {
  // "All of YOUR physical attacks" — the possessive is the whole rule.
  assert.equal(land('physical', [], ['boost']).stages, BASE);
});

test("the defender's guard Drill reduces incoming damage", () => {
  // These were inert too, which is the half nobody notices: a defensive Drill
  // did nothing for the player who tabled it.
  assert.equal(land('physical', [], ['guard']).stages, Math.max(0, BASE - 2));
});

test('a guard Drill in the ATTACKER’s play does not protect them', () => {
  assert.equal(land('physical', ['guard']).stages, BASE);
});

test('boost and guard cancel out', () => {
  assert.equal(land('physical', ['boost'], ['guard']).stages, BASE);
});

test('a neutral Battleground counts for whoever is attacking', () => {
  assert.equal(land('physical', ['neutral']).stages, BASE + 1);
  assert.equal(land('physical', [], ['neutral']).stages, BASE + 1);
});

test('an energy guard reduces life cards, not stages', () => {
  // Energy base is 4 life cards; the guard takes one off.
  assert.equal(land('energy', [], ['energyGuard']).cards, 3);
});

test('a physical modifier does not touch an energy attack', () => {
  assert.equal(land('energy', ['boost']).cards, 4, 'energy is untouched by a physical Drill');
});

test('damage cannot be reduced below zero', () => {
  // Three guards against a base of 1 must floor at 0, not go negative.
  const got = land('physical', [], ['guard', 'energyGuard', 'guard']);
  assert.ok(got.stages >= 0, `stages went to ${got.stages}`);
  assert.equal(got.stages, Math.max(0, BASE - 4));
});

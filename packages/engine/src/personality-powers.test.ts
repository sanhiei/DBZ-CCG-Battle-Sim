/**
 * The power box on a Personality card.
 *
 * Personalities were skipped by the parser outright: 0 of 600 carried an
 * ability, though every one has rules text. Every Main Personality and Ally in
 * the game was a stat block with inert text, and one of the seven things an
 * Attack Phase may be spent on — using a Personality Power — did not exist.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState, PersonalityInPlay } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { parsePersonalityPowers } from './abilities.js';
import { beginCombat, declareAttack, resolveDefense, usePersonalityPower } from './combat.js';
import { advanceLevel } from './turn.js';
import { computeBaseDamage } from './pat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

/** A personality card whose power box is parsed from its printed text. */
const person = (id: string, name: string, level: number, text: string): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'partial',
    text,
    personality: { level, personalityName: name, alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 1, canBeAlly: true },
    abilities: parsePersonalityPowers(text, 'Personality'),
  },
});

const db = new CardDb([
  person('atk1', 'Yamcha', 1, 'Power: Physical attack doing 3 power stages of damage.'),
  person('atk2', 'Yamcha', 2, 'Power: Physical attack doing 5 power stages of damage.'),
  person('rider', 'Krillin', 1, 'Power: Raise your anger 1 level.'),
  person('boost', 'Caterpy', 1, 'Constant Combat Power: All your physical attacks do +3 power stages of damage.'),
  person('blank', 'Nobody', 1, 'A flavourful sentence with no power at all.'),
  person('shield', 'Android 18', 1, 'Power: Defense Shield: Stops the first unstopped attack performed against you this Combat.'),
  { id: 'plain', number: null, name: 'Big Punch', style: null, saga: 'Buu', rarity: 'Common', imageUrl: '', rules: { type: 'Physical Combat', coverage: 'metadata' } } as EngineCard,
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function combatState(levels: [string[], string[]], ally?: PersonalityInPlay): GameState {
  const player = (idx: number): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: 'Goku',
      alignment: 'Hero',
      levelCardIds: levels[idx]!,
      currentLevel: 1,
      stageIndex: 5,
      currentRating: LADDER[5]!,
      anger: 0,
      isAlly: false,
    },
    allies: idx === 0 && ally ? [ally] : [],
    zones: {
      lifeDeck: Array.from({ length: 40 }, () => inst('plain')),
      hand: [],
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
    players: [player(0), player(1)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/* -------------------------------------------------- reading the power box */

test('the box splits into a Power and a Constant Combat Power', () => {
  const both = parsePersonalityPowers(
    'Power: Physical attack doing 3 power stages of damage. Constant Combat Power: All of your attacks do +1 life cards of damage.',
    'Personality',
  );
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((a) => a.trigger).sort(), ['constant', 'personalityPower']);
  const power = both.find((a) => a.trigger === 'personalityPower')!;
  assert.ok(power.effects.some((e) => e.kind === 'physicalAttack'), 'the Power is the attack');
  const constant = both.find((a) => a.trigger === 'constant')!;
  assert.ok(constant.effects.some((e) => e.kind === 'constantDamageModifier'));
});

test('a box with no marker yields nothing', () => {
  assert.deepEqual(parsePersonalityPowers('Just some flavour text.', 'Personality'), []);
});

test('a Constant Combat Power only yields its continuous clause', () => {
  // "Your anger level cannot be lowered" is a prohibition with no layer to live
  // in; inventing one would be worse than leaving it out.
  const a = parsePersonalityPowers('Constant Combat Power: Your anger level cannot be lowered.', 'Personality');
  assert.deepEqual(a, []);
});

/* --------------------------------------------------------- using a Power */

test('a Power that performs an attack IS the attack for that phase', () => {
  // One of the seven listed Attack Phase options (~L290), and the only
  // legitimate way to attack without a card now that a bare attack is refused.
  const s = combatState([['atk1'], ['blank']]);
  assert.equal(usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.combat?.currentAttack?.attackType, 'physical');

  const before = s.players[1]!.mp.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(before - s.players[1]!.mp.stageIndex, 3, 'the stated 3 stages, not the PAT');
});

test('a Power with no attack resolves its riders and passes the phase', () => {
  const s = combatState([['rider'], ['blank']]);
  assert.equal(usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.players[0]!.mp.anger, 1);
  assert.equal(s.combat?.phasePlayerIdx, 1, 'the phase passes');
});

test('a Power is once per turn', () => {
  const s = combatState([['rider'], ['blank']]);
  usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []);
  s.combat!.phasePlayerIdx = 0; // hand the phase back
  assert.match(
    usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []) ?? '',
    /already used their Personality Power/,
  );
});

test('advancing a level gives the Power back the same turn', () => {
  // "unless the character advances or loses a Personality level. When this
  // happens you get to use the card effect again even if you used it earlier
  // this turn" (~L492).
  const s = combatState([['atk1', 'atk2'], ['blank']]);
  usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []);
  assert.equal(s.players[0]!.mp.usedPowerTurn, s.turnNumber);
  advanceLevel(s, s.players[0]!.mp, db, []);
  assert.equal(s.players[0]!.mp.usedPowerTurn, undefined);
});

test('a personality with no readable power says so', () => {
  const s = combatState([['blank'], ['blank']]);
  assert.match(usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []) ?? '', /no Personality Power/);
});

test('only the personality in Control may use its power', () => {
  // "You cannot use your MP's power when an Ally is in control of Combat and
  // vice-versa" (~L492).
  const ally: PersonalityInPlay = {
    uid: 'ally-1',
    personalityName: 'Krillin',
    alignment: 'Hero',
    levelCardIds: ['rider'],
    currentLevel: 1,
    stageIndex: 3,
    currentRating: LADDER[3]!,
    anger: 0,
    isAlly: true,
    inControlOfCombat: true,
  };
  // MP holds an attack power; the Ally in control holds the anger rider. The
  // Ally's is the one that resolves.
  const s = combatState([['atk1'], ['blank']], ally);
  assert.equal(usePersonalityPower(s, { actingPlayerIdx: 0 }, db, []), undefined);
  assert.equal(s.combat?.currentAttack, undefined, "the MP's attack power did not fire");
  // "Raise your anger" is the player's anger, which lives on the MP even when
  // an Ally is the one in Control — so this is where the Ally's power lands.
  assert.equal(s.players[0]!.mp.anger, 1, "the Ally's power did fire");
  assert.equal(s.players[0]!.allies[0]!.usedPowerTurn, s.turnNumber, 'and the ALLY is the one marked');
  assert.equal(s.players[0]!.mp.usedPowerTurn, undefined);
});

/* -------------------------------- a Constant Combat Power is continuous */

test("the controller's Constant Combat Power modifies damage", () => {
  // 209 of 600 personalities print one and not one of them did anything.
  const plain = combatState([['blank'], ['blank']]);
  const boosted = combatState([['boost'], ['blank']]);
  const base = computeBaseDamage(LADDER[5]!, LADDER[5]!);

  for (const [s, expected] of [[plain, base], [boosted, base + 3]] as const) {
    const weapon = inst('plain');
    s.players[0]!.zones.hand.push(weapon);
    const before = s.players[1]!.mp.stageIndex;
    declareAttack(s, 'physical', weapon.uid, { actingPlayerIdx: 0 }, db, []);
    resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
    assert.equal(before - s.players[1]!.mp.stageIndex, expected);
  }
});

/* ------------------------------- a Defense Shield printed on a personality */

test('a Defense Shield on the personality in Control fires at step 7', () => {
  // activateDefenseShields scanned only zones.inPlay, so the shields printed on
  // Android 18, Android 16 and Vegeta Ascendant never fired, and CRD defence
  // option 3 was unreachable.
  const s = combatState([['blank'], ['shield']]);
  const weapon = inst('plain');
  s.players[0]!.zones.hand.push(weapon);
  declareAttack(s, 'physical', weapon.uid, { actingPlayerIdx: 0 }, db, []);
  const before = s.players[1]!.mp.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[1]!.mp.stageIndex, before, 'the shield stopped it');
  assert.match(s.log.join('\n'), /activates and stops the attack/);
});

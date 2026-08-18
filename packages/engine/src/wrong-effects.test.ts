/**
 * Effects the parser produced, but produced WRONG.
 *
 * These are more dangerous than a missing effect: the card is presented as
 * modelled and the engine confidently does the wrong thing — refusing a legal
 * defence, locking out attacks the card never locked out, or replacing the
 * Physical Attack Table with a number scraped out of a conditional clause.
 *
 * Every text below is the printed text of a card the ability audit flagged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect } from '@dbz/shared';
import { parseAbility } from './abilities.js';

const of = <K extends Effect['kind']>(effects: Effect[], k: K) =>
  effects.filter((e) => e.kind === k) as Array<Extract<Effect, { kind: K }>>;

/* ---------- "physical or energy" means either, not the last one ---------- */

test('a card that stops either attack type is not narrowed to one', () => {
  // Blue Shifting Maneuver. The lazy match walked past "physical or" and
  // captured "energy", so the engine refused to let the card stop a physical
  // attack — a legal defence the player simply could not make.
  const a = parseAbility('Stops a physical or energy attack. Remove from the game after use.', 'Combat')!;
  assert.equal(of(a.effects, 'stopAttack')[0]?.attackType, 'any');
});

test('a single named attack type is still respected', () => {
  const a = parseAbility('Stops an energy attack.', 'Energy Combat')!;
  assert.equal(of(a.effects, 'stopAttack')[0]?.attackType, 'energy');
});

/* ---------- when a stop actually happens ---------- */

test('"stops the next attack ... this Combat" is one deferred stop, not a lockout', () => {
  // Red Power Lift. The clause names a combat, so the combat-long test claimed
  // it and turned a single stop into a lockout on every later attack.
  const a = parseAbility(
    'Physical attack doing +3 power stages of damage. Stops the next physical attack performed against you this Combat.',
    'Physical Combat',
  )!;
  const stop = of(a.effects, 'stopAttack')[0]!;
  assert.equal(stop.window, 'nextPhase');
  assert.equal(stop.attackType, 'physical');
});

test('a named phase between "next" and "phase" is still next phase', () => {
  // Blue Energy Dive — the phase name sits in the middle, so the old pattern
  // walked past it and resolved the stop against the current attack instead.
  const a = parseAbility(
    'Stops an energy attack performed against you during your opponent\'s next "Attacker Attacks" phase.',
    'Energy Combat',
  )!;
  assert.equal(of(a.effects, 'stopAttack')[0]?.window, 'nextPhase');
});

test('a genuine combat-long lockout is unaffected', () => {
  const a = parseAbility('Stops all attacks for the remainder of Combat.', 'Combat')!;
  const stop = of(a.effects, 'stopAttack')[0]!;
  assert.equal(stop.window, 'thisCombat');
  assert.equal(stop.scope, 'all');
});

/* ---------- damage bases ---------- */

test('an attack that deals no damage is encoded as a fixed zero', () => {
  // Blue Diving Punch Drill. Left without a base the engine rolled the Physical
  // Attack Table and dealt damage the card explicitly forbids. An attack
  // dealing nothing can still be "successful" (CRD battle-sequence step 8).
  const a = parseAbility(
    'Physical attack. Your opponent cannot take life cards or power stages of damage from this attack.',
    'Physical Combat',
  )!;
  assert.equal(of(a.effects, 'physicalAttack')[0]?.powerStages, 0);
});

test('a signed life-card rider does not erase a printed power-stage base', () => {
  // Carpet Attack Technique. The parser saw "+3 life cards", declared the whole
  // text a modifier and returned, losing the printed 3-power-stage base.
  const a = parseAbility(
    'Physical attack doing 3 power stages of damage. For each Non-Combat card discarded, this attack does an additional +3 life cards of damage.',
    'Physical Combat',
  )!;
  const atk = of(a.effects, 'physicalAttack')[0]!;
  assert.equal(atk.powerStages, 3, 'the printed base survives');
  assert.equal(atk.lifeCards, undefined, 'the rider is not a base');
});

/* ---------- anger belongs to whoever the card says ---------- */

test('naming the opponent in a CONDITION does not hand them the effect', () => {
  // Blue Speediness. The sentence mentions the opponent only to test what they
  // declared; the anger it raises is the user's.
  const a = parseAbility(
    "Stops a physical or energy attack. If you declared a Tokui-Waza and your opponent did not, raise your anger 2 levels.",
    'Physical Combat',
  )!;
  assert.deepEqual(of(a.effects, 'changeAnger'), [{ kind: 'changeAnger', target: 'user', delta: 2 }]);
});

test('both anger changes stated in ONE sentence are both kept', () => {
  // Red Fist Lunge. A single target chosen for the whole sentence lost a half.
  const a = parseAbility(
    "Physical attack. If successful, raise your anger 1 level and lower your opponent's anger 2 levels.",
    'Physical Combat',
  )!;
  const anger = of(a.effects, 'changeAnger');
  assert.equal(anger.length, 2);
  assert.equal(anger.find((e) => e.target === 'user')?.delta, 1);
  assert.equal(anger.find((e) => e.target === 'foe')?.delta, -2);
});

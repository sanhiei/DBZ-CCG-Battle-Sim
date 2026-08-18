/**
 * How long a stop lasts. The parser defaulted every stop to a single attack,
 * which understated ~50 cards audited against their printed text: "stops all
 * attacks for the remainder of Combat" resolved as "stop one attack", so every
 * later attack that combat went straight through.
 *
 * Card texts here are the ones the audit flagged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect } from '@dbz/shared';
import { parseAbility } from './abilities.js';

const stop = (effects: Effect[]) =>
  effects.find((e) => e.kind === 'stopAttack') as Extract<Effect, { kind: 'stopAttack' }> | undefined;

test('"for the remainder of Combat" lasts the whole combat', () => {
  // Mommy's Coming Dear.
  const a = parseAbility('Stops all attacks for the remainder of Combat.', 'Combat')!;
  const s = stop(a.effects)!;
  assert.equal(s.window, 'thisCombat');
  assert.equal(s.scope, 'all');
  assert.equal(s.attackType, 'any');
});

test('"in this combat" lasts the whole combat', () => {
  // Time Is A Warrior's Tool.
  const s = stop(parseAbility('Stops all attacks from an opponent in this combat.', 'Combat')!.effects)!;
  assert.equal(s.window, 'thisCombat');
  assert.equal(s.scope, 'all');
});

test('"the rest of this combat" keeps the attack type', () => {
  // Straining Focusing Move.
  const s = stop(parseAbility('Stops all energy attacks for the rest of this combat.', 'Combat')!.effects)!;
  assert.equal(s.window, 'thisCombat');
  assert.equal(s.attackType, 'energy');
});

test('"any more ... attacks in this combat" is a combat-long lockout', () => {
  // Krillin's Power Block.
  const a = parseAbility(
    'Stops a physical attack. It also stops your opponent from making any more physical attacks in this combat.',
    'Combat',
  )!;
  const s = stop(a.effects)!;
  assert.equal(s.window, 'thisCombat');
  assert.equal(s.attackType, 'physical');
});

test('a plain stop is still a single attack', () => {
  const s = stop(parseAbility('Stops a physical attack.', 'Combat')!.effects)!;
  assert.equal(s.window, 'thisAttack');
  assert.equal(s.scope, undefined, 'not an all-scope stop');
});

test('"next phase" is still the next phase, not the whole combat', () => {
  const s = stop(parseAbility('Stops a physical attack in your opponent\'s next phase.', 'Combat')!.effects)!;
  assert.equal(s.window, 'nextPhase');
});

test('"first successful" outranks a bare stop', () => {
  const s = stop(parseAbility('Stops the first successful energy attack against you.', 'Combat')!.effects)!;
  assert.equal(s.window, 'firstSuccessful');
});

test('a single-target stop is not widened to all', () => {
  const s = stop(parseAbility('Stops a single named foe attack.', 'Combat')!.effects)!;
  assert.equal(s.scope, 'single');
  assert.equal(s.window, 'thisAttack');
});

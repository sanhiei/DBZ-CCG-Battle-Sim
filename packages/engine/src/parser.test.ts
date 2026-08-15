/**
 * parseAbility against REAL text from the TTS-sourced OCR corpus — these
 * strings are what the parser actually receives, OCR warts and all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAbility } from './abilities.js';
import type { Effect } from '@dbz/shared';

const kinds = (effects: Effect[]): string[] => effects.map((e) => e.kind);

test('physical attack with fixed stages and a stun rider', () => {
  const a = parseAbility(
    'Physical attack doing 5 power stages of damage. If this attack is performed by Android 17, your opponent must skip his next attack phase.',
    'Physical Combat',
  )!;
  assert.equal(a.trigger, 'attack');
  const atk = a.effects.find((e) => e.kind === 'physicalAttack') as Extract<Effect, { kind: 'physicalAttack' }>;
  assert.equal(atk.powerStages, 5);
  assert.ok(kinds(a.effects).includes('stunSkipNextPhase'));
  assert.ok(a.needsReview?.includes('performerCondition'), 'performer condition must be flagged');
});

test('attack that removes itself from the game after use', () => {
  const a = parseAbility(
    'Physical attack doing 5 power stages of damage. If this attack is performed by Android 17, this attack does 7 power stages of damage instead. Remove from the game after use.',
    'Physical Combat',
  )!;
  assert.ok(kinds(a.effects).includes('removeFromGameAfterUse'));
  assert.ok(a.needsReview?.includes('performerCondition'));
});

test('non-combat: raise all personalities to highest stage', () => {
  const a = parseAbility(
    'Use when needed. Raise all of your personalities to their highest stage. Remove from the game after use.',
    'Non-Combat',
  )!;
  assert.equal(a.trigger, 'onPlay');
  const move = a.effects.find((e) => e.kind === 'movePowerStage') as Extract<Effect, { kind: 'movePowerStage' }>;
  assert.equal(move.target, 'user');
  assert.equal(move.to, 'highest');
  assert.ok(kinds(a.effects).includes('removeFromGameAfterUse'));
});

test('non-combat with nothing parseable stays manual', () => {
  const a = parseAbility(
    'Use when needed. Search your Life Deck for a Dragon Ball and place it in play.',
    'Non-Combat',
  );
  assert.equal(a, null, 'unmodelled effects must not be claimed');
});

test('defense with search rider is still a stop', () => {
  const a = parseAbility(
    'Stops a physical attack. If the defending personality has "Android" in the card title, search your discard pile for 1 card with "Android" in the card title and place it in your hand. Remove from the game after use.',
    'Combat',
  )!;
  assert.equal(a.trigger, 'defense');
  const stop = a.effects.find((e) => e.kind === 'stopAttack') as Extract<Effect, { kind: 'stopAttack' }>;
  assert.equal(stop.attackType, 'physical');
  assert.ok(kinds(a.effects).includes('removeFromGameAfterUse'));
});

test('villains-only drill removal is not claimed as an attack', () => {
  const a = parseAbility(
    'Villains only. Choose 1 opponent and remove all of his Drills in play from the game. Limit 1 per deck. Remove from the game after use.',
    'Combat',
  );
  // Nothing here is modelled as an attack or defense; manual is correct.
  assert.equal(a, null);
});

test('type-plate prefix is stripped before anchoring', () => {
  // OCR of the rules panel captures the embossed plate above it.
  const a = parseAbility('Physical Combat | Physical attack doing 3 power stages of damage.', 'Physical Combat')!;
  assert.equal(a.trigger, 'attack');
  const atk = a.effects.find((e) => e.kind === 'physicalAttack') as Extract<Effect, { kind: 'physicalAttack' }>;
  assert.equal(atk.powerStages, 3);
});

test('plate that swallowed the qualifier falls back to the declared type', () => {
  const a = parseAbility('Physical Combat | attack doing +4 power stages of damage if successful.', 'Physical Combat')!;
  assert.equal(a.trigger, 'attack');
  assert.ok(kinds(a.effects).includes('physicalAttack'));
  assert.ok(a.needsReview?.includes('attackKindFromType'), 'inference must be flagged');
});

test('"Non-Combat cards cannot be used" is not eaten by the plate stripper', () => {
  const a = parseAbility('Non-Combat cards cannot be used for the remainder of Combat.', 'Combat');
  assert.equal(a, null, 'must stay manual, not become a mangled parse');
});

test('energy attack keeps default life cards and flags nothing extra', () => {
  const a = parseAbility('Energy attack. Raise your anger 1 level.', 'Energy Combat')!;
  assert.equal(a.trigger, 'attack');
  assert.ok(kinds(a.effects).includes('energyAttack'));
  const anger = a.effects.find((e) => e.kind === 'changeAnger') as Extract<Effect, { kind: 'changeAnger' }>;
  assert.equal(anger.target, 'user');
  assert.equal(anger.delta, 1);
});

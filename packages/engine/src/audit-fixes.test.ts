/**
 * Regressions for defects found by auditing 1,159 parsed abilities against
 * their printed text. Every input here is a real card the audit flagged.
 *
 * The common thread: each of these produced a parse that LOOKED complete, so
 * the card was labelled `partial` coverage and the engine resolved it wrongly
 * without anyone being told. That is worse than leaving a card manual.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effect } from '@dbz/shared';
import { parseAbility } from './abilities.js';

const find = <K extends Effect['kind']>(effects: Effect[], k: K) =>
  effects.find((e) => e.kind === k) as Extract<Effect, { kind: K }> | undefined;

/* ---------- "+N life cards" is a modifier, not a base ---------- */

test('a signed life-card amount does not become the fixed base', () => {
  // Goku's Right Knee Smash. Encoding +2 as the base made the engine deal
  // exactly 2 life cards and silently drop all PAT power-stage damage.
  const a = parseAbility('Physical attack doing +2 life cards of damage.', 'Physical Combat')!;
  const atk = find(a.effects, 'physicalAttack')!;
  assert.equal(atk.lifeCards, undefined, 'must not override the PAT base');
  assert.ok(a.needsReview?.includes('lifeCardModifier'), 'and must say why it is incomplete');
});

test('an unsigned life-card amount IS the fixed base', () => {
  const a = parseAbility('Energy attack doing 5 life cards of damage.', 'Energy Combat')!;
  assert.equal(find(a.effects, 'energyAttack')!.lifeCards, 5);
  assert.ok(!a.needsReview?.includes('lifeCardModifier'), 'a real base is not a modifier');
});

/* ---------- conditional numbers are not the base ---------- */

test('a Tokui-Waza alternative does not become the base damage', () => {
  // Blue Rush. Hardcoding 5 made every copy deal 5 stages, including in decks
  // that never declared a Tokui-Waza.
  const a = parseAbility(
    'Physical attack. If you declared Tokui-Waza, this attack does 5 power stages of damage instead.',
    'Physical Combat',
  )!;
  const atk = find(a.effects, 'physicalAttack')!;
  assert.equal(atk.powerStages, undefined, 'the printed base is the PAT, not the conditional 5');
  assert.ok(a.needsReview?.includes('conditionalDamage'));
});

test('an unconditional power-stage base is still taken', () => {
  const a = parseAbility('Physical attack doing 5 power stages of damage.', 'Physical Combat')!;
  assert.equal(find(a.effects, 'physicalAttack')!.powerStages, 5);
  assert.ok(!a.needsReview?.includes('conditionalDamage'), 'an unconditional base is not conditional');
});

/* ---------- "anger to 0" is a set, not a delta ---------- */

test('lowering anger to zero is encoded as a set, not delta 0', () => {
  // Blue Foot Smash / Goku's Dashing Punch. delta:0 executed as "change anger
  // by nothing" while the card was presented as fully modelled.
  const a = parseAbility('Physical attack. Lower your anger to 0.', 'Physical Combat')!;
  const anger = find(a.effects, 'changeAnger')!;
  assert.equal(anger.toZero, true);
  assert.equal(anger.target, 'user');
});

test('an ordinary anger delta is unaffected', () => {
  const a = parseAbility('Physical attack. Raise your anger 1 level.', 'Physical Combat')!;
  const anger = find(a.effects, 'changeAnger')!;
  assert.equal(anger.toZero, undefined);
  assert.equal(anger.delta, 1);
});

/* ---------- alignment restrictions survive the prefix strip ---------- */

test('"Villains only" is recorded as a restriction', () => {
  // stripLead removes the prefix before parsing, so without an explicit check
  // the restriction vanished and a Hero deck could play the card.
  const a = parseAbility('Villains only. Physical attack doing 3 power stages of damage.', 'Physical Combat')!;
  assert.equal(a.restriction?.alignment, 'Villain');
});

test('"Heroes only" is recorded as a restriction', () => {
  const a = parseAbility('Heroes only. Energy attack.', 'Energy Combat')!;
  assert.equal(a.restriction?.alignment, 'Hero');
});

test('a named-only restriction is not flattened to an alignment', () => {
  const a = parseAbility('Villains, Goku and Gohan only. Physical attack.', 'Physical Combat')!;
  assert.deepEqual(a.restriction?.namedOnly, ['Villains', 'Goku', 'Gohan']);
  assert.equal(a.restriction?.alignment, undefined);
});

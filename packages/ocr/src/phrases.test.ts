/** Corpus-correction tests: snapping must fix OCR noise and never invent content. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctText, editDistance, mineTemplates, normalizeKey, snapSentence, splitSentences } from './phrases.ts';

const TEMPLATES = mineTemplates(
  [
    ...Array(50).fill('Remove from the game after use.'),
    ...Array(30).fill('Physical attack doing +3 power stages of damage.'),
    ...Array(20).fill('Raise your anger 1 level.'),
    ...Array(15).fill('Costs 3 power stages to perform.'),
  ],
  8,
);

test('mining keeps the most frequent raw spelling as canonical', () => {
  const t = mineTemplates([...Array(9).fill('Stops a physical attack.'), 'stops a Physical attack,'], 8);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.canonical, 'Stops a physical attack.');
  assert.equal(t[0]!.count, 10, 'the noisy variant still counts toward the cluster');
});

test('normalizeKey slots digits so numbers do not fragment templates', () => {
  assert.equal(normalizeKey('Raise your anger 1 level.'), normalizeKey('Raise your anger 2 level.'));
});

test('snapping fixes OCR noise', () => {
  const r = snapSentence('Remove frorn the garne after use', TEMPLATES);
  assert.equal(r.snapped, true);
  assert.equal(r.text, 'Remove from the game after use.');
});

test('a snap re-slots the digits from the noisy input, never the template', () => {
  const r = snapSentence('Physical attack doinq +5 power staqes of damage.', TEMPLATES);
  assert.equal(r.snapped, true);
  assert.equal(r.text, 'Physical attack doing +5 power stages of damage.', 'the 5 must survive');
});

test('a snap is refused when digit shapes differ', () => {
  // Template has one digit slot; the input lost its number entirely.
  const r = snapSentence('Physical attack doinq + power staqes of damage.', TEMPLATES);
  assert.equal(r.text.includes('+3'), false, 'must not adopt the template number');
});

test('unrelated text is never snapped', () => {
  const r = snapSentence('Search your Life Deck for a Dragon Ball and place it in play.', TEMPLATES);
  assert.equal(r.snapped, false);
});

test('correctText snaps per-sentence and reports the count', () => {
  const noisy = 'Raise your anqer 1 level. Search your Life Deck for a card.\n\nRemove frorn the game after use';
  const { text, snappedCount } = correctText(noisy, TEMPLATES);
  assert.equal(snappedCount, 2);
  assert.ok(text.includes('Raise your anger 1 level.'));
  assert.ok(text.includes('Search your Life Deck for a card.'), 'unmatched sentence untouched');
});

test('editDistance band cutoff returns Infinity fast', () => {
  assert.equal(editDistance('abcdef', 'abcdef', 2), 0);
  assert.equal(editDistance('abcdef', 'abcxef', 2), 1);
  assert.equal(editDistance('short', 'a completely different long string', 3), Infinity);
});

test('splitSentences tolerates missing terminal periods across newlines', () => {
  const s = splitSentences('Stops a physical attack. If successful draw a card.\n\nLimit 1 per deck');
  assert.equal(s.length, 3);
});

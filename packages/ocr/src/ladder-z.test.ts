/**
 * Scouters rated Z the whole way up.
 *
 * Some personalities have no numbers on their scouter at all — every rung is
 * Z. The reader recognised "Z" as a rung and then could never emit such a
 * ladder: the "a real ladder spans most of the card" guard measured the span
 * across the NUMERIC run only, which is empty on those cards, so span was 0
 * and every all-Z scouter was rejected as art.
 *
 * That silently cost the catalog a class of Main Personality, since a card
 * with no readable ladder is not classified as a personality at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLadder, type Word } from './layout.ts';

/** One rung of a scouter column, as Tesseract reports it. */
const rung = (text: string, yTop: number): Word => ({
  text,
  x0: 0.1,
  x1: 0.16,
  y0: yTop,
  y1: yTop + 0.03,
  conf: 60,
});

/** Eleven rungs down the left edge, evenly spaced across the card. */
const column = (labels: string[]): Word[] => labels.map((t, i) => rung(t, 0.08 + i * 0.075));

test('an all-Z scouter is read as a ladder', () => {
  const r = detectLadder(column(Array.from({ length: 11 }, () => 'Z')));
  assert.equal(r.ok, true, r.reason ?? '');
  assert.equal(r.ratings.length, 11);
  assert.ok(
    r.ratings.every((v) => v === 'Z'),
    'every rung is Z',
  );
});

test('a numeric scouter still reads the same way', () => {
  // Descending top to bottom, bottoming out at the zero stage.
  const r = detectLadder(column(['1000', '900', '800', '700', '600', '500', '400', '300', '200', '100', '0']));
  assert.equal(r.ok, true, r.reason ?? '');
  assert.equal(r.ratings[0], 0, 'stored stage 0 first');
  assert.equal(r.ratings.at(-1), 1000);
});

test('card art is still rejected', () => {
  // Numbers that neither descend nor reach a zero stage.
  const r = detectLadder(column(['7', '13', '2', '44', '9', '18', '3']));
  assert.equal(r.ok, false);
});

test('too few rungs is still rejected', () => {
  const r = detectLadder(column(['Z', 'Z', 'Z']));
  assert.equal(r.ok, false);
});

/** Masteries and Tokui-Waza (CRD ~L67-84). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeckList } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { checkTokuiWaza, styleOf, TOKUI_WAZA_PUR_BONUS } from './mastery.js';
import { validateDeck } from './decks.js';
import { createGame } from './setup.js';
import { powerUp } from './turn.js';

const card = (id: string, name: string, type: string, style: string | null): EngineCard => ({
  id,
  number: null,
  name,
  style,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: 'metadata' },
});

const personality = (id: string, level: number, pur: number): EngineCard => ({
  id,
  number: null,
  name: `Goku Lv${level}`,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: {
      level,
      personalityName: 'Goku',
      alignment: 'Hero',
      powerRatings: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
      zeroStageIndex: 0,
      pur: 2,
      canBeAlly: false,
    },
  },
});

const db = new CardDb([
  card('m-red', 'Red Style Mastery', 'Mastery', 'Red'),
  card('m-blue', 'Blue Style Mastery', 'Mastery', 'Blue'),
  card('m-free', 'Freestyle Mastery', 'Mastery', null),
  card('red1', 'Red Punch', 'Physical Combat', 'Red'),
  card('red2', 'Red Kick', 'Physical Combat', 'Red'),
  card('blue1', 'Blue Block', 'Combat', 'Blue'),
  card('none1', 'Plain Card', 'Non-Combat', null),
  card('none2', 'Other Plain', 'Non-Combat', null),
  ...[1, 2, 3].map((lv) => personality(`goku${lv}`, lv, 2)),
]);

const fill = (ids: string[], qty = 3) => ids.map((cardId) => ({ cardId, qty }));

test('styleOf only recognises Martial Arts styles', () => {
  assert.equal(styleOf(db.get('m-red')), 'Red');
  assert.equal(styleOf(db.get('none1')), null);
});

test('a matching-style deck declares a legal Tokui-Waza', () => {
  const r = checkTokuiWaza('m-red', ['red1', 'red2', 'none1'], db);
  assert.deepEqual(r.errors, []);
  assert.equal(r.style, 'Red');
});

test('an off-style card breaks the declaration', () => {
  const r = checkTokuiWaza('m-red', ['red1', 'blue1'], db);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /Blue Style but your Mastery is Red/);
});

test('a Tokui-Waza needs at least one Styled card besides the Mastery', () => {
  const r = checkTokuiWaza('m-red', ['none1', 'none2'], db);
  assert.match(r.errors[0] ?? '', /at least one Martial Arts Styled card/);
});

test('a Freestyle Tokui-Waza allows NO styled cards', () => {
  assert.deepEqual(checkTokuiWaza('m-free', ['none1', 'none2'], db).errors, []);
  const bad = checkTokuiWaza('m-free', ['none1', 'red1'], db);
  assert.match(bad.errors[0] ?? '', /Freestyle Tokui-Waza allows no Styled cards/);
});

test('a non-Mastery card cannot be the Mastery', () => {
  assert.match(checkTokuiWaza('red1', ['red2'], db).errors[0] ?? '', /is not a Mastery card/);
});

test('deck validation rejects an illegal Tokui-Waza', () => {
  const deck: DeckList = {
    name: 'Mixed',
    mpLevels: ['goku1', 'goku2', 'goku3'],
    masteryId: 'm-red',
    life: [...fill(['red1', 'red2']), { cardId: 'blue1', qty: 3 }, { cardId: 'none1', qty: 3 }],
  };
  const errors = validateDeck(deck, db, { enforceSize: false });
  assert.ok(errors.some((e) => /Blue Style but your Mastery is Red/.test(e)), errors.join('; '));
});

test('setup puts the Mastery in play and declares the Tokui-Waza', () => {
  const deck: DeckList = {
    name: 'Red',
    mpLevels: ['goku1', 'goku2', 'goku3'],
    masteryId: 'm-red',
    life: [...fill(['red1', 'red2', 'none1'])],
  };
  const state = createGame({ seed: 5, players: [{ name: 'A', deck }, { name: 'B', deck }] }, db);
  const p = state.players[0]!;
  assert.equal(p.tokuiWazaDeclared, true);
  assert.equal(p.tokuiWaza, 'Red');
  assert.ok(
    p.zones.inPlay.some((c) => c.cardId === 'm-red'),
    'the Mastery starts on the table',
  );
});

test('a declared Tokui-Waza grants +1 PUR on power-up', () => {
  const base: DeckList = {
    name: 'Plain',
    mpLevels: ['goku1', 'goku2', 'goku3'],
    life: [...fill(['none1', 'none2'])],
  };
  const withMastery: DeckList = { ...base, masteryId: 'm-red', life: [...fill(['red1', 'red2', 'none1'])] };

  const plain = createGame({ seed: 5, players: [{ name: 'A', deck: base }, { name: 'B', deck: base }] }, db);
  const tokui = createGame({ seed: 5, players: [{ name: 'A', deck: withMastery }, { name: 'B', deck: withMastery }] }, db);

  const before = plain.players[0]!.mp.stageIndex;
  powerUp(plain, 0, db, []);
  const plainGain = plain.players[0]!.mp.stageIndex - before;

  const beforeT = tokui.players[0]!.mp.stageIndex;
  powerUp(tokui, 0, db, []);
  const tokuiGain = tokui.players[0]!.mp.stageIndex - beforeT;

  assert.equal(plainGain, 2, 'base PUR 2');
  assert.equal(tokuiGain, 2 + TOKUI_WAZA_PUR_BONUS, 'Tokui-Waza adds +1 PUR');
});

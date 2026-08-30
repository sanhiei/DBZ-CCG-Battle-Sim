/**
 * Anger has to go somewhere.
 *
 * Two CRD conformance defects. At the highest personality level there is
 * nowhere to advance to, and anger simply PARKED above the threshold: it sat
 * at 5+ forever, so every later anger card re-triggered the advance branch and
 * did nothing. And only the explicit `setAnger` action reported an anger
 * advance to the victory check, so reaching the highest level via a card
 * effect — which is how it actually happens — never won the game.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { reduce } from './reducer.js';
import { ANGER_TO_ADVANCE, setAnger } from './turn.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const person = (id: string, level: number): EngineCard => ({
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
    personality: { level, personalityName: 'Goku', alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 2, canBeAlly: false },
  },
});
const db = new CardDb([person('g1', 1), person('g2', 2)]);

/** `levels` is how many level cards the MP has; currentLevel starts at 1. */
function stateWith(levels: string[], stageIndex = 2): GameState {
  const player = (idx: number): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: 'Goku',
      alignment: 'Hero',
      levelCardIds: idx === 0 ? levels : ['g1'],
      currentLevel: 1,
      stageIndex,
      currentRating: LADDER[stageIndex]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: Array.from({ length: 10 }, (_, i) => ({ uid: `d${idx}-${i}`, cardId: 'g1', faceDown: true }) as CardInstance), hand: [], discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'nonCombat',
    players: [player(0), player(1)],
    log: [],
  };
}

test('reaching 5 anger below the top level advances and resets anger', () => {
  const s = stateWith(['g1', 'g2']);
  setAnger(s, 'mp0', ANGER_TO_ADVANCE, db, []);
  assert.equal(s.players[0]!.mp.currentLevel, 2);
  assert.equal(s.players[0]!.mp.anger, 0, 'anger resets on advancing');
});

test('at the highest level, 5 anger resets and raises to the highest power stage', () => {
  // CRD ~L529: "If you are at your highest personality level and you have 5 or
  // more anger, raise your MP to your highest power stage and set your anger
  // to 0."
  const s = stateWith(['g1'], 2);
  setAnger(s, 'mp0', ANGER_TO_ADVANCE, db, []);
  const mp = s.players[0]!.mp;
  assert.equal(mp.currentLevel, 1, 'there is nowhere to advance to');
  assert.equal(mp.anger, 0, 'anger does not park above the threshold');
  assert.equal(mp.stageIndex, LADDER.length - 1, 'raised to the highest power stage');
  assert.equal(mp.currentRating, 500);
});

test('anger does not stay stuck over the threshold', () => {
  // The real damage of parking: anger stayed >= 5, so the next anger card
  // re-entered the advance branch and silently did nothing.
  const s = stateWith(['g1'], 2);
  setAnger(s, 'mp0', 7, db, []);
  assert.equal(s.players[0]!.mp.anger, 0);
  setAnger(s, 'mp0', 1, db, []);
  assert.equal(s.players[0]!.mp.anger, 1, 'anger counts up again from a clean base');
});

test('an anger advance from a CARD effect reaches the victory check', () => {
  // Only the explicit setAnger action used to report this, so an MP pushed to
  // the highest level by a card effect never won.
  const s = stateWith(['g1', 'g2']);
  s.players[1]!.mp.levelCardIds = ['g1', 'g2']; // same ceiling for both seats
  const r = reduce(s, { type: 'setAnger', personalityUid: 'mp0', anger: ANGER_TO_ADVANCE }, db, 0);
  const advanced = r.events.find((e) => e.type === 'personalityAdvanced');
  assert.ok(advanced, 'the advance happened');
  assert.equal(advanced.type === 'personalityAdvanced' ? advanced.byAnger : undefined, true, 'and is marked as by anger');
});

test('an advance NOT caused by anger is not marked as one', () => {
  // CRD ~L171 only grants the Most Powerful victory to a level reached BY
  // anger, so the flag has to distinguish them.
  const s = stateWith(['g1', 'g2']);
  const r = reduce(s, { type: 'setAnger', personalityUid: 'mp0', anger: 1 }, db, 0);
  assert.equal(r.events.some((e) => e.type === 'personalityAdvanced'), false);
});

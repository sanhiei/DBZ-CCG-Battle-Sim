/**
 * The turn is a sequence both players get to take part in.
 *
 * Two conformance defects from the CRD audit. The Draw Step drew 1 card where
 * the CRD says 3 and never fired at all on turn 1, so hands were starved by
 * two thirds; and `advanceStep` was unguarded during Combat, so the attacker
 * could walk out of the Combat Step and the defender never got the Attack
 * Phase the rules guarantee them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { reduce } from './reducer.js';
import { DRAW_PER_TURN } from './turn.js';
import { beginCombat, declareAttack } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const filler: EngineCard = {
  id: 'filler',
  number: null,
  name: 'Filler',
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type: 'Physical Combat', coverage: 'metadata' },
};
const mpCard: EngineCard = {
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
};
const db = new CardDb([filler, mpCard]);

let uid = 0;
const inst = (): CardInstance => ({ uid: `u${uid++}`, cardId: 'filler', faceDown: false });

function stateAt(step: GameState['step']): GameState {
  const player = (idx: number): GameState['players'][number] => ({
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
      stageIndex: 4,
      currentRating: 400,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: Array.from({ length: 30 }, inst), hand: [], discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step,
    players: [player(0), player(1)],
    log: [],
  };
}

/* ---------- the Draw Step ---------- */

test('the Draw Step draws 3, not 1', () => {
  // CRD ~L215: "If you are the Attacker, draw 3 cards from the top of your
  // Life Deck and put them in your hand."
  assert.equal(DRAW_PER_TURN, 3);
  const s = stateAt('rejuvenation'); // one advance wraps the turn into 'draw'
  const r = reduce(s, { type: 'advanceStep' }, db);
  assert.equal(r.state.step, 'draw');
  assert.equal(r.state.players[r.state.activePlayerIdx]!.zones.hand.length, 3);
});

/* ---------- the Combat Step is not a door the attacker can walk out of ---------- */

test('the attacker cannot advance out of an active Combat Step', () => {
  const s = stateAt('combat');
  beginCombat(s, db, []);
  const r = reduce(s, { type: 'advanceStep' }, db, 0);
  assert.match(r.error ?? '', /finish the Combat Step/);
  assert.equal(r.state.step, 'combat', 'still in combat');
  assert.ok(r.state.combat, 'and the combat is still there');
});

test('an attack in progress cannot be abandoned by advancing', () => {
  const s = stateAt('combat');
  beginCombat(s, db, []);
  declareAttack(s, 'physical', undefined, { actingPlayerIdx: 0 }, db, []);
  const r = reduce(s, { type: 'advanceStep' }, db, 0);
  assert.ok(r.error, 'refused');
  assert.ok(r.state.combat?.currentAttack, 'the attack still stands');
});

test('advancing works normally when no combat is in progress', () => {
  // The guard keys on state.combat, not on the step name, so the real exit
  // (endCombatStep deletes state.combat first) is unaffected.
  const s = stateAt('combat');
  delete s.combat;
  const r = reduce(s, { type: 'advanceStep' }, db, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.state.step, 'discard');
});

test('every other step still advances', () => {
  for (const step of ['draw', 'nonCombat', 'powerUp', 'declare'] as const) {
    const r = reduce(stateAt(step), { type: 'advanceStep' }, db, 0);
    assert.equal(r.error, undefined, `${step} should advance`);
  }
});

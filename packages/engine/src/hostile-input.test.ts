/**
 * The engine is fed by a socket, so every action is hostile until proven
 * otherwise — and one of these is not hostile at all, just a double-click.
 *
 * A re-audit found the reducer trusting the shape of its own actions: a
 * non-integer stage, an unbounded draw, a capture with no entitlement, an
 * answer to a question the player had not been asked, and an automatic
 * power-up that forgot to claim its own once-per-turn flag.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { reduce } from './reducer.js';

const LADDER = [0, 100, 200, 300, 400, 500];



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
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 2, canBeAlly: false },
  },
};

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

const db = new CardDb([mpCard, filler]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function state(opts: { step?: GameState['step']; stageIndex?: number } = {}): GameState {
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
      stageIndex: opts.stageIndex ?? 1,
      currentRating: LADDER[opts.stageIndex ?? 1]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: Array.from({ length: 20 }, () => inst('filler')),
      hand: [inst('filler')],
      discard: [],
      inPlay: [],
      removed: [],
      sensei: [],
    },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: opts.step ?? 'nonCombat',
    players: [player(0), player(1)],
    log: [],
  };
}

/* ---------- the Power-Up Step happens once ---------- */

test('entering the Power-Up Step claims the once-per-turn flag', () => {
  // The automatic power-up did not set poweredUpThisTurn, so the guard on the
  // manual action let a second one through and every MP climbed at 2x its PUR.
  const s = state({ step: 'nonCombat', stageIndex: 1 });
  const entered = reduce(s, { type: 'advanceStep' }, db, 0);
  assert.equal(entered.state.step, 'powerUp');
  assert.equal(entered.state.players[0]!.mp.stageIndex, 3, 'PUR 2 lifts 1 -> 3');
  assert.equal(entered.state.poweredUpThisTurn, true);

  const again = reduce(entered.state, { type: 'powerUp', playerIdx: 0 }, db, 0);
  assert.match(again.error ?? '', /already powered up/);
  assert.equal(again.state.players[0]!.mp.stageIndex, 3, 'still 3, not 5');
});

test('the flag clears when the turn wraps, so next turn powers up again', () => {
  // Straight at the wrap rather than walking the whole turn: leaving the
  // Combat Step needs an attack resolved, which is a different test's problem.
  const s = state({ step: 'rejuvenation', stageIndex: 1 });
  s.poweredUpThisTurn = true;
  const wrapped = reduce(s, { type: 'advanceStep' }, db, 0);
  assert.equal(wrapped.state.step, 'draw');
  assert.equal(wrapped.state.activePlayerIdx, 1, 'turn passed');
  assert.equal(wrapped.state.poweredUpThisTurn, undefined, 'flag cleared for the new turn');
});

/* ---------- you answer the question you were shown ---------- */

test('an answer carrying a stale promptId is refused', () => {
  // resolveDefense can close one prompt and open the next for the same player
  // in a single action, so a double-clicked button sent its second answer into
  // a question the player had not read — silently spending their Endurance.
  const s = state({ step: 'combat' });
  s.pendingPrompt = { id: 'p7', playerIdx: 1, type: 'endurance', message: 'use Endurance?' };
  const r = reduce(s, { type: 'answerPrompt', promptId: 'p6', choice: true }, db, 1);
  assert.match(r.error ?? '', /already been answered/);
  assert.deepEqual(r.state.pendingPrompt, s.pendingPrompt, 'prompt still open');
});

test('an answer carrying the current promptId is let through', () => {
  const s = state({ step: 'combat' });
  s.pendingPrompt = { id: 'p7', playerIdx: 1, type: 'endurance', message: 'use Endurance?' };
  const r = reduce(s, { type: 'answerPrompt', promptId: 'p7', choice: false }, db, 1);
  // It reaches the resolver (which fails for its own reasons in this fixture);
  // what matters is that the promptId gate did not reject it.
  assert.doesNotMatch(r.error ?? '', /already been answered/);
});

/* ---------- draws are bounded, and yours ---------- */

test('you cannot draw an unbounded number of cards', () => {
  const s = state({ step: 'draw' });
  const r = reduce(s, { type: 'drawCards', playerIdx: 0, count: 20 }, db, 0);
  assert.match(r.error ?? '', /1 to 3 cards/);
  assert.equal(r.state.players[0]!.zones.hand.length, 1, 'hand unchanged');
});

test('you cannot draw on the opponent turn', () => {
  const s = state({ step: 'draw' });
  const r = reduce(s, { type: 'drawCards', playerIdx: 1, count: 1 }, db, 1);
  assert.match(r.error ?? '', /your own turn/);
});

test('an ordinary draw still works', () => {
  const s = state({ step: 'draw' });
  const r = reduce(s, { type: 'drawCards', playerIdx: 0, count: 3 }, db, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.state.players[0]!.zones.hand.length, 4);
});

/* ---------- a stage is a whole number ---------- */

test('a non-numeric stage cannot poison the PAT', () => {
  // Math.min('x', n) is NaN, and NaN stuck: currentRating went undefined and
  // `stageIndex > MP_DOWN_STAGES` was false forever after.
  const s = state();
  const r = reduce(s, { type: 'setStage', personalityUid: 'mp0', stageIndex: 'x' as unknown as number }, db, 0);
  assert.match(r.error ?? '', /whole number/);
  assert.equal(r.state.players[0]!.mp.stageIndex, 1);
  assert.equal(typeof r.state.players[0]!.mp.currentRating, 'number');
});

/* ---------- capture needs the entitlement ---------- */

test('a Dragon Ball cannot be captured without a capture prompt', () => {
  // The action checked only that an attack was in progress and that the caller
  // was the attacker — and cleared pendingPrompt on the way out, cancelling
  // whatever the defender was answering.
  const s = state({ step: 'combat' });
  s.combat = {
    attackerPlayerIdx: 0,
    defenderPlayerIdx: 1,
    currentAttack: {
      attackerPlayerIdx: 0,
      defenderPlayerIdx: 1,
      attackType: 'physical',
      attackerControllerUid: 'mp0',
      defenderControllerUid: 'mp1',
    },
  } as unknown as NonNullable<GameState['combat']>;
  s.pendingPrompt = { id: 'p1', playerIdx: 1, type: 'defend', message: 'defend?' };
  const r = reduce(s, { type: 'captureDragonBall', ballUid: 'anything' }, db, 0);
  assert.match(r.error ?? '', /not captured a Dragon Ball/);
  assert.equal(r.state.pendingPrompt?.id, 'p1', "the defender's prompt survives");
});

/* ---------- the log ships to both clients on every action ---------- */

test('chat text is capped and the log does not grow forever', () => {
  let s = state();
  s = reduce(s, { type: 'chat', playerIdx: 0, text: 'x'.repeat(5000) }, db, 0).state;
  const line = s.log[s.log.length - 1]!;
  assert.ok(line.length < 600, `chat line was ${line.length} chars`);

  for (let i = 0; i < 700; i++) {
    s = reduce(s, { type: 'chat', playerIdx: 0, text: `m${i}` }, db, 0).state;
  }
  assert.ok(s.log.length <= 500, `log grew to ${s.log.length}`);
  assert.match(s.log[s.log.length - 1]!, /m699/, 'newest lines kept');
});

test('an empty chat message is dropped', () => {
  const s = state();
  const r = reduce(s, { type: 'chat', playerIdx: 0, text: '   ' }, db, 0);
  assert.equal(r.state.log.length, 0);
});

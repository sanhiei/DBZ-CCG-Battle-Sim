/**
 * Declare, Discard and Rejuvenation — the three steps that were named in STEPS
 * and did nothing.
 *
 * The last test in this file is the one that matters: over several turns, a
 * hand stops growing. Everything else in the engine was being judged against a
 * game where both players held every card they had ever drawn.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action, CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { reduce } from './reducer.js';
import { HAND_LIMIT } from './turnsteps.js';

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
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 1, canBeAlly: false },
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
const inst = (): CardInstance => ({ uid: `u${uid++}`, cardId: 'filler', faceDown: false });

function state(opts: { step?: GameState['step']; hands?: [number, number]; discard?: number } = {}): GameState {
  const hands = opts.hands ?? [0, 0];
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
      currentRating: LADDER[4]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: Array.from({ length: 30 }, inst),
      hand: Array.from({ length: hands[idx] ?? 0 }, inst),
      discard: Array.from({ length: idx === 0 ? (opts.discard ?? 0) : 0 }, inst),
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
    step: opts.step ?? 'powerUp',
    players: [player(0), player(1)],
    log: [],
  };
}

const act = (s: GameState, a: Action, who = 0) => reduce(s, a, db, who);
const step = (s: GameState, who = 0) => act(s, { type: 'advanceStep' }, who);

/* ------------------------------------------------------------- Declare */

test('the Declare Step asks the attacker a question', () => {
  const r = step(state({ step: 'powerUp' }));
  assert.equal(r.state.step, 'declare');
  assert.equal(r.state.pendingPrompt?.type, 'declareCombat');
  assert.equal(r.state.pendingPrompt?.playerIdx, 0);
});

test('declaring Combat enters the Combat Step', () => {
  let s = step(state({ step: 'powerUp' })).state;
  const r = act(s, { type: 'declareCombat', declare: true });
  assert.equal(r.error, undefined);
  assert.equal(r.state.step, 'combat');
  assert.equal(r.state.declaredCombat, true);
  assert.ok(r.state.combat, 'Combat actually began');
});

test('declining Combat goes straight to the Discard Step', () => {
  // CRD ~L233: "If you choose not to declare Combat skip the Combat Step and
  // go to the Discard Step." The attacker was previously marched into Combat
  // every single turn with no way to say no.
  const s = step(state({ step: 'powerUp' })).state;
  const r = act(s, { type: 'declareCombat', declare: false });
  assert.equal(r.error, undefined);
  assert.equal(r.state.step, 'discard');
  assert.equal(r.state.declaredCombat, false);
  assert.equal(r.state.combat, undefined, 'no Combat began');
});

test('only the attacker declares Combat', () => {
  const s = step(state({ step: 'powerUp' })).state;
  const r = act(s, { type: 'declareCombat', declare: true }, 1);
  assert.match(r.error ?? '', /only the attacker/);
});

test('a Location played this turn takes the decision away', () => {
  // ~L233/~L713: playing a Battleground or Location costs you the Combat Step,
  // so there is no question to ask and no way to answer it with "yes".
  const base = state({ step: 'powerUp' });
  base.skipCombatThisTurn = true;
  const s = step(base).state;
  assert.equal(s.step, 'declare');
  assert.equal(s.pendingPrompt, undefined, 'nothing to ask');
  assert.equal(s.declaredCombat, false);

  const forced = act(s, { type: 'declareCombat', declare: true });
  assert.match(forced.error ?? '', /costs you the Combat Step/);

  assert.equal(step(s).state.step, 'discard', 'advancing skips Combat');
});

/* ------------------------------------------------------------- Discard */

test('the Discard Step trims the attacker, then the opponent', () => {
  // ~L240: "place all but 1 of your cards into the discard pile ... Your
  // opponent does the same, right after you discard."
  const s = state({ step: 'declare', hands: [5, 4] });
  s.declaredCombat = false;
  const entered = step(s).state;
  assert.equal(entered.step, 'discard');
  assert.equal(entered.pendingPrompt?.playerIdx, 0, 'attacker first');

  const keep = entered.players[0]!.zones.hand[2]!.uid;
  const afterAtk = act(entered, { type: 'answerPrompt', promptId: entered.pendingPrompt!.id, choice: keep }).state;
  assert.equal(afterAtk.players[0]!.zones.hand.length, HAND_LIMIT);
  assert.equal(afterAtk.players[0]!.zones.hand[0]!.uid, keep, 'kept the card they chose');
  assert.equal(afterAtk.players[0]!.zones.discard.length, 4);

  assert.equal(afterAtk.pendingPrompt?.playerIdx, 1, 'opponent goes right after');
  const keep2 = afterAtk.players[1]!.zones.hand[0]!.uid;
  const done = act(afterAtk, { type: 'answerPrompt', promptId: afterAtk.pendingPrompt!.id, choice: keep2 }, 1).state;
  assert.equal(done.players[1]!.zones.hand.length, HAND_LIMIT);
  assert.equal(done.pendingPrompt, undefined, 'both have discarded');
});

test('you may discard your whole hand', () => {
  // ~L240: "You may discard all of your cards if you want".
  const s = state({ step: 'declare', hands: [4, 0] });
  s.declaredCombat = false;
  const entered = step(s).state;
  const r = act(entered, { type: 'answerPrompt', promptId: entered.pendingPrompt!.id, choice: null });
  assert.equal(r.error, undefined);
  assert.equal(r.state.players[0]!.zones.hand.length, 0);
  assert.equal(r.state.players[0]!.zones.discard.length, 4);
});

test('you cannot keep a card that is not in your hand', () => {
  const s = state({ step: 'declare', hands: [3, 0] });
  s.declaredCombat = false;
  const entered = step(s).state;
  const r = act(entered, { type: 'answerPrompt', promptId: entered.pendingPrompt!.id, choice: 'not-a-card' });
  assert.match(r.error ?? '', /not in your hand/);
  assert.equal(r.state.players[0]!.zones.hand.length, 3, 'nothing discarded');
});

test('a player already at the limit is not asked', () => {
  const s = state({ step: 'declare', hands: [1, 0] });
  s.declaredCombat = false;
  const entered = step(s).state;
  assert.equal(entered.step, 'discard');
  assert.equal(entered.pendingPrompt, undefined, 'nobody owes a discard');
});

test('the step cannot be walked past while a discard is owed', () => {
  // Without this the hand limit is advisory: the attacker just steps over it.
  const s = state({ step: 'declare', hands: [5, 0] });
  s.declaredCombat = false;
  const entered = step(s).state;
  const r = step(entered);
  assert.match(r.error ?? '', /answer the pending prompt/);
  assert.equal(r.state.step, 'discard', 'still owing');
});

/* -------------------------------------------------------- Rejuvenation */

test('skipping Combat earns the top discard card back', () => {
  // ~L245. This is the entire payoff for declining Combat; without it the
  // Declare Step would be a decision between "play" and "lose tempo".
  const s = state({ step: 'discard', discard: 3 });
  s.declaredCombat = false;
  const entered = step(s).state;
  assert.equal(entered.step, 'rejuvenation');
  assert.equal(entered.pendingPrompt?.type, 'rejuvenate');

  const top = entered.players[0]!.zones.discard[2]!.uid;
  const deckBefore = entered.players[0]!.zones.lifeDeck.length;
  const r = act(entered, { type: 'answerPrompt', promptId: entered.pendingPrompt!.id, choice: true });
  assert.equal(r.error, undefined);
  assert.equal(r.state.players[0]!.zones.discard.length, 2);
  assert.equal(r.state.players[0]!.zones.lifeDeck.length, deckBefore + 1);
  const deck = r.state.players[0]!.zones.lifeDeck;
  assert.equal(deck[deck.length - 1]!.uid, top, 'the top discard went to the BOTTOM of the deck');
  assert.equal(deck[deck.length - 1]!.faceDown, true, 'placed facedown');
});

test('rejuvenation is optional', () => {
  const s = state({ step: 'discard', discard: 2 });
  s.declaredCombat = false;
  const entered = step(s).state;
  const r = act(entered, { type: 'answerPrompt', promptId: entered.pendingPrompt!.id, choice: false });
  assert.equal(r.error, undefined);
  assert.equal(r.state.players[0]!.zones.discard.length, 2, 'discard untouched');
  assert.equal(r.state.pendingPrompt, undefined);
});

test('an attacker who fought gets no card back', () => {
  const s = state({ step: 'discard', discard: 3 });
  s.declaredCombat = true;
  const entered = step(s).state;
  assert.equal(entered.step, 'rejuvenation');
  assert.equal(entered.pendingPrompt, undefined, 'no offer — you declared Combat');
});

test('an empty discard pile has nothing to give back', () => {
  const s = state({ step: 'discard', discard: 0 });
  s.declaredCombat = false;
  assert.equal(step(s).state.pendingPrompt, undefined);
});

/* ------------------------------------------------------- the whole loop */

test('over several turns a hand stops growing', () => {
  // The point of the bundle. Both players drew 3 a turn and discarded nothing,
  // so a defender always held an answer and combat could never be judged.
  let s = state({ step: 'powerUp', hands: [6, 6] });
  for (let turn = 0; turn < 4; turn++) {
    for (let guard = 0; guard < 20; guard++) {
      const p = s.pendingPrompt;
      if (p) {
        const choice =
          p.type === 'declareCombat' ? false : p.type === 'discard' ? null : false;
        s = act(s, { type: 'answerPrompt', promptId: p.id, choice }, p.playerIdx).state;
        continue;
      }
      const before = s.turnNumber;
      s = step(s, s.activePlayerIdx).state;
      if (s.turnNumber !== before) break;
    }
    for (const player of s.players) {
      assert.ok(
        player.zones.hand.length <= HAND_LIMIT + 3,
        `turn ${turn}: ${player.name} holds ${player.zones.hand.length} cards`,
      );
    }
  }
  // Four turns of drawing 3 with no limit would be 6 + 12 = 18 in the
  // attacker's hand alone.
  assert.ok(s.players[0]!.zones.hand.length <= HAND_LIMIT + 3);
  assert.ok(s.players[1]!.zones.hand.length <= HAND_LIMIT + 3);
});

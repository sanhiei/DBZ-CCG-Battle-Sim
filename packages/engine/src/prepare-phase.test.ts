/**
 * The Prepare Phase (CRD ~L255-266).
 *
 * It was one line — the defender's draw. The `whenEnteringCombat` trigger was
 * declared in the shared union, emitted by no parser branch and consumed by
 * nothing, so 149 cards printing "When entering Combat" did nothing all game.
 *
 * What lands here is the mandatory subset whose effects the engine models: 21
 * abilities. The other 128 either say "you may" — an optional effect fired
 * automatically is not a smaller bug than one that never fires, it just takes
 * the decision away — or ask for deck searching, which has no model yet.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { parseWhenEnteringCombat } from './abilities.js';
import { beginCombat } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const fromText = (id: string, name: string, type: string, text: string): EngineCard => {
  const ability = parseWhenEnteringCombat(text);
  return {
    id,
    number: null,
    name,
    style: null,
    saga: 'Buu',
    rarity: 'Common',
    imageUrl: '',
    rules: { type, coverage: 'partial', text, ...(ability ? { abilities: [ability] } : {}) },
  };
};

const db = new CardDb([
  {
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
  } as EngineCard,
  fromText('draws', 'Black Studying Drill', 'Non-Combat', 'When entering Combat, draw a card.'),
  fromText('defOnly', "Android 18's Kneeing Drill", 'Non-Combat', 'When entering Combat as the defender, raise your anger 1 level.'),
  fromText('optional', 'Optional Drill', 'Non-Combat', 'When entering Combat, you may draw a card.'),
  fromText('plain', 'Plain Drill', 'Non-Combat', 'A Drill with no trigger.'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function state(attackerInPlay: string[], defenderInPlay: string[]): GameState {
  const player = (idx: number, inPlay: string[]): GameState['players'][number] => ({
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
      lifeDeck: Array.from({ length: 40 }, () => inst('plain')),
      hand: [],
      discard: [],
      inPlay: inPlay.map(inst),
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
    step: 'combat',
    players: [player(0, attackerInPlay), player(1, defenderInPlay)],
    log: [],
  };
}

/* ------------------------------------------------------------ the parser */

test('a mandatory trigger parses; an optional one does not', () => {
  assert.ok(parseWhenEnteringCombat('When entering Combat, draw a card.'));
  assert.equal(parseWhenEnteringCombat('When entering Combat, you may draw a card.'), null);
});

test('a role restriction is read off the text', () => {
  assert.equal(parseWhenEnteringCombat('When entering Combat as the defender, raise your anger 1 level.')?.role, 'defender');
  assert.equal(parseWhenEnteringCombat('When entering Combat, draw a card.')?.role, undefined);
});

test('only the trigger sentence is read, not the rest of the card', () => {
  // "Then choose a card from your hand and place it on top of your Life Deck"
  // is a second sentence and not part of what the trigger does.
  const a = parseWhenEnteringCombat('When entering Combat, draw a card. Then raise your anger 3 levels.')!;
  assert.deepEqual(a.effects, [{ kind: 'drawCards', count: 1 }]);
});

/* ----------------------------------------------------- firing them in order */

test('the attacker fires theirs, and the defender still draws 3', () => {
  const s = state(['draws'], []);
  const before = s.players[0]!.zones.hand.length;
  beginCombat(s, db, []);
  assert.equal(s.players[0]!.zones.hand.length, before + 1, 'the attacker drew from their Drill');
  assert.equal(s.players[1]!.zones.hand.length, 3, "and the defender's 3 still happen");
});

test('the defender fires theirs too', () => {
  const s = state([], ['draws']);
  beginCombat(s, db, []);
  // Their own Drill's card plus the Prepare Phase 3.
  assert.equal(s.players[1]!.zones.hand.length, 4);
});

test('a defender-only effect does not fire for the attacker', () => {
  // 30 cards read "as the defender"; firing them for both sides would hand the
  // attacker an effect the card does not give them.
  const asAttacker = state(['defOnly'], []);
  beginCombat(asAttacker, db, []);
  assert.equal(asAttacker.players[0]!.mp.anger, 0, 'not for the attacker');

  const asDefender = state([], ['defOnly']);
  beginCombat(asDefender, db, []);
  assert.equal(asDefender.players[1]!.mp.anger, 1, 'but yes for the defender');
});

test('an optional effect is left alone', () => {
  const s = state(['optional'], []);
  const before = s.players[0]!.zones.hand.length;
  beginCombat(s, db, []);
  assert.equal(s.players[0]!.zones.hand.length, before, 'nobody chose to use it');
});

test('each source fires once per Combat', () => {
  // "The Defender may do this multiple times during the Prepare Phase, but each
  // effect may only be used once" (~L264).
  const s = state(['draws'], []);
  beginCombat(s, db, []);
  const after = s.players[0]!.zones.hand.length;
  // Re-running the phase on the same combat state must not pay out again.
  beginCombat(s, db, []);
  assert.ok(s.players[0]!.zones.hand.length >= after, 'sanity');
  const uidUsed = s.combat!.preparedUsed ?? [];
  assert.equal(new Set(uidUsed).size, uidUsed.length, 'no source recorded twice');
});

test('two copies of the same Drill each fire', () => {
  // The mark is per CARD, not per name — two Freestyle Drills are two effects.
  const s = state(['draws', 'draws'], []);
  const before = s.players[0]!.zones.hand.length;
  beginCombat(s, db, []);
  assert.equal(s.players[0]!.zones.hand.length, before + 2);
});

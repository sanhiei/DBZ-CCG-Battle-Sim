/**
 * Non-Combat cards actually doing what they say when played.
 *
 * playCard used to put the card in play, log it, and stop there — no effect of
 * any kind was executed, for any effect kind. 114 Non-Combat cards carry a
 * parsed on-play ability, so every one of them sat on the table doing nothing
 * while the catalog reported it as modelled.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ability, CardInstance, GameEvent, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { playCard } from './noncombat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const personality: EngineCard = {
  id: 'goku1',
  number: null,
  name: 'Goku Lv1',
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: {
      level: 1,
      personalityName: 'Goku',
      alignment: 'Hero',
      powerRatings: LADDER,
      zeroStageIndex: 0,
      pur: 2,
      canBeAlly: false,
    },
  },
};

const nonCombat = (id: string, name: string, ability?: Ability, type = 'Non-Combat'): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: ability ? 'partial' : 'metadata', ...(ability ? { abilities: [ability] } : {}) },
});

const onPlay = (...effects: Ability['effects']): Ability => ({ trigger: 'onPlay', effects, source: 'parsed' });

const db = new CardDb([
  personality,
  // A Hospital Stay: raise to the top of the ladder, +1 anger, then gone.
  nonCombat(
    'hospital',
    'A Hospital Stay',
    onPlay(
      { kind: 'movePowerStage', target: 'user', to: 'highest' },
      { kind: 'changeAnger', target: 'user', delta: 1 },
      { kind: 'removeFromGameAfterUse' },
    ),
  ),
  // Rejuvenates, and says nothing about removal — so it is discarded after use.
  nonCombat('rejuv', 'Cell Juice', onPlay({ kind: 'rejuvenate', count: 2, from: 'bottom' })),
  // Aims at the opponent.
  nonCombat('taunt', 'A Taunt', onPlay({ kind: 'changeAnger', target: 'foe', delta: -2 })),
  // An effect the executor cannot perform yet.
  nonCombat('odd', 'Odd Card', onPlay({ kind: 'stopAttack', attackType: 'any', window: 'thisAttack' })),
  // No parsed ability at all.
  nonCombat('plain', 'Plain Card'),
  // A Drill is continuous: it stays in play and is not resolved on entry.
  nonCombat('drill', 'Red Anger Drill', { trigger: 'constant', effects: [{ kind: 'changeAnger', target: 'user', delta: 3 }] }, 'Drill'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function state(handIds: string[], discardIds: string[] = []): GameState {
  const mk = (idx: number, hand: CardInstance[], discard: CardInstance[]): GameState['players'][number] => ({
    idx,
    name: `P${idx}`,
    connected: true,
    alignment: 'Hero',
    mp: {
      uid: `mp${idx}`,
      personalityName: 'Goku',
      alignment: 'Hero',
      levelCardIds: ['goku1'],
      currentLevel: 1,
      stageIndex: 2,
      currentRating: 200,
      anger: 2,
      isAlly: false,
    },
    allies: [],
    zones: {
      lifeDeck: [inst('plain'), inst('plain'), inst('plain')],
      hand,
      discard,
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
    step: 'nonCombat',
    players: [mk(0, handIds.map(inst), discardIds.map(inst)), mk(1, [], [])],
    log: [],
  };
}

const play = (s: GameState, uidToPlay: string, events: GameEvent[] = []) => playCard(s, 0, uidToPlay, db, events);

test('an on-play ability is resolved when the card is played', () => {
  const s = state(['hospital']);
  const card = s.players[0]!.zones.hand[0]!;
  assert.equal(play(s, card.uid), undefined, 'the play is legal');

  const mp = s.players[0]!.mp;
  assert.equal(mp.stageIndex, LADDER.length - 1, 'raised to its highest power stage');
  assert.equal(mp.currentRating, 500, 'and the rating follows');
  assert.equal(mp.anger, 3, 'anger went up by one');
});

test('a card that removes itself after use ends up in the removed zone', () => {
  const s = state(['hospital']);
  play(s, s.players[0]!.zones.hand[0]!.uid);
  const z = s.players[0]!.zones;
  assert.equal(z.removed.length, 1);
  assert.equal(z.inPlay.length, 0, 'a used card does not stay on the table');
  assert.equal(z.discard.length, 0);
  assert.equal(z.hand.length, 0);
});

test('a used card that says nothing about removal is discarded', () => {
  const s = state(['rejuv'], ['plain', 'plain']);
  play(s, s.players[0]!.zones.hand[0]!.uid);
  const z = s.players[0]!.zones;
  assert.equal(z.lifeDeck.length, 5, 'two cards rejuvenated to the Life Deck');
  assert.equal(z.inPlay.length, 0);
  assert.equal(z.removed.length, 0);
  assert.equal(z.discard.length, 1, 'the spent card itself');
  assert.equal(z.discard[0]!.cardId, 'rejuv');
});

test('an effect aimed at the opponent hits the opponent', () => {
  const s = state(['taunt']);
  play(s, s.players[0]!.zones.hand[0]!.uid);
  assert.equal(s.players[1]!.mp.anger, 0, "the opponent's anger dropped by 2");
  assert.equal(s.players[0]!.mp.anger, 2, 'the user is untouched');
});

test('an effect the executor cannot perform says so instead of pretending', () => {
  const s = state(['odd']);
  play(s, s.players[0]!.zones.hand[0]!.uid);
  assert.ok(
    s.log.some((l) => l.includes('not yet automated')),
    'the player is told to resolve it',
  );
  assert.equal(s.players[0]!.zones.discard.length, 1, 'the card is still spent');
});

test('a Non-Combat card with no parsed ability still just sits in play', () => {
  // Unchanged behaviour: we do not know what it does, so the player resolves it.
  const s = state(['plain']);
  play(s, s.players[0]!.zones.hand[0]!.uid);
  const z = s.players[0]!.zones;
  assert.equal(z.inPlay.length, 1);
  assert.equal(z.discard.length, 0);
});

test('a Drill stays in play and is NOT resolved on entry', () => {
  // Drills are continuous; resolving one on entry would apply it twice.
  const s = state(['drill']);
  play(s, s.players[0]!.zones.hand[0]!.uid);
  assert.equal(s.players[0]!.zones.inPlay.length, 1, 'the Drill stays on the table');
  assert.equal(s.players[0]!.mp.anger, 2, 'its constant effect did not fire on play');
});

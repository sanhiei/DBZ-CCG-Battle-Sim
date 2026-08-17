/** The Non-Combat Step: Drills, Locations, and Ally levels (CRD ~L627-716). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { discardDrills, isFreestyleDrill, maxAllyLevel, playCard } from './noncombat.js';
import { advanceStep, advanceLevel } from './turn.js';
import { reduce } from './reducer.js';

const mk = (id: string, name: string, type: string): EngineCard => ({
  id, number: null, name, style: null, saga: 'Buu', rarity: 'Common', imageUrl: '',
  rules: { type, coverage: 'metadata' },
});

const ally = (id: string, name: string, level: number): EngineCard => ({
  id, number: null, name, style: null, saga: 'Buu', rarity: 'Common', imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: {
      level, personalityName: name, alignment: 'Hero',
      powerRatings: [0, 100, 200, 300, 400], zeroStageIndex: 0, pur: 1, canBeAlly: true,
    },
  },
});

const db = new CardDb([
  mk('drill-free', 'Time Chamber Drill', 'Drill'),
  mk('drill-red', 'Red Speed Drill', 'Drill'),
  mk('nc', 'Senzu Bean', 'Non-Combat'),
  mk('loc', 'Kame House', 'Location'),
  mk('bg', 'Rocky Field', 'Battleground'),
  mk('atk', 'Punch', 'Physical Combat'),
  mk('mp1', 'Goku Lv1', 'Personality'),
  ally('ally1', 'Krillin', 1),
  ally('ally3', 'Piccolo', 3),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function makeState(hand: CardInstance[], step: GameState['step'] = 'nonCombat'): GameState {
  const player = (idx: number, h: CardInstance[]): GameState['players'][number] => ({
    idx, name: `P${idx}`, connected: true, alignment: 'Hero',
    mp: {
      uid: `mp${idx}`, personalityName: 'Goku', alignment: 'Hero',
      levelCardIds: ['mp1', 'mp1', 'mp1'], currentLevel: 1,
      stageIndex: 3, currentRating: 300, anger: 0, isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: [inst('atk'), inst('atk')], hand: h, discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [], ready: true,
  });
  return {
    seed: 1, phase: 'playing', turnNumber: 1, activePlayerIdx: 0, step,
    players: [player(0, hand), player(1, [])], log: [],
  };
}

test('a Drill without a Style prefix is Freestyle', () => {
  assert.equal(isFreestyleDrill('drill-free', db), true);
  assert.equal(isFreestyleDrill('drill-red', db), false, 'Red Speed Drill is a Styled Drill');
  assert.equal(isFreestyleDrill('nc', db), false, 'not a Drill at all');
});

test('Non-Combat cards and Drills enter play in the Non-Combat Step', () => {
  const s = makeState([inst('nc'), inst('drill-free')]);
  assert.equal(playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []), undefined);
  assert.equal(playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []), undefined);
  assert.equal(s.players[0]!.zones.inPlay.length, 2);
  assert.equal(s.players[0]!.zones.hand.length, 0);
});

test('combat cards do not enter play this way', () => {
  const s = makeState([inst('atk')]);
  const err = playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []);
  assert.match(err ?? '', /Physical Combat card and does not enter play/);
  assert.equal(s.players[0]!.zones.inPlay.length, 0);
});

test('cards only enter play during your own Non-Combat Step', () => {
  const wrongStep = makeState([inst('nc')], 'combat');
  assert.match(playCard(wrongStep, 0, wrongStep.players[0]!.zones.hand[0]!.uid, db, []) ?? '', /Non-Combat Step/);

  const notActive = makeState([inst('nc')]);
  notActive.activePlayerIdx = 1;
  assert.match(playCard(notActive, 0, notActive.players[0]!.zones.hand[0]!.uid, db, []) ?? '', /active player/);
});

test('playing a Location costs you the Combat Step', () => {
  const s = makeState([inst('loc')]);
  assert.equal(playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []), undefined);
  assert.equal(s.skipCombatThisTurn, true);

  // nonCombat -> powerUp -> declare -> (combat skipped) -> discard
  advanceStep(s, []); // powerUp
  advanceStep(s, []); // declare
  advanceStep(s, []); // would be combat
  assert.equal(s.step, 'discard', 'the Combat Step was skipped');
});

test('a Battleground skips combat the same way', () => {
  const s = makeState([inst('bg')]);
  playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []);
  assert.equal(s.skipCombatThisTurn, true);
});

test('the skip flag clears on the next turn', () => {
  const s = makeState([inst('loc')]);
  playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []);
  // Skipping combat shortens the cycle by one step, so advance until the turn
  // rolls over rather than assuming a fixed count.
  const startTurn = s.turnNumber;
  for (let i = 0; i < 8 && s.turnNumber === startTurn; i++) advanceStep(s, []);
  assert.equal(s.turnNumber, startTurn + 1, 'a new turn began');
  assert.equal(s.skipCombatThisTurn, undefined, 'a new turn restores the Combat Step');
});

test('all Drills are discarded when the MP advances a level', () => {
  const s = makeState([inst('drill-free'), inst('drill-red'), inst('nc')]);
  for (let i = 0; i < 3; i++) playCard(s, 0, s.players[0]!.zones.hand[0]!.uid, db, []);
  assert.equal(s.players[0]!.zones.inPlay.length, 3);

  advanceLevel(s, s.players[0]!.mp, db, []);
  const inPlay = s.players[0]!.zones.inPlay;
  assert.equal(inPlay.length, 1, 'the Non-Combat card stays');
  assert.equal(inPlay[0]!.cardId, 'nc');
  assert.equal(s.players[0]!.zones.discard.length, 2, 'both Drills were discarded');
});

test('discardDrills is a no-op with none in play', () => {
  const s = makeState([]);
  assert.equal(discardDrills(s, 0, db), 0);
});

test('an Ally may not out-level the Main Personality', () => {
  const s = makeState([inst('ally3')]);
  assert.equal(maxAllyLevel(s, 0), 1, 'MP is level 1');
  const r = reduce(s, { type: 'playAlly', playerIdx: 0, cardUid: s.players[0]!.zones.hand[0]!.uid }, db, 0);
  assert.match(r.error ?? '', /level 3 Ally needs a level 3 Main Personality/);
  assert.equal(r.state.players[0]!.allies.length, 0);
});

test('an Ally at or below the MP level is allowed', () => {
  const s = makeState([inst('ally1')]);
  const r = reduce(s, { type: 'playAlly', playerIdx: 0, cardUid: s.players[0]!.zones.hand[0]!.uid }, db, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.state.players[0]!.allies.length, 1);
});

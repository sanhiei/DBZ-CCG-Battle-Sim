/**
 * What is allowed to be on the table at once.
 *
 * There were no rules here at all. Any mix of Drill Styles and any number of
 * duplicates went down together, and every Location or Battleground either
 * player ever played piled up — all continuous, all affecting both sides.
 *
 * That was survivable only while Drills were inert. The moment their damage
 * modifiers apply, an unrestricted Drill board is simply the best thing to
 * build, so the legality has to land before the modifiers do.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { drillStyleOf, isFreestyleDrill } from './drills.js';
import { playCard } from './noncombat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const mk = (id: string, name: string, type: string, style: string | null = null): EngineCard => ({
  id,
  number: null,
  name,
  style,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: 'metadata' },
});

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
  mk('redA', 'Red Power Drill', 'Non-Combat', 'Red'),
  mk('redB', 'Red Ascension Drill', 'Non-Combat', 'Red'),
  // A Styled Drill whose catalog `style` is null — nine real cards look like
  // this, and reading only that field let every one of them slip the check.
  mk('blueNoStyle', 'Blue Defensive Drill', 'Non-Combat', null),
  mk('free', 'Focusing Drill', 'Non-Combat', null),
  mk('loc1', 'Kame House', 'Location'),
  mk('loc2', 'Namek', 'Battleground'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

function state(hands: [CardInstance[], CardInstance[]] = [[], []]): GameState {
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
    zones: { lifeDeck: [], hand: hands[idx] ?? [], discard: [], inPlay: [], removed: [], sensei: [] },
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

/* ------------------------------------------------- reading a Drill's Style */

test("a Drill's Style comes from its title, not just the catalog field", () => {
  assert.equal(drillStyleOf('redA', db), 'Red');
  assert.equal(drillStyleOf('blueNoStyle', db), 'Blue', 'title wins where the field is null');
  assert.equal(drillStyleOf('free', db), null);
  assert.equal(isFreestyleDrill('free', db), true);
  assert.equal(isFreestyleDrill('blueNoStyle', db), false);
});

/* --------------------------------------------------------- Drill legality */

test('two Drills of the same Style are both allowed', () => {
  // "You can have other Styled Drills in play if they all belong to the same
  // Martial Arts Style and are different from any other Styled Drill" (~L648).
  const a = inst('redA');
  const b = inst('redB');
  const s = state([[a, b], []]);
  assert.equal(playCard(s, 0, a.uid, db, []), undefined);
  assert.equal(playCard(s, 0, b.uid, db, []), undefined);
  assert.equal(s.players[0]!.zones.inPlay.length, 2);
});

test('a second copy of the same Styled Drill is refused', () => {
  const a = inst('redA');
  const b = inst('redA');
  const s = state([[a, b], []]);
  playCard(s, 0, a.uid, db, []);
  assert.match(playCard(s, 0, b.uid, db, []) ?? '', /already in play/);
  assert.equal(s.players[0]!.zones.inPlay.length, 1);
  assert.equal(s.players[0]!.zones.hand.length, 1, 'a refusal costs nothing');
});

test('a Drill of a second Style is refused', () => {
  // "If you have a Styled Drill in play, you cannot play another Drill from a
  // different Martial Arts Style" (~L646).
  const red = inst('redA');
  const blue = inst('blueNoStyle');
  const s = state([[red, blue], []]);
  playCard(s, 0, red.uid, db, []);
  assert.match(playCard(s, 0, blue.uid, db, []) ?? '', /cannot play a Blue Style Drill/);
});

test('Freestyle Drills stack freely, and alongside a Style', () => {
  // "You can have multiple copies of a Freestyle Drill in play" (~L640).
  const f1 = inst('free');
  const f2 = inst('free');
  const red = inst('redA');
  const s = state([[f1, f2, red], []]);
  assert.equal(playCard(s, 0, f1.uid, db, []), undefined);
  assert.equal(playCard(s, 0, f2.uid, db, []), undefined);
  assert.equal(playCard(s, 0, red.uid, db, []), undefined);
  assert.equal(s.players[0]!.zones.inPlay.length, 3);
});

/* --------------------------------------- one Location or Battleground, ever */

test('a new Location removes the one already in play FROM THE GAME', () => {
  // "there can only be one Battleground or Location in play at any time ... you
  // remove the [existing] card from the game and the new one comes into play"
  // (~L715). Nothing displaced anything before this.
  const a = inst('loc1');
  const b = inst('loc2');
  const s = state([[a, b], []]);
  playCard(s, 0, a.uid, db, []);
  s.step = 'nonCombat'; // playing a Location costs the Combat Step, not the play
  assert.equal(playCard(s, 0, b.uid, db, []), undefined);
  assert.equal(s.players[0]!.zones.inPlay.length, 1, 'only the new one is on the table');
  assert.equal(s.players[0]!.zones.inPlay[0]!.uid, b.uid);
  assert.equal(s.players[0]!.zones.removed.some((c) => c.uid === a.uid), true, 'the old one left the game');
  assert.equal(s.players[0]!.zones.discard.some((c) => c.uid === a.uid), false, 'removed, not discarded');
});

test("a new Location displaces the OPPONENT's too", () => {
  // They affect both players, so there is one between them, not one each.
  const theirs = inst('loc1');
  const mine = inst('loc2');
  const s = state([[mine], []]);
  s.players[1]!.zones.inPlay.push(theirs);
  assert.equal(playCard(s, 0, mine.uid, db, []), undefined);
  assert.equal(s.players[1]!.zones.inPlay.length, 0);
  assert.equal(s.players[1]!.zones.removed.some((c) => c.uid === theirs.uid), true);
});

test('a Location of the same name cannot be played at all', () => {
  // "You cannot place a Battleground or Location card into play if there is
  // already [one] of the same name in play" (~L717) — no swap, no play.
  const a = inst('loc1');
  const b = inst('loc1');
  const s = state([[a, b], []]);
  playCard(s, 0, a.uid, db, []);
  s.step = 'nonCombat';
  assert.match(playCard(s, 0, b.uid, db, []) ?? '', /already in play/);
  assert.equal(s.players[0]!.zones.inPlay.length, 1);
  assert.equal(s.players[0]!.zones.hand.some((c) => c.uid === b.uid), true, 'still in hand');
});

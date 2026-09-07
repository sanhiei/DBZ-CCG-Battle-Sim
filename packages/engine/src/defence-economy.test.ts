/**
 * Defending has to cost something, and not everything can defend.
 *
 * A re-audit found the defence path had become the worst thing in the engine,
 * through two decisions I made and defended:
 *
 *  - Unparsed cards were allowed to stop an attack "rather than block legal
 *    play on missing data". The fallback did not check anything, so a pure
 *    ATTACK card stopped an attack — a physical attack card stopped an energy
 *    attack — and no attack could land while the defender held any card.
 *  - Cards defending from play were deliberately not spent, because Drills and
 *    Masteries are permanents. Nothing recorded them as used either, so one
 *    card on the table blocked every attack for the rest of the game.
 *
 * The fallback is still there for genuinely unreadable cards, because that case
 * is real — but it now costs the card, which is the actual check on it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ability, CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, resolveDefense } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const mk = (id: string, name: string, type: string, abilities?: Ability[], text?: string): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: abilities ? 'partial' : 'metadata', ...(abilities ? { abilities } : {}), ...(text ? { text } : {}) },
});

const attackAbility: Ability = { trigger: 'attack', effects: [{ kind: 'physicalAttack' }], source: 'parsed' };
const stopAbility: Ability = {
  trigger: 'defense',
  effects: [{ kind: 'stopAttack', attackType: 'any', window: 'thisAttack' }],
  source: 'parsed',
};

const mpCard: EngineCard = {
  id: 'mp1',
  number: null,
  name: 'Goku',
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: 'Personality',
    coverage: 'metadata',
    personality: { level: 1, personalityName: 'Goku', alignment: 'Hero', powerRatings: LADDER, zeroStageIndex: 0, pur: 1, canBeAlly: false },
  },
};

const db = new CardDb([
  mpCard,
  mk('pure-attack', 'Big Punch', 'Physical Combat', [attackAbility]),
  mk('real-block', 'Plain Block', 'Combat', [stopAbility]),
  mk('unreadable', 'Smudged Card', 'Combat'),
  mk('drill', 'Red Defense Drill', 'Non-Combat', [stopAbility], 'Stops a physical attack.'),
  mk('noncombat-block', 'Android 16 Smiles', 'Non-Combat', [stopAbility], 'Stops a physical attack.'),
  mk('filler', 'Filler', 'Physical Combat'),
]);

let uid = 0;
const inst = (cardId: string): CardInstance => ({ uid: `u${uid++}`, cardId, faceDown: false });

/**
 * Put a card that can attack into a player's hand and return its uid.
 *
 * An attack has to come from somewhere — CRD ~L286 lists what an Attack Phase
 * may be spent on and every attacking option names a source. These tests are
 * about what happens AFTER an attack is declared, so this supplies the source
 * and gets out of the way.
 */
function armAttack(s: GameState, playerIdx: number): string {
  const card = inst('filler');
  s.players[playerIdx]!.zones.hand.push(card);
  return card.uid;
}


function combatState(defenderHand: CardInstance[], defenderInPlay: CardInstance[] = []): GameState {
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
    zones: {
      lifeDeck: Array.from({ length: 25 }, () => inst('filler')),
      hand: idx === 1 ? defenderHand : [],
      discard: [],
      inPlay: idx === 1 ? defenderInPlay : [],
      removed: [],
      sensei: [],
    },
    dragonBalls: [],
    ready: true,
  });
  const s: GameState = {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [player(0), player(1)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/* ---------- an attack card is not a defence ---------- */

test('a pure attack card cannot be used to defend', () => {
  const card = inst('pure-attack');
  const s = combatState([card]);
  declareAttack(s, 'energy', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /is an attack, not a defence/);
  assert.equal(s.combat!.currentAttack!.stopped, false);
});

test('a real defence card still works', () => {
  const card = inst('real-block');
  const s = combatState([card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
});

test('a card the parser could not read at all is still allowed, and is spent', () => {
  // This case is real and refusing it would block legal play; the cost of the
  // card is what keeps it honest.
  const card = inst('unreadable');
  const s = combatState([card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  assert.equal(s.players[1]!.zones.discard.filter((x) => x.uid === card.uid).length, 1);
});

/* ---------- defending from play costs something ---------- */

test('a Non-Combat card used from play is discarded', () => {
  // "Stays face up until used, then discarded" (CRD ~L627).
  const card = inst('noncombat-block');
  const s = combatState([], [card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  const z = s.players[1]!.zones;
  assert.equal(z.inPlay.length, 0, 'it left the table');
  assert.equal(z.discard.filter((x) => x.uid === card.uid).length, 1);
});

test('a Drill stays on the table but only answers once per combat', () => {
  const card = inst('drill');
  const s = combatState([], [card]);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  assert.equal(s.players[1]!.zones.inPlay.length, 1, 'a permanent stays');

  // Same combat, second attack: it cannot answer again.
  declareAttack(s, 'physical', armAttack(s, 1), { actingPlayerIdx: 1 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 0 }, db, []);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /already been used this Combat/);
});

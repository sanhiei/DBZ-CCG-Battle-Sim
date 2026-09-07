/**
 * Cards are real objects: they have to be yours, they have to be able to do the
 * thing, and they get spent.
 *
 * A CRD conformance audit found all three missing at once. Defense accepted any
 * string as a card, `discardAttackCards` was an empty function body, and power
 * stages the target could not lose were dropped instead of converting to life
 * cards. Together they made combat a formality: nothing was spent, no attack
 * had to land, and a personality at 0 power stages was immune to physical
 * damage forever.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, declareEmpower, resolveDefense } from './combat.js';
import { computeBaseDamage } from './pat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const combatCard = (
  id: string,
  name: string,
  opts: { type?: string; stops?: 'physical' | 'energy' | 'any'; removeAfterUse?: boolean; noAbility?: boolean } = {},
): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Buu',
  rarity: 'Common',
  imageUrl: '',
  rules: {
    type: opts.type ?? 'Combat',
    coverage: opts.noAbility ? 'metadata' : 'partial',
    ...(opts.noAbility
      ? {}
      : {
          abilities: [
            {
              trigger: 'defense' as const,
              effects: [
                ...(opts.stops ? [{ kind: 'stopAttack' as const, attackType: opts.stops, window: 'thisAttack' as const }] : []),
                ...(opts.removeAfterUse ? [{ kind: 'removeFromGameAfterUse' as const }] : []),
              ],
              source: 'parsed' as const,
            },
          ],
        }),
  },
});

const mp: EngineCard = {
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

const db = new CardDb([
  mp,
  combatCard('block-any', 'Any Block', { stops: 'any' }),
  combatCard('block-energy', 'Energy Only Block', { stops: 'energy' }),
  combatCard('block-gone', 'Spent Block', { stops: 'any', removeAfterUse: true }),
  combatCard('unparsed', 'Unparsed Block', { noAbility: true }),
  // A block that also does something. CRD ~L387: the something still happens.
  {
    id: 'rider',
    number: null,
    name: 'Red Forearm Block',
    style: null,
    saga: 'Buu',
    rarity: 'Common',
    imageUrl: '',
    rules: {
      type: 'Combat',
      coverage: 'partial',
      abilities: [
        {
          trigger: 'defense' as const,
          effects: [
            { kind: 'stopAttack' as const, attackType: 'any' as const, window: 'thisAttack' as const },
            { kind: 'changeAnger' as const, target: 'user' as const, delta: 1 },
            { kind: 'changeAnger' as const, target: 'foe' as const, delta: -1 },
          ],
          source: 'parsed' as const,
        },
      ],
    },
  } as EngineCard,
  combatCard('senzu', 'Senzu Bean', { type: 'Non-Combat', noAbility: true }),
  combatCard('atk', 'Big Punch', { type: 'Physical Combat', noAbility: true }),
  combatCard('filler', 'Filler', { type: 'Physical Combat', noAbility: true }),
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
  const card = inst('atk');
  s.players[playerIdx]!.zones.hand.push(card);
  return card.uid;
}


/** Attacker is seat 0, defender seat 1. `stageIndex` sets the DEFENDER's stages. */
function combatState(opts: { attackerHand?: CardInstance[]; defenderHand?: CardInstance[]; defenderStage?: number; deck?: number } = {}): GameState {
  const player = (idx: number, hand: CardInstance[], stageIndex: number, deck: number): GameState['players'][number] => ({
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
      stageIndex,
      currentRating: LADDER[stageIndex]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
    zones: { lifeDeck: Array.from({ length: deck }, () => inst('filler')), hand, discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  const s: GameState = {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [player(0, opts.attackerHand ?? [], 4, 20), player(1, opts.defenderHand ?? [], opts.defenderStage ?? 4, opts.deck ?? 20)],
    log: [],
  };
  beginCombat(s, db, []);
  return s;
}

/* ---------- a defense card has to be a card, and has to be yours ---------- */

test('a card id that does not exist cannot defend', () => {
  const s = combatState({ defenderHand: [inst('block-any')] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: 'no-such-card' }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /not in your hand/);
  assert.equal(s.combat!.currentAttack!.stopped, false, 'the attack is not stopped');
});

test('a card in the ATTACKER’s hand cannot defend', () => {
  const theirs = inst('block-any');
  const s = combatState({ attackerHand: [theirs], defenderHand: [] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: theirs.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /not in your hand/);
});

test('a Non-Combat card cannot defend', () => {
  const bean = inst('senzu');
  const s = combatState({ defenderHand: [bean] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: bean.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /cannot be used to defend/);
});

test('an energy-only block cannot stop a physical attack', () => {
  const card = inst('block-energy');
  const s = combatState({ defenderHand: [card] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /does not stop physical/);
  assert.equal(s.combat!.currentAttack!.stopped, false);
});

test('a card whose text is not parsed yet is still allowed to defend', () => {
  // Refusing it would block legal play on the strength of missing data, so it
  // resolves as a stop and says in the log that it needs checking by hand.
  const card = inst('unparsed');
  const s = combatState({ defenderHand: [card] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  assert.ok(s.log.some((l) => l.includes('verify by hand')));
});

/* ---------- cards are spent ---------- */

test('a defense card leaves hand and reaches the discard pile', () => {
  const card = inst('block-any');
  const s = combatState({ defenderHand: [card] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);
  const z = s.players[1]!.zones;
  // beginCombat deals the defender 3 cards, so check this card specifically.
  assert.equal(z.hand.filter((c) => c.uid === card.uid).length, 0, 'spent out of hand');
  assert.equal(z.discard.filter((c) => c.uid === card.uid).length, 1, 'and into the discard pile');
});

test('a card already in the discard pile cannot be played from there', () => {
  // The old lookup searched hand, inPlay AND discard across both players, so a
  // spent card answered for the defense again every time it was named.
  const spent = inst('block-any');
  const s = combatState({ defenderHand: [] });
  s.players[1]!.zones.discard.push(spent);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const err = resolveDefense(s, { cardUid: spent.uid }, { actingPlayerIdx: 1 }, db, []);
  assert.match(err ?? '', /not in your hand/, 'the discard pile is not a second hand');
});

test('"remove from the game after use" is honoured over discarding', () => {
  const card = inst('block-gone');
  const s = combatState({ defenderHand: [card] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  const z = s.players[1]!.zones;
  assert.equal(z.removed.length, 1);
  assert.equal(z.discard.length, 0);
});

test('the attack card is spent when the attack resolves', () => {
  const card = inst('atk');
  const s = combatState({ attackerHand: [card], defenderHand: [] });
  assert.equal(declareAttack(s, 'physical', card.uid, { actingPlayerIdx: 0 }, db, []), undefined);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  const z = s.players[0]!.zones;
  assert.equal(z.hand.length, 0, 'the attack card left hand');
  assert.equal(z.discard.filter((c) => c.uid === card.uid).length, 1);
});

test('an attack card must be in the attacker’s hand', () => {
  const s = combatState();
  const err = declareAttack(s, 'physical', 'ghost-card', { actingPlayerIdx: 0 }, db, []);
  assert.match(err ?? '', /not in your hand/);
});

/* ---------- a stopped attack does not stop the card's other effects ---------- */

test("a defense card's secondary effects happen even though it stopped the attack", () => {
  // CRD ~L387: "If the attack is stopped, the effects are NOT stopped.
  // Secondary effects occur regardless of if an attack is stopped or not."
  // Only the stop was being read, so every rider a defense card carries was
  // thrown away — which is most of the anger economy.
  const card = inst('rider');
  const s = combatState({ defenderHand: [card] });
  s.players[0]!.mp.anger = 2; // anger floors at 0, so give the attacker some to lose
  const attackerAngerBefore = s.players[0]!.mp.anger;
  const defenderAngerBefore = s.players[1]!.mp.anger;

  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []), undefined);

  assert.equal(s.players[1]!.mp.anger, defenderAngerBefore + 1, "the defender's anger rose");
  assert.equal(s.players[0]!.mp.anger, attackerAngerBefore - 1, "the attacker's anger dropped");
});

test('the card is still spent exactly once when it has riders', () => {
  const card = inst('rider');
  const s = combatState({ defenderHand: [card] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { cardUid: card.uid }, { actingPlayerIdx: 1 }, db, []);
  const z = s.players[1]!.zones;
  assert.equal(z.discard.filter((c) => c.uid === card.uid).length, 1);
  assert.equal(z.hand.filter((c) => c.uid === card.uid).length, 0);
});

/**
 * What the PAT says this fixture's attack does. Physical Base Damage is read at
 * damage time now, not at declaration — step 9 of the battle sequence, after
 * the defender has named who is in Control of Combat — so there is nothing to
 * read off `currentAttack` the moment an attack is declared. Stating the
 * expected number here is what these tests meant anyway; reading it back out of
 * the engine only ever asserted that the engine agreed with itself.
 *
 * The fixture puts the attacker at stage 4 of LADDER.
 */
const patDamage = (defenderStage: number): number => computeBaseDamage(LADDER[4]!, LADDER[defenderStage]!);

/* ---------- power stages that cannot be lost become life cards ---------- */

test('power-stage damage beyond the target’s stages converts to life cards', () => {
  // CRD ~L436: "when a personality is at 0 and is dealt power stages of damage,
  // those power stages are converted into life cards of damage".
  const s = combatState({ defenderStage: 1, deck: 20 });
  const dmg = patDamage(1);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.ok(dmg > 1, 'this fixture needs an attack bigger than the 1 stage available');

  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);

  assert.equal(s.players[1]!.mp.stageIndex, 0, 'stages are emptied first');
  const lost = deckBefore - s.players[1]!.zones.lifeDeck.length;
  assert.equal(lost, dmg - 1, 'the remainder is dealt as life cards');
});

test('a personality at 0 power stages is not immune to physical damage', () => {
  const s = combatState({ defenderStage: 0, deck: 20 });
  const dmg = patDamage(0);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(deckBefore - s.players[1]!.zones.lifeDeck.length, dmg, 'all of it converts');
});

/* ---------- Empower is life cards, not power stages ---------- */

test('Empower adds life cards to an energy attack', () => {
  // CRD ~L1102: "the attack will do +X life cards". Empower was dropped
  // entirely on life-card attacks, so declaring it bought nothing.
  const s = combatState({ defenderStage: 5, deck: 30 });
  declareAttack(s, 'energy', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  declareEmpower(s, 3, { actingPlayerIdx: 0 });
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  // Energy base is 4 life cards, +3 Empower.
  assert.equal(deckBefore - s.players[1]!.zones.lifeDeck.length, 7);
});

test('Empower does NOT inflate power-stage damage', () => {
  // It was summed into the power-stage total, turning life cards into stages —
  // a different resource entirely.
  const s = combatState({ defenderStage: 5, deck: 30 });
  const base = patDamage(5);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  declareEmpower(s, 3, { actingPlayerIdx: 0 });
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);

  assert.equal(s.players[1]!.mp.stageIndex, 5 - base, 'stages lost are the PAT result only');
  assert.equal(deckBefore - s.players[1]!.zones.lifeDeck.length, 3, 'and the Empower lands as life cards');
});

test('no conversion happens when the target can absorb the damage', () => {
  const s = combatState({ defenderStage: 5, deck: 20 });
  const dmg = patDamage(5);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.ok(dmg <= 5, 'fixture assumption: the target can take it in stages');
  const deckBefore = s.players[1]!.zones.lifeDeck.length;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.equal(s.players[1]!.mp.stageIndex, 5 - dmg);
  assert.equal(s.players[1]!.zones.lifeDeck.length, deckBefore, 'no life cards lost');
});

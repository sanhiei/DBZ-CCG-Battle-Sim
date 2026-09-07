/**
 * The two response windows the battle sequence defines and the engine skipped.
 *
 * Step 4: "If an Ally can take over Combat for the Main Personality, the
 * Defender must announce which personality is in Control of Combat until this
 * attack is resolved" (CRD ~L325). Control decides whose power rating the
 * Physical Attack Table reads and who takes the damage, and it was never asked.
 *
 * Step 7: "If the attack was not stopped, the defender must now activate any
 * Defense Shields from his cards in play" (~L337). This window did not exist,
 * so 23 Non-Combat cards printing a Defense Shield sat in play doing nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState, PersonalityInPlay } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { beginCombat, declareAttack, redirectDamage, resolveControlOfCombat, resolveDefense } from './combat.js';

const LADDER = [0, 100, 200, 300, 400, 500];

const card = (id: string, name: string, type: string, text?: string): EngineCard => ({
  id,
  number: null,
  name,
  style: null,
  saga: 'Saiyan',
  rarity: 'Common',
  imageUrl: '',
  rules: { type, coverage: 'metadata', ...(text ? { text } : {}) },
});

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
  card('filler', 'Filler', 'Physical Combat'),
  card('shield-any', 'Majin Defense Drill', 'Non-Combat', 'Defense Shield: Stops the first unstopped attack performed against you this Combat.'),
  card('shield-energy', 'Fortify Your Spirit', 'Non-Combat', 'Defense Shield: Stops the first unstopped energy attack performed against you this Combat. Remove from the game after use.'),
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


const ally = (): PersonalityInPlay => ({
  uid: 'ally-1',
  personalityName: 'Krillin',
  alignment: 'Hero',
  levelCardIds: ['mp1'],
  currentLevel: 1,
  stageIndex: 3,
  currentRating: 300,
  anger: 0,
  isAlly: true,
});

/** Defender is seat 1. */
function combatState(opts: { defenderMpStage?: number; withAlly?: boolean; inPlay?: CardInstance[] } = {}): GameState {
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
      stageIndex: idx === 1 ? (opts.defenderMpStage ?? 4) : 4,
      currentRating: LADDER[idx === 1 ? (opts.defenderMpStage ?? 4) : 4]!,
      anger: 0,
      isAlly: false,
    },
    allies: idx === 1 && opts.withAlly ? [ally()] : [],
    zones: {
      lifeDeck: Array.from({ length: 25 }, () => inst('filler')),
      hand: [],
      discard: [],
      inPlay: idx === 1 ? (opts.inPlay ?? []) : [],
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

/* ---------- step 4: Control of Combat ---------- */

test('the defender is asked who is in Control when an Ally could take over', () => {
  const s = combatState({ withAlly: true, defenderMpStage: 1 });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(s.pendingPrompt?.type, 'controlOfCombat');
  assert.equal(s.combat!.currentAttack!.resolutionStep, 4);
  assert.equal((s.pendingPrompt!.options as Array<{ uid: string }>).length, 2, 'the MP and the Ally');
});

test('no Control question when the MP is healthy — an Ally may not take over', () => {
  const s = combatState({ withAlly: true, defenderMpStage: 4 });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(s.pendingPrompt?.type, 'defend', 'straight to the defence');
});

test('no Control question with no Ally to offer', () => {
  const s = combatState({ defenderMpStage: 0 });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(s.pendingPrompt?.type, 'defend');
});

test('naming the Ally makes it the one that takes the damage', () => {
  const s = combatState({ withAlly: true, defenderMpStage: 1 });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.equal(resolveControlOfCombat(s, 'ally-1', { actingPlayerIdx: 1 }, db, []), undefined);

  assert.equal(s.pendingPrompt?.type, 'defend', 'the defence window opens next');
  assert.equal(s.combat!.currentAttack!.resolutionStep, 5);
  assert.equal(s.combat!.currentAttack!.defenderControllerUid, 'ally-1');

  const before = s.players[1]!.allies[0]!.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  // With the Ally in control, the MP becomes a legal redirect target, so the
  // engine offers that choice; decline it to keep the damage on the controller.
  const nowPending: string | undefined = s.pendingPrompt?.type;
  if (nowPending === 'redirect') {
    assert.equal(redirectDamage(s, null, { actingPlayerIdx: 1 }, db, []), undefined);
  }
  assert.ok(s.players[1]!.allies[0]!.stageIndex < before, 'the Ally took it');
  assert.equal(s.players[1]!.mp.stageIndex, 1, 'the MP did not');
});

test('only the defender may answer the Control question', () => {
  const s = combatState({ withAlly: true, defenderMpStage: 1 });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  assert.match(resolveControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, db, []) ?? '', /only the defender/);
});

/* ---------- step 7: Defense Shields ---------- */

test('a Defense Shield in play stops an attack the defender did not stop', () => {
  const shield = inst('shield-any');
  const s = combatState({ inPlay: [shield] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const before = s.players[1]!.mp.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);

  assert.equal(s.players[1]!.mp.stageIndex, before, 'no damage got through');
  assert.ok(s.log.some((l) => l.includes('Majin Defense Drill') && l.includes('stops the attack')));
});

test('a shield only stops the attack type it names', () => {
  const shield = inst('shield-energy');
  const s = combatState({ inPlay: [shield] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  const before = s.players[1]!.mp.stageIndex;
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.ok(s.players[1]!.mp.stageIndex < before, 'an energy shield does not stop a physical attack');
});

test('a shield stops only the FIRST unstopped attack, then is spent', () => {
  const shield = inst('shield-any');
  const s = combatState({ inPlay: [shield] });
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.deepEqual(s.combat!.shieldsUsed, [shield.uid]);

  // Second attack this combat: the shield is used up.
  const before = s.players[1]!.mp.stageIndex;
  declareAttack(s, 'physical', armAttack(s, 1), { actingPlayerIdx: 1 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 0 }, db, []);
  declareAttack(s, 'physical', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  assert.ok(s.players[1]!.mp.stageIndex < before, 'the second attack gets through');
});

test('"remove from the game after use" takes the shield out of play', () => {
  const shield = inst('shield-energy');
  const s = combatState({ inPlay: [shield] });
  declareAttack(s, 'energy', armAttack(s, 0), { actingPlayerIdx: 0 }, db, []);
  resolveDefense(s, { takeDamage: true }, { actingPlayerIdx: 1 }, db, []);
  const z = s.players[1]!.zones;
  assert.equal(z.inPlay.length, 0);
  assert.equal(z.removed.length, 1);
});

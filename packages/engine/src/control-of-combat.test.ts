/**
 * Control of Combat is a loan, not a transfer.
 *
 * CRD ~L589: "When your Ally takes control of Combat from your MP, it remains
 * in control as long as your MP is still at its bottom 2 power stages." Nothing
 * ever released it, so the first Ally to take control kept it for the rest of
 * the game — the MP powered back up and never fought again, and every attack
 * and defence used the Ally's power rating instead.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, GameState, PersonalityInPlay } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { controllerOf, takeControlOfCombat } from './combat.js';
import { powerUp, releaseControlIfMpRecovered } from './turn.js';

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
const db = new CardDb([mpCard]);

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

function stateWithAlly(mpStage: number): GameState {
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
      stageIndex: idx === 0 ? mpStage : 4,
      currentRating: LADDER[idx === 0 ? mpStage : 4]!,
      anger: 0,
      isAlly: false,
    },
    allies: idx === 0 ? [ally()] : [],
    zones: { lifeDeck: [] as CardInstance[], hand: [], discard: [], inPlay: [], removed: [], sensei: [] },
    dragonBalls: [],
    ready: true,
  });
  return {
    seed: 1,
    phase: 'playing',
    turnNumber: 1,
    activePlayerIdx: 0,
    step: 'combat',
    players: [player(0), player(1)],
    log: [],
  };
}

test('an Ally may take control while the MP is at its bottom 2 stages', () => {
  const s = stateWithAlly(1);
  assert.equal(takeControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, []), undefined);
  assert.equal(controllerOf(s.players[0]!).uid, 'ally-1');
});

test('an Ally may not take control while the MP is healthy', () => {
  const s = stateWithAlly(4);
  assert.match(takeControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, []) ?? '', /bottom 2 power stages/);
});

test('control returns to the MP once it powers back up', () => {
  const s = stateWithAlly(0);
  takeControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, []);
  assert.equal(controllerOf(s.players[0]!).uid, 'ally-1');

  powerUp(s, 0, db, []); // PUR 2: stage 0 -> 2, off the bottom
  assert.equal(controllerOf(s.players[0]!).uid, 'mp0', 'the MP is back in control');
});

test('control is NOT released while the MP is still down', () => {
  const s = stateWithAlly(0);
  takeControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, []);
  s.players[0]!.mp.stageIndex = 1; // still within the bottom 2
  assert.equal(releaseControlIfMpRecovered(s, 0), false);
  assert.equal(controllerOf(s.players[0]!).uid, 'ally-1');
});

test('the MP may take Control of Combat back by choice', () => {
  // CRD ~L585: "You may choose to keep the current Ally in control of Combat,
  // or have another personality take control of Combat." Only Allies were
  // accepted, so control could never be handed back deliberately.
  const s = stateWithAlly(0);
  takeControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, []);
  assert.equal(takeControlOfCombat(s, 'mp0', { actingPlayerIdx: 0 }, []), undefined);
  assert.equal(controllerOf(s.players[0]!).uid, 'mp0');
});

test('control cannot change while an attack is resolving', () => {
  // CRD ~L585: the personality in control "must stay in control of Combat
  // until the attack is resolved".
  const s = stateWithAlly(0);
  s.combat = {
    attackerPlayerIdx: 0,
    defenderPlayerIdx: 1,
    phasePlayerIdx: 0,
    consecutivePasses: 0,
    finalUsed: [],
    currentAttack: {
      attackerPlayerIdx: 0,
      defenderPlayerIdx: 1,
      attackerControllerUid: 'mp0',
      defenderControllerUid: 'mp1',
      attackType: 'physical',
      stopped: false,
      successful: false,
      resolutionStep: 5,
    },
  };
  assert.match(takeControlOfCombat(s, 'ally-1', { actingPlayerIdx: 0 }, []) ?? '', /while an attack is resolving/);
});

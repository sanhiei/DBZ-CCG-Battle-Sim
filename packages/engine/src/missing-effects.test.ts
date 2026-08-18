/**
 * Second clauses the parser used to drop.
 *
 * Each of these cards prints two or more effects. The parser matched the first
 * and stopped, so the card was recorded with `partial` coverage and the engine
 * resolved it as if the rest of the card were not there — the worst failure
 * mode available, because nothing looked wrong.
 *
 * Every text below is the printed text of a card the ability audit flagged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CardInstance, Effect, GameEvent, GameState } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { applyIfSuccessful, parseAbility, setupAttackAbility } from './abilities.js';

const of = <K extends Effect['kind']>(effects: Effect[], k: K) =>
  effects.filter((e) => e.kind === k) as Array<Extract<Effect, { kind: K }>>;

/* ---------- anger: both sides, either direction, own amounts ---------- */

test('a card that moves BOTH players’ anger emits both changes', () => {
  // Gohan's Ready. The user half was suppressed whenever a foe-lowering clause
  // appeared anywhere in the text, so this card only ever lowered the foe.
  const a = parseAbility("Physical attack. Raise your anger 1 level. Lower your opponent's anger 3 levels.", 'Physical Combat')!;
  const anger = of(a.effects, 'changeAnger');
  assert.equal(anger.length, 2);
  assert.deepEqual(
    anger.find((e) => e.target === 'user'),
    { kind: 'changeAnger', target: 'user', delta: 1 },
  );
  assert.deepEqual(
    anger.find((e) => e.target === 'foe'),
    { kind: 'changeAnger', target: 'foe', delta: -3 },
  );
});

test('amounts do not leak between anger clauses', () => {
  // The foe effect used to take its number from whichever clause matched first.
  const a = parseAbility("Raise your anger 2 levels. Lower your opponent's anger 1 level.", 'Non-Combat')!;
  const anger = of(a.effects, 'changeAnger');
  assert.equal(anger.find((e) => e.target === 'user')?.delta, 2);
  assert.equal(anger.find((e) => e.target === 'foe')?.delta, -1);
});

test('lowering YOUR OWN anger is parsed', () => {
  // Android 17's Neck Hold. The user branch only understood raising, so this
  // card produced no anger effect at all.
  const a = parseAbility('Physical attack. If successful. Lower your anger 3 levels.', 'Physical Combat')!;
  assert.deepEqual(of(a.effects, 'changeAnger'), [{ kind: 'changeAnger', target: 'user', delta: -3 }]);
});

/* ---------- power stages stated outside the damage clause ---------- */

test('"Gain N power stages" on an attack is not swallowed by the damage clause', () => {
  // Cell's Charge. The attack branch never ran the power-stage parser at all,
  // so the gain vanished while the +3 damage modifier looked like the whole card.
  const a = parseAbility('Physical attack doing +3 power stages of damage. Gain 3 power stages.', 'Physical Combat')!;
  assert.equal(of(a.effects, 'damageStages')[0]?.stages, 3, 'the damage modifier survives');
  assert.deepEqual(of(a.effects, 'changePowerStages'), [{ kind: 'changePowerStages', target: 'user', delta: 3 }]);
});

test('the opponent losing power stages is parsed alongside a stop', () => {
  // Saiyan Lightning Dodge.
  const a = parseAbility('Stops a physical attack. Your opponent loses 4 power stages, to a minimum of 0.', 'Physical Combat')!;
  assert.equal(of(a.effects, 'stopAttack').length, 1);
  assert.deepEqual(of(a.effects, 'changePowerStages'), [{ kind: 'changePowerStages', target: 'foe', delta: -4 }]);
});

test('a damage clause is not double-counted as a power-stage gain', () => {
  const a = parseAbility('Physical attack doing +5 power stages of damage.', 'Physical Combat')!;
  assert.deepEqual(of(a.effects, 'changePowerStages'), [], 'damage is not a stage gain');
});

/* ---------- raise to highest, as actually printed ---------- */

test('"Raise your Main Personality to his highest power stage" is parsed', () => {
  // Blue Knockdown. The old pattern wanted the literal "your personality" and
  // "highest stage", so the usual printing was dropped.
  const a = parseAbility(
    'Physical attack doing +5 power stages of damage. Raise your Main Personality to his highest power stage.',
    'Physical Combat',
  )!;
  assert.deepEqual(of(a.effects, 'movePowerStage'), [{ kind: 'movePowerStage', target: 'user', to: 'highest' }]);
});

test('"all personalities in play" raises the opponent’s too', () => {
  // Gohan's Peaceful Stance — the card says in play, not yours.
  const a = parseAbility('Raise all personalities in play to their highest power stage.', 'Non-Combat')!;
  const moves = of(a.effects, 'movePowerStage');
  assert.equal(moves.length, 2);
  assert.ok(moves.some((m) => m.target === 'user' && m.to === 'highest'));
  assert.ok(moves.some((m) => m.target === 'foe' && m.to === 'highest'));
});

/* ---------- two stops on one card ---------- */

test('a card that stops twice keeps both stops', () => {
  // Frieza's Force Bubble. Matching once against the whole text kept only one
  // clause, so either the current attack or the combat-long lockout was lost.
  const a = parseAbility(
    'Stops an energy attack. Stops all energy attacks for the remainder of Combat. Limit 1 per deck.',
    'Energy Combat',
  )!;
  const stops = of(a.effects, 'stopAttack');
  assert.equal(stops.length, 2);
  assert.ok(stops.some((s) => s.window === 'thisAttack' && s.attackType === 'energy'));
  assert.ok(stops.some((s) => s.window === 'thisCombat' && s.scope === 'all'));
});

test('one stop clause still yields exactly one stop', () => {
  const a = parseAbility('Stops a physical attack.', 'Physical Combat')!;
  assert.equal(of(a.effects, 'stopAttack').length, 1, 'no phantom duplicate');
});

/* ---------- damage stated in the other printed forms ---------- */

test('"4+ power stages of damage" is a modifier, not a fixed base', () => {
  // Red Knee Bash. Read as a base it replaced the whole Physical Attack Table
  // result with a flat 4.
  const a = parseAbility('Physical attack doing 4+ power stages of damage.', 'Physical Combat')!;
  assert.equal(of(a.effects, 'physicalAttack')[0]?.powerStages, undefined, 'the PAT still applies');
  assert.equal(of(a.effects, 'damageStages')[0]?.stages, 4);
});

test('an attack stating both bases keeps both', () => {
  // Black Jump Kick. The parser returned at the life-card match and never saw
  // the power-stage half.
  const a = parseAbility('Physical attack doing 1 life card of damage and 1 power stage of damage.', 'Physical Combat')!;
  assert.deepEqual(of(a.effects, 'physicalAttack'), [{ kind: 'physicalAttack', lifeCards: 1, powerStages: 1 }]);
});

test('a single-base attack is unchanged', () => {
  const a = parseAbility('Energy attack doing 5 life cards of damage.', 'Energy Combat')!;
  assert.deepEqual(of(a.effects, 'energyAttack'), [{ kind: 'energyAttack', lifeCards: 5 }]);
});

/* ---------- and the engine actually performs them ---------- */

// A parse that is never executed is no better than no parse: the card reads as
// modelled and still does nothing. movePowerStage had been in the effect union
// from the start and was emitted zero times, so the executor never needed a
// case for it — and did not have one.

const LADDER = [0, 100, 200, 300, 400, 500];

const goku: EngineCard = {
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
const db = new CardDb([goku]);

function stateAtStage(stageIndex: number): GameState {
  const mk = (idx: number): GameState['players'][number] => ({
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
      stageIndex,
      currentRating: LADDER[stageIndex]!,
      anger: 0,
      isAlly: false,
    },
    allies: [],
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
    players: [mk(0), mk(1)],
    log: [],
  };
}

test('movePowerStage jumps the personality to the top of its ladder', () => {
  const state = stateAtStage(2);
  const events: GameEvent[] = [];
  applyIfSuccessful(state, [{ kind: 'movePowerStage', target: 'user', to: 'highest' }], db, events, {
    userIdx: 0,
    foeIdx: 1,
  });
  assert.equal(state.players[0]!.mp.stageIndex, LADDER.length - 1);
  assert.equal(state.players[0]!.mp.currentRating, 500, "the rating follows the stage");
  assert.ok(events.some((e) => e.type === 'stageChanged'), 'the move is reported');
});

test('a power-stage gain cannot climb past the top rung', () => {
  // Only the floor was clamped. Harmless while nothing emitted a gain; now
  // that "Gain 4 power stages" parses, an unclamped gain leaves stageIndex
  // off the end of the ladder and the rating reads back undefined.
  const state = stateAtStage(4);
  const events: GameEvent[] = [];
  const attack = { modifiers: 0, ifSuccessfulStages: 0 } as NonNullable<GameState['combat']>['currentAttack'] & object;
  const ability = parseAbility('Physical attack. Gain 4 power stages.', 'Physical Combat')!;
  setupAttackAbility(state, ability, 0, 1, attack, db, events);
  assert.equal(state.players[0]!.mp.stageIndex, LADDER.length - 1, 'clamped to the top rung');
  assert.equal(state.players[0]!.mp.currentRating, 500);
});

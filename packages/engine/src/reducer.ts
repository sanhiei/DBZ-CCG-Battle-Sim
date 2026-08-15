/**
 * Authoritative reducer: reduce(state, action, db, actingPlayerIdx?) -> { state, events, error? }.
 * Pure: clones the input state, never mutates it. Combat is delegated to combat.ts.
 * `actingPlayerIdx` is who sent the action (the server knows). If omitted, the
 * expected actor is inferred so tests can call without it.
 */
import type { Action, CardInstance, GameEvent, GameState, PersonalityInPlay } from '@dbz/shared';
import type { CardDb } from './loader.js';
import { advanceStep, draw, powerUp, setAnger, setStage } from './turn.js';
import {
  beginCombat,
  declareAttack,
  declareEmpower,
  passPhase,
  redirectDamage,
  resolveDefense,
  takeControlOfCombat,
  type CombatCtx,
} from './combat.js';
import { firstAttackAbility } from './abilities.js';

const clone = <T>(x: T): T => structuredClone(x);
const START_ALLY_STAGES_ABOVE_ZERO = 3;

type PlayerZones = GameState['players'][number]['zones'];
function findInstance(state: GameState, uid: string): { playerIdx: number; zone: keyof PlayerZones; idx: number } | undefined {
  for (const p of state.players) {
    for (const zone of Object.keys(p.zones) as Array<keyof PlayerZones>) {
      const idx = p.zones[zone].findIndex((c: CardInstance) => c.uid === uid);
      if (idx !== -1) return { playerIdx: p.idx, zone, idx };
    }
  }
  return undefined;
}

function allyOwner(state: GameState, uid: string): number {
  for (const p of state.players) if (p.allies.some((a) => a.uid === uid)) return p.idx;
  return state.activePlayerIdx;
}

/** Infer who is acting when the server didn't say (used by tests / single-seat). */
function inferActor(state: GameState, action: Action): number {
  const c = state.combat;
  switch (action.type) {
    case 'declareAttack':
    case 'pass':
      return c?.phasePlayerIdx ?? state.activePlayerIdx;
    case 'defend':
    case 'redirectDamage':
    case 'answerPrompt':
      return state.pendingPrompt?.playerIdx ?? c?.defenderPlayerIdx ?? state.activePlayerIdx;
    case 'declareEmpower':
      return c?.currentAttack?.attackerPlayerIdx ?? state.activePlayerIdx;
    case 'takeControlOfCombat':
      return allyOwner(state, action.personalityUid);
    default:
      return state.activePlayerIdx;
  }
}

const fail = (prev: GameState, error: string): ReduceResult => ({ state: prev, events: [], error });
type ReduceResult = { state: GameState; events: GameEvent[]; error?: string };

export function reduce(prev: GameState, action: Action, db: CardDb, actingPlayerIdx?: number): ReduceResult {
  if (prev.phase === 'ended') return fail(prev, 'game over');
  const state = clone(prev);
  const events: GameEvent[] = [];
  const actor = actingPlayerIdx ?? inferActor(state, action);
  const ctx: CombatCtx = { actingPlayerIdx: actor };

  let err: string | undefined;
  switch (action.type) {
    case 'advanceStep': {
      advanceStep(state, events);
      if (state.step === 'draw') draw(state, state.activePlayerIdx, 1);
      else if (state.step === 'powerUp') powerUp(state, state.activePlayerIdx, db, events);
      else if (state.step === 'combat') beginCombat(state, db, events);
      break;
    }
    case 'drawCards':
      draw(state, action.playerIdx, action.count);
      break;
    case 'powerUp':
      powerUp(state, action.playerIdx, db, events);
      break;
    case 'setStage':
      setStage(state, action.personalityUid, action.stageIndex, db, events);
      break;
    case 'setAnger':
      setAnger(state, action.personalityUid, action.anger, db, events);
      break;
    case 'playAlly': {
      const p = state.players[action.playerIdx];
      const loc = findInstance(state, action.cardUid);
      const per = loc && p ? db.personality(p.zones[loc.zone][loc.idx]?.cardId ?? '') : undefined;
      if (!p || !loc || !per) return fail(prev, 'cannot play ally');
      const inst = p.zones[loc.zone].splice(loc.idx, 1)[0]!;
      const ratings = per.powerRatings.length ? per.powerRatings : [0];
      const stageIndex = Math.min(per.zeroStageIndex + START_ALLY_STAGES_ABOVE_ZERO, ratings.length - 1);
      const ally: PersonalityInPlay = {
        uid: `ally-${inst.uid}`,
        personalityName: per.personalityName,
        alignment: per.alignment,
        levelCardIds: [inst.cardId],
        currentLevel: per.level,
        stageIndex,
        currentRating: ratings[stageIndex]!,
        anger: 0,
        isAlly: true,
      };
      p.allies.push(ally);
      state.log.push(`${p.name} plays Ally ${per.personalityName}.`);
      break;
    }
    case 'moveCard': {
      const loc = findInstance(state, action.cardUid);
      if (!loc) return fail(prev, 'card not found');
      const inst = state.players[loc.playerIdx]!.zones[loc.zone].splice(loc.idx, 1)[0]!;
      state.players[action.toPlayerIdx ?? loc.playerIdx]!.zones[action.toZone].push(inst);
      break;
    }
    // ---- Combat ----
    case 'declareAttack': {
      let ability;
      if (action.cardUid) {
        const loc = findInstance(state, action.cardUid);
        const cardId = loc ? state.players[loc.playerIdx]!.zones[loc.zone][loc.idx]?.cardId : undefined;
        ability = firstAttackAbility(cardId ? db.get(cardId) : undefined);
      }
      err = declareAttack(state, action.attackType, action.cardUid, ctx, db, events, ability);
      break;
    }
    case 'declareEmpower':
      err = declareEmpower(state, action.amount, ctx);
      break;
    case 'defend':
      err = resolveDefense(state, { ...(action.cardUid ? { cardUid: action.cardUid } : {}), ...(action.takeDamage ? { takeDamage: action.takeDamage } : {}) }, ctx, db, events);
      break;
    case 'redirectDamage':
      err = redirectDamage(state, action.toPersonalityUid, ctx, db, events);
      break;
    case 'takeControlOfCombat':
      err = takeControlOfCombat(state, action.personalityUid, ctx, events);
      break;
    case 'pass':
      err = passPhase(state, ctx, events);
      break;
    case 'answerPrompt': {
      const type = state.pendingPrompt?.type;
      const choice = action.choice as { cardUid?: string; takeDamage?: boolean; toUid?: string | null } | string | null;
      if (type === 'defend') {
        const c = (typeof choice === 'object' && choice) || {};
        err = resolveDefense(state, c, ctx, db, events);
      } else if (type === 'redirect') {
        const toUid = typeof choice === 'string' ? choice : (choice as { toUid?: string | null })?.toUid ?? null;
        err = redirectDamage(state, toUid, ctx, db, events);
      } else {
        err = `unhandled prompt '${type}'`;
      }
      break;
    }
    case 'concede': {
      const winner = (action.playerIdx + 1) % state.players.length;
      state.phase = 'ended';
      state.winnerIdx = winner;
      state.victoryType = 'concede';
      events.push({ type: 'gameEnded', winnerIdx: winner, victoryType: 'concede' });
      break;
    }
    case 'chat':
      state.log.push(`${state.players[action.playerIdx]?.name ?? '?'}: ${action.text}`);
      break;
    case 'useEndurance':
    case 'captureDragonBall':
    case 'loadDeck':
    case 'setReady':
    case 'chooseFirstPlayer':
      return fail(prev, `action '${action.type}' not yet implemented`);
    default: {
      const _exhaustive: never = action;
      return fail(prev, `unknown action ${(_exhaustive as Action).type}`);
    }
  }

  if (err) return fail(prev, err);
  return { state, events };
}

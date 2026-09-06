/**
 * Authoritative reducer: reduce(state, action, db, actingPlayerIdx?) -> { state, events, error? }.
 * Pure: clones the input state, never mutates it. Combat is delegated to combat.ts.
 * `actingPlayerIdx` is who sent the action (the server knows). If omitted, the
 * expected actor is inferred so tests can call without it.
 */
import type { Action, CardInstance, GameEvent, GameState, PersonalityInPlay, Zone } from '@dbz/shared';
import { ZONES } from '@dbz/shared';
import type { CardDb } from './loader.js';
import { advanceStep, draw, DRAW_PER_TURN, powerUp, setAnger, setStage } from './turn.js';
import {
  beginCombat,
  declareAttack,
  declareEmpower,
  passPhase,
  redirectDamage,
  resolveCapture,
  resolveEndurance,
  resolveControlOfCombat,
  resolveDefense,
  takeControlOfCombat,
  type CombatCtx,
} from './combat.js';
import { firstAttackAbility } from './abilities.js';
import { checkVictory } from './victory.js';
import { maxAllyLevel, playCard } from './noncombat.js';
import {
  openDeclarePrompt,
  openDiscardPrompt,
  openRejuvenationPrompt,
  resolveDeclareCombat,
  resolveDiscard,
  resolveRejuvenation,
} from './turnsteps.js';

const clone = <T>(x: T): T => structuredClone(x);
/** Zones whose contents redaction hides from the other player. */
const HIDDEN_ZONES = new Set<Zone>(['hand', 'lifeDeck', 'sensei']);
const CHAT_MAX = 500;
/** The whole log ships to both clients on every action, so it cannot grow forever. */
const LOG_MAX = 500;
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

/**
 * What entering a step does on its own, with no action from anyone. Factored
 * out because two paths reach it: advancing normally, and answering the
 * Declare Step's prompt, which moves the turn on immediately rather than
 * making the attacker press "next step" a second time to act on their own
 * decision.
 */
function applyStepEntry(state: GameState, db: CardDb, events: GameEvent[]): void {
  switch (state.step) {
    case 'draw':
      draw(state, state.activePlayerIdx, DRAW_PER_TURN);
      break;
    case 'powerUp':
      // Entering the step powers you up automatically. Claim the once-per-turn
      // flag here too: only the manual `powerUp` action used to set it, so the
      // guard on that action let one MORE full power-up through, and the client
      // renders exactly that button in exactly this step. Every MP was climbing
      // 2x its PUR and every Ally 2 stages instead of 1, every turn.
      powerUp(state, state.activePlayerIdx, db, events);
      state.poweredUpThisTurn = true;
      break;
    case 'declare':
      openDeclarePrompt(state);
      break;
    case 'combat':
      beginCombat(state, db, events);
      break;
    case 'discard':
      openDiscardPrompt(state, state.activePlayerIdx, db);
      break;
    case 'rejuvenation':
      openRejuvenationPrompt(state);
      break;
    default:
      break;
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
  /** Set when this action advanced an MP by anger (Most Powerful check). */
  let advancedByAnger: string | undefined;
  switch (action.type) {
    case 'advanceStep': {
      // Combat ends when the players end it (both pass, or a Final Physical
      // Attack), not when the attacker feels like leaving. Unguarded, the
      // attacker advanced straight from 'combat' to 'discard' and the defender
      // never got the Attack Phase the CRD guarantees them. endCombatStep
      // deletes state.combat before advancing, so the real exit still works.
      if (state.step === 'combat' && state.combat) {
        err = 'finish the Combat Step first — both players must pass';
        break;
      }
      // A step cannot be walked past while someone owes an answer — otherwise
      // the Discard and Rejuvenation prompts are advisory and the attacker can
      // simply step over their own hand limit.
      if (state.pendingPrompt) {
        err = 'answer the pending prompt first';
        break;
      }
      advanceStep(state, events);
      applyStepEntry(state, db, events);
      break;
    }
    case 'drawCards':
      // Unvalidated, this drew any number of cards for your own seat at any
      // moment — including during the opponent's turn — and authorize() waved
      // it through because the seat matched. The Draw Step deals its own cards
      // (DRAW_PER_TURN); this action is the manual assist, so it is bounded and
      // restricted to the player whose turn it is.
      if (action.playerIdx !== actor) err = 'you may only draw for yourself';
      else if (action.playerIdx !== state.activePlayerIdx) err = 'you may only draw on your own turn';
      else if (!Number.isInteger(action.count) || action.count < 1 || action.count > DRAW_PER_TURN) {
        err = `you may draw 1 to ${DRAW_PER_TURN} cards`;
      } else draw(state, action.playerIdx, action.count);
      break;
    case 'powerUp':
      // Entering the Power-Up Step already powers you up. Leaving this action
      // unguarded let it be replayed any number of times, so every MP sat at
      // its top power stage every turn and attrition — the core of the game —
      // stopped mattering. Once per Power-Up Step, by the player whose step it
      // is (CRD ~L229).
      if (state.step !== 'powerUp') {
        err = 'you may only power up during your Power-Up Step';
      } else if (action.playerIdx !== state.activePlayerIdx || action.playerIdx !== actor) {
        err = 'only the active player powers up';
      } else if (state.poweredUpThisTurn) {
        err = 'you have already powered up this turn';
      } else {
        powerUp(state, action.playerIdx, db, events);
        state.poweredUpThisTurn = true;
      }
      break;
    case 'setStage':
      // A non-numeric stageIndex reached Math.max(0, Math.min(x, n)) as NaN and
      // stuck: currentRating went undefined, every later PAT lookup was poisoned,
      // `stageIndex > MP_DOWN_STAGES` became permanently false so the MP could
      // never be "down", and no normal play could recover it. Cross-seat
      // targeting stays allowed — that is the documented tabletop assist.
      if (!Number.isInteger(action.stageIndex) || action.stageIndex < 0) {
        err = 'stage must be a whole number';
      } else setStage(state, action.personalityUid, action.stageIndex, db, events);
      break;
    case 'setAnger':
      advancedByAnger = setAnger(state, action.personalityUid, action.anger, db, events);
      break;
    case 'playCard':
      err = playCard(state, action.playerIdx, action.cardUid, db, events);
      break;
    case 'playAlly': {
      const p = state.players[action.playerIdx];
      if (!p) return fail(prev, 'cannot play ally');
      // Allies enter during YOUR Non-Combat Step, from YOUR hand (CRD ~L216).
      // None of that was checked: findInstance searches every zone of both
      // players, so either player could field an Ally at any moment, out of
      // the opponent's hand or straight from a discard pile.
      if (action.playerIdx !== actor) return fail(prev, 'you may only play your own Allies');
      if (state.activePlayerIdx !== action.playerIdx) return fail(prev, 'only the active player may play an Ally');
      if (state.step !== 'nonCombat') return fail(prev, 'Allies enter play during the Non-Combat Step');
      const idx = p.zones.hand.findIndex((c: CardInstance) => c.uid === action.cardUid);
      if (idx === -1) return fail(prev, 'that card is not in your hand');
      const loc = { playerIdx: action.playerIdx, zone: 'hand' as const, idx };
      const per = db.personality(p.zones.hand[idx]?.cardId ?? '');
      if (!per) return fail(prev, 'cannot play ally');
      // An Ally may not out-level your Main Personality (CRD ~L544).
      if (per.level > maxAllyLevel(state, action.playerIdx)) {
        return fail(prev, `a level ${per.level} Ally needs a level ${per.level} Main Personality`);
      }
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
      // This is the tabletop-assist fallback for effects the engine cannot
      // resolve yet, so it is deliberately permissive about WHOSE card moves.
      // It was permissive about everything else too, and none of that was
      // deliberate:
      //  - an unknown toZone or out-of-range toPlayerIdx threw a TypeError that
      //    escaped the bare ws listener and killed the process, taking every
      //    other game in it down with one malformed message;
      //  - moving a card out of an opponent's HIDDEN zone defeated redaction,
      //    which preserves real uids on cards it hides. One message at a time
      //    revealed their hand and Life Deck; a loop won the game by Survival.
      // Assist means moving a card both players can already see.
      const loc = findInstance(state, action.cardUid);
      if (!loc) return fail(prev, 'card not found');
      if (!ZONES.includes(action.toZone)) return fail(prev, `unknown zone '${action.toZone}'`);
      const toPlayer = action.toPlayerIdx ?? loc.playerIdx;
      if (!Number.isInteger(toPlayer) || !state.players[toPlayer]) {
        return fail(prev, 'unknown player');
      }
      if (loc.playerIdx !== actor && HIDDEN_ZONES.has(loc.zone)) {
        return fail(prev, "cannot move a card out of an opponent's hidden zone");
      }
      const inst = state.players[loc.playerIdx]!.zones[loc.zone].splice(loc.idx, 1)[0]!;
      state.players[toPlayer]!.zones[action.toZone].push(inst);
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
    case 'declareCombat':
      err = resolveDeclareCombat(state, action.declare, ctx);
      // The decision IS the step's work, so acting on it here saves the
      // attacker pressing "next step" to enact their own answer. advanceStep
      // routes a declined Combat straight to the Discard Step.
      if (!err) {
        advanceStep(state, events);
        applyStepEntry(state, db, events);
      }
      break;
    case 'pass':
      err = passPhase(state, ctx, events);
      break;
    case 'answerPrompt': {
      // Answer the prompt you were SHOWN, not whatever is pending now. One
      // action can close a prompt and immediately open the next one for the
      // same player (resolveDefense -> resolveLifeCardDamage opens the
      // Endurance prompt), so a double-clicked button sent its second answer
      // into a question the player had not read yet: it silently spent their
      // Endurance card and forfeited the prevention. promptId was already on
      // the wire and in the Prompt; nothing compared them.
      if (state.pendingPrompt && action.promptId && action.promptId !== state.pendingPrompt.id) {
        return fail(prev, 'that prompt has already been answered');
      }
      const type = state.pendingPrompt?.type;
      const choice = action.choice as { cardUid?: string; takeDamage?: boolean; toUid?: string | null } | string | null;
      if (type === 'defend') {
        const c = (typeof choice === 'object' && choice) || {};
        err = resolveDefense(state, c, ctx, db, events);
      } else if (type === 'endurance') {
        const use = (choice as unknown) === true || (typeof choice === 'object' && choice !== null && (choice as { use?: boolean }).use === true);
        err = resolveEndurance(state, use, ctx, db, events);
      } else if (type === 'capture') {
        const uid = typeof choice === 'string' ? choice : (choice as { uid?: string | null })?.uid ?? null;
        err = resolveCapture(state, uid, ctx, db, events);
      } else if (type === 'redirect') {
        const toUid = typeof choice === 'string' ? choice : (choice as { toUid?: string | null })?.toUid ?? null;
        err = redirectDamage(state, toUid, ctx, db, events);
      } else if (type === 'controlOfCombat') {
        const uid = typeof choice === 'string' ? choice : (choice as { uid?: string | null })?.uid ?? null;
        err = resolveControlOfCombat(state, uid, ctx, events);
      } else if (type === 'declareCombat') {
        const declare = (choice as unknown) === true || (typeof choice === 'object' && choice !== null && (choice as { declare?: boolean }).declare === true);
        err = resolveDeclareCombat(state, declare, ctx);
        if (!err) {
          advanceStep(state, events);
          applyStepEntry(state, db, events);
        }
      } else if (type === 'discard') {
        // null / no choice keeps nothing, which the CRD allows outright.
        const uid = typeof choice === 'string' ? choice : (choice as { uid?: string | null })?.uid ?? null;
        err = resolveDiscard(state, uid, ctx, db);
      } else if (type === 'rejuvenate') {
        const take = (choice as unknown) === true || (typeof choice === 'object' && choice !== null && (choice as { take?: boolean }).take === true);
        err = resolveRejuvenation(state, take, ctx);
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
    case 'chat': {
      // The log is re-serialised to every client on every action, so unbounded
      // chat text (and an unbounded log) is a payload both players pay for on
      // every single message for the rest of the game.
      const text = typeof action.text === 'string' ? action.text.slice(0, CHAT_MAX) : '';
      if (text.trim().length === 0) break;
      state.log.push(`${state.players[action.playerIdx]?.name ?? '?'}: ${text}`);
      break;
    }
    case 'captureDragonBall': {
      // Direct capture (card effects). The 5+ life-card capture goes through
      // the combat prompt instead; both defer a 7th-ball win identically.
      err = resolveCapture(state, action.ballUid, ctx, db, events);
      break;
    }
    case 'useEndurance': {
      err = resolveEndurance(state, true, ctx, db, events);
      break;
    }
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

  // Central victory check. Every action funnels through here, so a life card
  // removed by any route — combat damage, a card effect, a discard — is caught
  // by the same rule rather than at each damage site.
  // Anger can advance an MP from anywhere — a defense card's rider, an attack's
  // secondary effect, a Non-Combat card — and only the explicit `setAnger`
  // action was reporting it. Every other route reached the highest level and
  // the Most Powerful victory was simply never checked. The event carries the
  // signal now, so any path that advances by anger is seen.
  const angerAdvance = events.find((e) => e.type === 'personalityAdvanced' && e.byAnger);
  const byAngerUid = advancedByAnger ?? (angerAdvance?.type === 'personalityAdvanced' ? angerAdvance.personalityUid : undefined);
  checkVictory(state, db, events, byAngerUid ? { advancedByAngerUid: byAngerUid } : {});

  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);

  return { state, events };
}

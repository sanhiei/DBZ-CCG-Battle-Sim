/**
 * Combat Step resolution (the Battle Sequence, CRD ~L273-L364).
 *
 * Attack Phases ALTERNATE: attacker gets the first, then defender, then attacker,
 * ... until both pass back-to-back. Each function MUTATES state and pushes events.
 * Physical Base Damage uses the PAT; energy attacks are a flat 4 life cards.
 *
 * Modeled: prepare-phase draw, physical/energy attacks, Empower, defend (stop vs
 * take damage), power-stage vs life-card damage, redirect of power-stage damage,
 * survival loss, pass/consecutive-pass end. Not yet: Endurance, Defense Shields,
 * Final Physical Attack, Dragon Ball capture, "if successful" chains, most card
 * abilities (these layer on with card coverage).
 */
import type {
  Ability,
  AttackType,
  GameEvent,
  GameState,
  PersonalityInPlay,
  PlayerState,
  Prompt,
} from '@dbz/shared';
import type { CardDb } from './loader.js';
import { computeBaseDamage } from './pat.js';
import { advanceStep, draw, syncRating } from './turn.js';
import { applyIfSuccessful, attackKindOf, setupAttackAbility } from './abilities.js';
import {
  canUseEndurance,
  capturableBalls,
  captureBall,
  discardForDamage,
  discardForDamageWithEndurance,
  spendEndurance,
  type EnduranceOffer,
  LIFE_CARD_CAPTURE_THRESHOLD,
  type DamageResult,
} from './damage.js';
import { deferDragonVictory, DRAGON_BALL_SET_SIZE } from './victory.js';

const PREPARE_DRAW = 3;
const ENERGY_STAGE_COST = 2;
const ENERGY_LIFE_CARDS = 4;
const DRAGON_BALL_CAPTURE_LIFE = 5;

let promptSeq = 0;
function newPrompt(playerIdx: number, type: string, message: string, extra: Partial<Prompt> = {}): Prompt {
  promptSeq += 1;
  return { id: `p${promptSeq}`, playerIdx, type, message, ...extra };
}

export function controllerOf(player: PlayerState): PersonalityInPlay {
  return player.allies.find((a) => a.inControlOfCombat) ?? player.mp;
}

function other(state: GameState, idx: number): number {
  return (idx + 1) % state.players.length;
}

/** Enter the Combat Step: run the Prepare Phase and open the first Attack Phase. */
export function beginCombat(state: GameState, db: CardDb, events: GameEvent[]): void {
  const attacker = state.activePlayerIdx;
  const defender = other(state, attacker);
  // Defender's half of the Prepare Phase: draw 3.
  draw(state, defender, PREPARE_DRAW);
  state.combat = {
    attackerPlayerIdx: attacker,
    defenderPlayerIdx: defender,
    phasePlayerIdx: attacker, // attacker gets the first Attack Phase
    consecutivePasses: 0,
    finalUsed: [],
  };
  state.log.push(`Combat begins — ${state.players[defender]!.name} draws ${PREPARE_DRAW}.`);
}

function loseStages(p: PersonalityInPlay, n: number, db: CardDb, events: GameEvent[]): void {
  const from = p.stageIndex;
  p.stageIndex = Math.max(0, p.stageIndex - n);
  syncRating(p, db);
  if (p.stageIndex !== from) {
    events.push({ type: 'stageChanged', personalityUid: p.uid, from, to: p.stageIndex });
  }
}

/**
 * Life cards of damage. Dragon Balls in the deck are skipped and cycled to the
 * bottom (CRD ~L699), so this can come up short even with cards remaining —
 * that is the Dragon Ball Loop and it loses the game.
 */
function takeLifeCards(state: GameState, playerIdx: number, n: number, db: CardDb): DamageResult {
  return discardForDamage(state, playerIdx, n, db);
}

function endGame(state: GameState, winnerIdx: number, events: GameEvent[]): void {
  state.phase = 'ended';
  state.winnerIdx = winnerIdx;
  state.victoryType = 'survival';
  events.push({ type: 'gameEnded', winnerIdx, victoryType: 'survival' });
  state.log.push(`${state.players[winnerIdx]?.name} wins by Survival!`);
}

/** Switch to the next Attack Phase (the other player). Clears any current attack. */
function nextAttackPhase(state: GameState, events: GameEvent[]): void {
  const c = state.combat!;
  delete c.currentAttack;
  delete state.pendingPrompt;
  c.phasePlayerIdx = other(state, c.phasePlayerIdx);
}

/** End the Combat Step (both passed) -> Discard Step. */
function endCombatStep(state: GameState, events: GameEvent[]): void {
  delete state.combat;
  delete state.pendingPrompt;
  advanceStep(state, events); // combat -> discard
}

export interface CombatCtx {
  actingPlayerIdx: number;
}

/** Attacker declares a physical or energy attack in their Attack Phase. */
export function declareAttack(
  state: GameState,
  attackType: AttackType,
  cardUid: string | undefined,
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
  ability?: Ability,
): string | undefined {
  const c = state.combat;
  if (!c) return 'not in combat';
  if (state.pendingPrompt) return 'resolve the current prompt first';
  if (c.currentAttack) return 'an attack is already in progress';
  if (ctx.actingPlayerIdx !== c.phasePlayerIdx) return 'not your Attack Phase';
  if (c.finalUsed.includes(ctx.actingPlayerIdx)) return 'you must pass after a Final Physical Attack';

  const attackerIdx = c.phasePlayerIdx;
  const defenderIdx = other(state, attackerIdx);
  const attCtl = controllerOf(state.players[attackerIdx]!);
  const defCtl = controllerOf(state.players[defenderIdx]!);
  const kind: AttackType = (ability && attackKindOf(ability)) ?? attackType;

  c.consecutivePasses = 0;
  const attack = {
    attackerPlayerIdx: attackerIdx,
    defenderPlayerIdx: defenderIdx,
    attackerControllerUid: attCtl.uid,
    defenderControllerUid: defCtl.uid,
    ...(cardUid ? { cardUid } : {}),
    attackType: kind,
    stopped: false,
    successful: false,
    resolutionStep: 5,
  } as NonNullable<GameState['combat']>['currentAttack'] & object;

  // Ability runs its secondary effects (anger) and records damage modifiers.
  if (ability) setupAttackAbility(state, ability, attackerIdx, defenderIdx, attack, db, events);

  // Pay the energy cost (ability may override; default 2 power stages).
  if (kind === 'energy') {
    loseStages(attCtl, ability?.cost?.powerStages ?? ENERGY_STAGE_COST, db, events);
  } else if (ability?.cost?.powerStages) {
    loseStages(attCtl, ability.cost.powerStages, db, events);
  }

  // Physical base = PAT unless the ability set an explicit fixed base.
  if (kind === 'physical' && attack.baseDamage === undefined && attack.damageLifeCards === undefined) {
    attack.baseDamage = computeBaseDamage(attCtl.currentRating, defCtl.currentRating);
  }

  c.currentAttack = attack;
  events.push({ type: 'attackDeclared', attackType: kind });
  state.pendingPrompt = newPrompt(
    defenderIdx,
    'defend',
    `Defend the ${kind} attack, or take the damage.`,
    { optional: true },
  );
  return undefined;
}

/** Attacker announces an Empower boost before the attack resolves. */
export function declareEmpower(state: GameState, amount: number, ctx: CombatCtx): string | undefined {
  const atk = state.combat?.currentAttack;
  if (!atk) return 'no attack in progress';
  if (ctx.actingPlayerIdx !== atk.attackerPlayerIdx) return 'only the attacker can Empower';
  atk.empower = Math.max(0, amount);
  return undefined;
}

/** Discard the attack card (battle sequence step 16) and any named defense card. */
function discardAttackCards(state: GameState, atk: NonNullable<GameState['combat']>['currentAttack'], defenseCardUid?: string): void {
  // (Card instances live in hand/inPlay; a full impl moves them. Provisional: log only.)
}

function redirectTargets(state: GameState, defenderIdx: number, controllerUid: string): PersonalityInPlay[] {
  const p = state.players[defenderIdx]!;
  return [p.mp, ...p.allies].filter((per) => per.uid !== controllerUid);
}

/** Apply the finalized power-stage damage to a chosen personality and finish the attack. */
function applyPowerStageDamage(state: GameState, personalityUid: string, db: CardDb, events: GameEvent[]): void {
  const c = state.combat!;
  const atk = c.currentAttack!;
  const target = [state.players[atk.defenderPlayerIdx]!.mp, ...state.players[atk.defenderPlayerIdx]!.allies].find(
    (p) => p.uid === personalityUid,
  );
  const dmg = atk.pendingPowerStageDamage ?? 0;
  if (target) loseStages(target, dmg, db, events);
  events.push({ type: 'attackResolved', successful: true, powerStages: dmg, lifeCards: 0 });
  applyIfSuccessful(state, atk.ifSuccessfulEffects, db, events);
  nextAttackPhase(state, events);
}

/** Defender resolves the attack: defend with a card (stop) or take the damage. */
export function resolveDefense(
  state: GameState,
  opts: { cardUid?: string; takeDamage?: boolean },
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const c = state.combat;
  const atk = c?.currentAttack;
  if (!c || !atk) return 'no attack to defend';
  if (ctx.actingPlayerIdx !== atk.defenderPlayerIdx) return 'only the defender may respond';
  if (c.finalUsed.includes(ctx.actingPlayerIdx)) return 'you cannot defend after a Final Physical Attack';

  if (opts.cardUid && !opts.takeDamage) {
    // Provisional: any offered defense card stops the attack (starburst check = coverage TODO).
    atk.stopped = true;
    discardAttackCards(state, atk, opts.cardUid);
    events.push({ type: 'attackResolved', successful: false, powerStages: 0, lifeCards: 0 });
    state.log.push(`${state.players[atk.defenderPlayerIdx]!.name} stops the attack.`);
    nextAttackPhase(state, events);
    return undefined;
  }

  // Take the damage -> attack is successful.
  atk.successful = true;
  discardAttackCards(state, atk);

  // Life-card damage: energy attacks, or a physical attack that states a fixed
  // life-card amount ("causing 1 life card of damage").
  const lifeCards =
    atk.attackType === 'energy'
      ? atk.energyLifeCards ?? ENERGY_LIFE_CARDS
      : atk.damageLifeCards; // physical fixed life cards, else undefined -> power stages
  if (lifeCards !== undefined) {
    dealLifeCardsAndFinish(state, atk, lifeCards, db, events);
    return undefined;
  }

  // Otherwise physical power-stage damage from the PAT (+ modifiers).
  const total =
    (atk.baseDamage ?? 0) + (atk.empower ?? 0) + (atk.modifiers ?? 0) + (atk.ifSuccessfulStages ?? 0);
  atk.pendingPowerStageDamage = total;
  // Offer redirect to a personality not in control of combat (CRD ~L576).
  const targets = redirectTargets(state, atk.defenderPlayerIdx, atk.defenderControllerUid);
  if (total > 0 && targets.length > 0) {
    state.pendingPrompt = newPrompt(
      atk.defenderPlayerIdx,
      'redirect',
      `Redirect ${total} power stage(s) of damage to another personality, or take it on your controller.`,
      { optional: true, options: targets.map((t) => ({ uid: t.uid, name: t.personalityName })) },
    );
    return undefined;
  }
  applyPowerStageDamage(state, atk.defenderControllerUid, db, events);
  return undefined;
}

/** Deal `n` life cards to the defender, run if-successful effects, finish the attack. */
function dealLifeCardsAndFinish(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  n: number,
  db: CardDb,
  events: GameEvent[],
): void {
  atk.pendingLifeCardDamage = n;
  resolveLifeCardDamage(state, atk, db, events);
}

/**
 * Deal the life-card damage still owed on `atk`, pausing whenever the defender
 * is offered Endurance. Re-entered after each Endurance answer until the debt
 * is paid, the deck cannot pay it, or the attack finishes.
 */
function resolveLifeCardDamage(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  db: CardDb,
  events: GameEvent[],
): void {
  const owed = atk.pendingLifeCardDamage ?? 0;
  const result = discardForDamageWithEndurance(state, atk.defenderPlayerIdx, owed, db);
  atk.pendingLifeCardDamage = owed - result.discarded;
  atk.lifeCardsDealt = (atk.lifeCardsDealt ?? 0) + result.discarded;

  if (result.dragonBallsSkipped > 0) {
    state.log.push(
      `${result.dragonBallsSkipped} Dragon Ball(s) uncovered — they do not count as damage and return to the bottom of the Life Deck.`,
    );
  }

  if (result.offer) {
    atk.enduranceOffer = result.offer;
    state.pendingPrompt = newPrompt(
      atk.defenderPlayerIdx,
      'endurance',
      `Use Endurance ${result.offer.value} from ${db.get(result.offer.cardId)?.name ?? 'this card'} to prevent ${result.offer.value} life card(s)?`,
      { optional: true },
    );
    return;
  }

  delete atk.enduranceOffer;
  const dealt = atk.lifeCardsDealt ?? 0;
  events.push({ type: 'attackResolved', successful: true, powerStages: 0, lifeCards: dealt });
  applyIfSuccessful(state, atk.ifSuccessfulEffects, db, events);

  if (result.exhausted) {
    endGame(state, atk.attackerPlayerIdx, events);
    return;
  }

  // CRD ~L685: capture is measured against cards ACTUALLY discarded, so
  // Endurance that holds the total under 5 also prevents the capture (~L1147).
  const balls = capturableBalls(state, atk.defenderPlayerIdx);
  if (dealt >= LIFE_CARD_CAPTURE_THRESHOLD && balls.length > 0) {
    state.pendingPrompt = newPrompt(
      atk.attackerPlayerIdx,
      'capture',
      `${dealt} life cards of damage — capture one of your opponent's Dragon Balls?`,
      {
        optional: true,
        options: balls.map((b) => ({ uid: b.uid, name: db.get(b.cardId)?.name ?? 'Dragon Ball' })),
      },
    );
    return;
  }

  nextAttackPhase(state, events);
}

/**
 * Answer the Endurance prompt. `use` false declines and the card is discarded
 * as ordinary damage.
 */
export function resolveEndurance(
  state: GameState,
  use: boolean,
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const atk = state.combat?.currentAttack;
  const offer = atk?.enduranceOffer;
  if (!atk || !offer) return 'no Endurance offered';
  if (ctx.actingPlayerIdx !== atk.defenderPlayerIdx) return 'only the defender may use Endurance';

  delete state.pendingPrompt;
  delete atk.enduranceOffer;

  if (use) {
    atk.pendingLifeCardDamage = spendEndurance(state, atk.defenderPlayerIdx, offer);
  } else {
    // Declined: it is just another life card of damage.
    const player = state.players[atk.defenderPlayerIdx]!;
    const at = player.zones.lifeDeck.findIndex((c) => c.uid === offer.uid);
    if (at !== -1) {
      const [card] = player.zones.lifeDeck.splice(at, 1);
      player.zones.discard.push({ ...card!, faceDown: false });
      atk.lifeCardsDealt = (atk.lifeCardsDealt ?? 0) + 1;
      atk.pendingLifeCardDamage = Math.max(0, offer.remaining - 1);
    }
  }

  resolveLifeCardDamage(state, atk, db, events);
  return undefined;
}
/**
 * Answer the Dragon Ball capture prompt. `ballUid` of null declines.
 *
 * Capturing the 7th ball of a set does NOT win immediately — the CRD makes the
 * capturer hold it until the start of their next turn, so the claim is deferred.
 */
export function resolveCapture(
  state: GameState,
  ballUid: string | null,
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const atk = state.combat?.currentAttack;
  if (!atk) return 'no attack in progress';
  if (ctx.actingPlayerIdx !== atk.attackerPlayerIdx) return 'only the attacker may capture';

  if (ballUid) {
    if (!captureBall(state, atk.defenderPlayerIdx, atk.attackerPlayerIdx, ballUid)) {
      return 'that Dragon Ball is not available to capture';
    }
    const held = state.players[atk.attackerPlayerIdx]!.dragonBalls;
    const bySet = new Map<string, Set<string>>();
    for (const b of held) {
      const card = db.get(b.cardId);
      if (!card) continue;
      const set = card.saga || 'unknown';
      const seen = bySet.get(set) ?? new Set<string>();
      seen.add(String(card.number ?? card.name));
      bySet.set(set, seen);
    }
    for (const seen of bySet.values()) {
      if (seen.size >= DRAGON_BALL_SET_SIZE) {
        deferDragonVictory(state, atk.attackerPlayerIdx);
        break;
      }
    }
  }

  delete state.pendingPrompt;
  nextAttackPhase(state, events);
  return undefined;
}

/** Answer the redirect prompt: send the pending power-stage damage to a personality. */
export function redirectDamage(state: GameState, toUid: string | null, ctx: CombatCtx, db: CardDb, events: GameEvent[]): string | undefined {
  const atk = state.combat?.currentAttack;
  if (!atk || !state.pendingPrompt || state.pendingPrompt.type !== 'redirect') return 'no redirect pending';
  if (ctx.actingPlayerIdx !== atk.defenderPlayerIdx) return 'only the defender may redirect';
  const target = toUid ?? atk.defenderControllerUid; // null = take it on the controller
  applyPowerStageDamage(state, target, db, events);
  return undefined;
}

/** An Ally takes Control of Combat (MP must be at its bottom 2 stages). */
export function takeControlOfCombat(state: GameState, personalityUid: string, ctx: CombatCtx, events: GameEvent[]): string | undefined {
  const player = state.players[ctx.actingPlayerIdx];
  if (!player) return 'bad player';
  const ally = player.allies.find((a) => a.uid === personalityUid);
  if (!ally) return 'not your ally';
  if (player.mp.stageIndex > 1) return 'MP must be at its bottom 2 power stages';
  for (const a of player.allies) delete a.inControlOfCombat;
  ally.inControlOfCombat = true;
  state.log.push(`${player.name}: ${ally.personalityName} takes control of Combat.`);
  return undefined;
}

/** Pass an Attack Phase. Two consecutive passes end the Combat Step. */
export function passPhase(state: GameState, ctx: CombatCtx, events: GameEvent[]): string | undefined {
  const c = state.combat;
  if (!c) return 'not in combat';
  if (state.pendingPrompt) return 'resolve the current prompt first';
  if (ctx.actingPlayerIdx !== c.phasePlayerIdx) return 'not your Attack Phase';
  c.consecutivePasses += 1;
  if (c.consecutivePasses >= 2) {
    endCombatStep(state, events);
  } else {
    c.phasePlayerIdx = other(state, c.phasePlayerIdx);
  }
  return undefined;
}

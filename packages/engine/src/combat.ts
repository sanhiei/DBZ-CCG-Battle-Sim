/**
 * Combat Step resolution (the Battle Sequence, CRD ~L273-L364).
 *
 * Attack Phases ALTERNATE: attacker gets the first, then defender, then attacker,
 * ... until both pass back-to-back. Each function MUTATES state and pushes events.
 * Physical Base Damage uses the PAT; energy attacks are a flat 4 life cards.
 *
 * Modeled: prepare-phase draw, physical/energy attacks, Empower, defend (the
 * card is checked: yours, a Combat card, and it stops this attack type),
 * power-stage damage with overflow converting to life cards, redirect,
 * Endurance, Dragon Ball capture, "if successful" chains, spending the attack
 * and defense cards, survival loss, pass/consecutive-pass end.
 *
 * Also modeled: Control of Combat (step 4), Defense Shields from cards in play
 * (step 7), and `resolutionStep` tracking so the UI can show where in the
 * 16-step sequence an attack is.
 *
 * NOT modeled: Final Physical Attack, the Declare step, Defense Shields printed
 * on personalities (they arrive with Personality Powers), and the Personality
 * Capture rule (step 11).
 *
 * Keep this list honest. It previously listed Endurance and Dragon Ball capture
 * as missing long after both were built, while claiming power-stage damage was
 * modeled when overflow was being silently dropped — so it was wrong in both
 * directions at once and could not be trusted either way.
 */
import type {
  Ability,
  AttackType,
  CardInstance,
  Effect,
  GameEvent,
  GameState,
  PersonalityInPlay,
  PlayerState,
  Prompt,
} from '@dbz/shared';
import type { CardDb } from './loader.js';
import { computeBaseDamage } from './pat.js';
import { advanceStep, draw, findPersonality, MP_DOWN_STAGES, releaseControlIfMpRecovered, syncRating } from './turn.js';
import { applyIfSuccessful, applyOnPlay, attackKindOf, setupAttackAbility } from './abilities.js';
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
import { isDrill } from './drills.js';
import { newPrompt } from './prompt.js';

const PREPARE_DRAW = 3;
const ENERGY_STAGE_COST = 2;
const ENERGY_LIFE_CARDS = 4;
const DRAGON_BALL_CAPTURE_LIFE = 5;



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

/**
 * Lower a personality's power stages. Returns the stages it could NOT lose.
 *
 * That remainder is not slack to be thrown away: "when a personality is at 0
 * and is dealt power stages of damage, those power stages are converted into
 * life cards of damage, and is considered both types of damage" (CRD ~L436,
 * ~L422). Clamping at 0 and discarding the excess made a personality at its
 * bottom stage immune to physical damage outright.
 */
function loseStages(p: PersonalityInPlay, n: number, db: CardDb, events: GameEvent[]): number {
  const from = p.stageIndex;
  const taken = Math.min(n, from);
  p.stageIndex = from - taken;
  syncRating(p, db);
  if (p.stageIndex !== from) {
    events.push({ type: 'stageChanged', personalityUid: p.uid, from, to: p.stageIndex });
  }
  return n - taken;
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

/**
 * Run an attack's "if successful" effects, and honour any combat-long stop
 * among them.
 *
 * An attack card can carry a stop of its own ("...and stops all physical
 * attacks for the remainder of Combat"). Those effects reach applyIfSuccessful,
 * which LOGS "Effect: stops a physical attack" and does nothing else — so the
 * log claimed a lockout that never existed. addLockout lives here in combat.ts
 * because lockouts are combat state; applying it from abilities.ts would close
 * an import cycle.
 */
function finishSuccessfulAttack(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  db: CardDb,
  events: GameEvent[],
): void {
  const c = state.combat;
  if (c) {
    // Unlike the defence path, an unscoped `thisCombat` is taken at face value
    // here. These are attack riders — "If successful, also stops an opponent
    // from performing any energy attacks for the remainder of Combat" — and
    // they mean exactly that. The defence path has to be stricter because 17
    // cards there carry the window from a rider that has nothing to do with
    // their stop.
    for (const e of atk.ifSuccessfulEffects ?? []) {
      if (e.kind === 'stopAttack' && e.window === 'thisCombat') {
        addLockout(state, c, atk.defenderPlayerIdx, e.attackType ?? 'any');
      }
    }
  }
  atk.resolutionStep = 15; // "If successful" effects resolve
  applyIfSuccessful(state, atk.ifSuccessfulEffects, db, events, {
    userIdx: atk.attackerPlayerIdx,
    foeIdx: atk.defenderPlayerIdx,
  });
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
  // Combat is over, so no attack can be mid-resolution: safe to hand control
  // back to any MP that has recovered (CRD ~L589).
  for (const p of state.players) releaseControlIfMpRecovered(state, p.idx);
  advanceStep(state, events); // combat -> discard
}

export interface CombatCtx {
  actingPlayerIdx: number;
}

/**
 * Whether `playerIdx` is barred from performing `kind` for the rest of this
 * combat. Returns the blocking lockout's type so the caller can say why.
 */
function lockoutAgainst(
  c: NonNullable<GameState['combat']>,
  playerIdx: number,
  kind: AttackType,
): 'physical' | 'energy' | 'any' | undefined {
  const hit = (c.lockouts ?? []).find(
    (l) => l.playerIdx === playerIdx && (l.attackType === 'any' || l.attackType === kind),
  );
  return hit?.attackType;
}

/**
 * Record a combat-long stop from a defense card. The attacker is the one shut
 * out, and duplicates are collapsed so repeated plays do not pile up.
 */
function addLockout(
  state: GameState,
  c: NonNullable<GameState['combat']>,
  playerIdx: number,
  attackType: 'physical' | 'energy' | 'any',
): void {
  c.lockouts = c.lockouts ?? [];
  if (c.lockouts.some((l) => l.playerIdx === playerIdx && l.attackType === attackType)) return;
  c.lockouts.push({ playerIdx, attackType });
  const what = attackType === 'any' ? 'attacks' : `${attackType} attacks`;
  state.log.push(`${state.players[playerIdx]?.name} cannot perform ${what} for the remainder of Combat.`);
}
/**
 * Use the Personality Power of the personality in Control of Combat
 * (CRD ~L492).
 *
 * This is one of the seven things an Attack Phase may be spent on and it did
 * not exist: no personality carried an ability, no action invoked one, and the
 * `personalityPower` trigger was produced and consumed by nothing. A deck built
 * around a signature power played as a blank body.
 *
 * Once per turn, and only by the personality actually in Control — "You cannot
 * use your MP's power when an Ally is in control of Combat and vice-versa".
 * The once-per-turn mark is a turn NUMBER, not a flag, because advancing or
 * losing a level gives the power back the same turn.
 */
export function usePersonalityPower(
  state: GameState,
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const c = state.combat;
  if (!c) return 'a Personality Power may only be used during the Combat Step';
  if (state.pendingPrompt) return 'resolve the current prompt first';
  if (c.currentAttack) return 'an attack is already in progress';
  if (ctx.actingPlayerIdx !== c.phasePlayerIdx) return 'not your Attack Phase';

  const player = state.players[ctx.actingPlayerIdx];
  if (!player) return 'no such player';
  const controller = controllerOf(player);
  if (controller.usedPowerTurn === state.turnNumber) {
    return `${controller.personalityName} has already used their Personality Power this turn`;
  }

  const cardId = controller.levelCardIds[controller.currentLevel - 1];
  const ability = (cardId ? db.get(cardId)?.rules?.abilities ?? [] : []).find(
    (a) => a.trigger === 'personalityPower',
  );
  if (!ability) return `${controller.personalityName} has no Personality Power the engine can resolve`;

  controller.usedPowerTurn = state.turnNumber;
  const kind = attackKindOf(ability);
  state.log.push(`${player.name}: ${controller.personalityName} uses their Personality Power.`);

  // A power that performs an attack IS the attack for this phase — one of the
  // CRD's listed Attack Phase options, and the only legitimate way to attack
  // without a card now that a bare attack is refused.
  if (kind) {
    return declareAttack(state, kind, undefined, ctx, db, events, ability, { fromPower: true });
  }

  // Otherwise it is a bundle of riders, resolved now, and the phase passes.
  const foeIdx = other(state, ctx.actingPlayerIdx);
  applyOnPlay(state, ctx.actingPlayerIdx, foeIdx, ability.effects, db, events);
  c.consecutivePasses = 0;
  c.phasePlayerIdx = foeIdx;
  return undefined;
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
  opts: { fromPower?: boolean } = {},
): string | undefined {
  const c = state.combat;
  if (!c) return 'not in combat';
  if (state.pendingPrompt) return 'resolve the current prompt first';
  if (c.currentAttack) return 'an attack is already in progress';
  if (ctx.actingPlayerIdx !== c.phasePlayerIdx) return 'not your Attack Phase';
  if (c.finalUsed.includes(ctx.actingPlayerIdx)) return 'you must pass after a Final Physical Attack';
  const locked = lockoutAgainst(c, ctx.actingPlayerIdx, attackType);
  if (locked) return `${locked === 'any' ? 'All attacks' : `${locked} attacks`} are stopped for the remainder of this Combat`;
  // An attack comes FROM something. CRD ~L286-291 lists everything an Attack
  // Phase may be spent on, and every attacking option names a source: play a
  // card from hand that can attack, use a card already in play that can, use a
  // Personality Power, or perform a Final Physical Attack (which pays by
  // discarding a card). "Attack with nothing" is not on the list.
  //
  // Without this an attack cost nothing and nothing ran out, so a Combat Step
  // only ended when both players volunteered to stop. A scripted playthrough
  // declared ~50 free attacks in one Combat Step and emptied a 59-card Life
  // Deck on turn 2 — every game ended by Survival before the second turn.
  // A Personality Power that performs an attack is its own source (~L290), so
  // it is the one attack that legitimately arrives without a card.
  if (!cardUid && !opts.fromPower) {
    return 'an attack needs a card — play one that can attack, use a Personality Power, or perform a Final Physical Attack';
  }
  if (cardUid) {
    const bad = combatCardError(state, ctx.actingPlayerIdx, cardUid, db, 'attack');
    if (bad) return bad;
  }

  const attackerIdx = c.phasePlayerIdx;
  const defenderIdx = other(state, attackerIdx);
  const attCtl = controllerOf(state.players[attackerIdx]!);
  const defCtl = controllerOf(state.players[defenderIdx]!);
  const kind: AttackType = (ability && attackKindOf(ability)) ?? attackType;

  // A cost is compulsory (CRD ~L806), so an attack you cannot pay for is one
  // you may not perform. The cost was being taken with loseStages, which caps
  // at the bottom of the ladder and returns the unpayable remainder — and the
  // remainder was dropped on the floor, so a personality sitting at 0 power
  // stages performed energy attacks free, forever. "Energy attacks that don't
  // have their cost listed always cost 2 power stages" (~L452).
  const stageCost = kind === 'energy' ? ability?.cost?.powerStages ?? ENERGY_STAGE_COST : ability?.cost?.powerStages ?? 0;
  if (stageCost > attCtl.stageIndex) {
    return `${attCtl.personalityName} cannot pay the ${stageCost} power stage cost (only ${attCtl.stageIndex} available)`;
  }

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

  // Pay the cost checked above. It is affordable by construction now, so the
  // remainder loseStages returns is necessarily 0.
  if (stageCost > 0) loseStages(attCtl, stageCost, db, events);


  c.currentAttack = attack;
  events.push({ type: 'attackDeclared', attackType: kind });

  // Step 4 comes before the defence: "If an Ally can take over Combat for the
  // Main Personality, the Defender must announce which personality is in
  // Control of Combat until this attack is resolved" (CRD ~L325). Only ask
  // when there is a real choice to make.
  if (openControlWindow(state, attack, db)) return undefined;
  openDefenceWindow(state, attack, db, events);
  return undefined;
}

/**
 * Final Physical Attack (CRD ~L408) — "a last ditch desperation move".
 *
 * The state and both of its restrictions were already wired up: `finalUsed` was
 * initialised, checked before declaring an attack and checked before defending.
 * Nothing ever wrote to it, so the move could not be performed — and the
 * cardless attack that `declareAttack` used to allow was standing in for it,
 * without the cost or either restriction.
 *
 * Discard any card from hand to pay, then perform a physical attack for PAT
 * damage. Afterwards you must pass every remaining Attack Phase and you cannot
 * defend. Once per Combat Step each.
 */
export function finalPhysicalAttack(
  state: GameState,
  discardUid: string,
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const c = state.combat;
  if (!c) return 'not in combat';
  if (state.pendingPrompt) return 'resolve the current prompt first';
  if (c.currentAttack) return 'an attack is already in progress';
  if (ctx.actingPlayerIdx !== c.phasePlayerIdx) return 'not your Attack Phase';
  if (c.finalUsed.includes(ctx.actingPlayerIdx)) {
    return 'you have already performed a Final Physical Attack this Combat';
  }
  const locked = lockoutAgainst(c, ctx.actingPlayerIdx, 'physical');
  if (locked) return `${locked === 'any' ? 'All attacks' : `${locked} attacks`} are stopped for the remainder of this Combat`;

  const attackerIdx = c.phasePlayerIdx;
  const player = state.players[attackerIdx]!;
  const at = player.zones.hand.findIndex((card: CardInstance) => card.uid === discardUid);
  if (at === -1) return 'discard a card from your hand to pay for a Final Physical Attack';

  const defenderIdx = other(state, attackerIdx);
  const attCtl = controllerOf(player);
  const defCtl = controllerOf(state.players[defenderIdx]!);

  // Pay first: the cost is discarding the card, and it is compulsory.
  const [spent] = player.zones.hand.splice(at, 1);
  if (spent) player.zones.discard.push({ ...spent, faceDown: false });
  c.finalUsed.push(attackerIdx);
  c.consecutivePasses = 0;

  const attack = {
    attackerPlayerIdx: attackerIdx,
    defenderPlayerIdx: defenderIdx,
    attackerControllerUid: attCtl.uid,
    defenderControllerUid: defCtl.uid,
    attackType: 'physical' as AttackType,
    stopped: false,
    successful: false,
    resolutionStep: 5,
  } as NonNullable<GameState['combat']>['currentAttack'] & object;

  c.currentAttack = attack;
  state.log.push(
    `${player.name} performs a Final Physical Attack — they must pass for the rest of Combat and cannot defend.`,
  );
  events.push({ type: 'attackDeclared', attackType: 'physical' });

  if (openControlWindow(state, attack, db)) return undefined;
  openDefenceWindow(state, attack, db, events);
  return undefined;
}

/**
 * Battle-sequence step 4 — the defender names who is in Control of Combat.
 *
 * Returns true when a choice was actually offered. An Ally may only take over
 * while the MP is at its bottom two power stages (CRD ~L589), so with no Ally,
 * or a healthy MP, there is nothing to announce and the sequence goes straight
 * to the defence.
 */
function openControlWindow(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  db: CardDb,
): boolean {
  const defender = state.players[atk.defenderPlayerIdx];
  if (!defender || defender.allies.length === 0) return false;
  if (defender.mp.stageIndex > MP_DOWN_STAGES) return false;

  atk.resolutionStep = 4;
  state.pendingPrompt = newPrompt(
    atk.defenderPlayerIdx,
    'controlOfCombat',
    'Who is in Control of Combat for this attack?',
    {
      options: [
        { uid: defender.mp.uid, name: `${defender.mp.personalityName} (Main Personality)` },
        ...defender.allies.map((a) => ({ uid: a.uid, name: a.personalityName })),
      ],
    },
  );
  return true;
}

/** Battle-sequence step 5 — the defender answers the attack. */
function openDefenceWindow(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  db: CardDb,
  events: GameEvent[],
): void {
  atk.resolutionStep = 5;
  // A player who performed a Final Physical Attack "cannot defend against your
  // opponent's attacks" (~L412). Asking them to anyway produced a prompt only
  // they could answer and every answer was refused — the game wedged there,
  // permanently, with no legal move for either player. There is no decision to
  // offer: the attack simply lands.
  if (state.combat?.finalUsed.includes(atk.defenderPlayerIdx)) {
    state.log.push(
      `${state.players[atk.defenderPlayerIdx]?.name} cannot defend after their Final Physical Attack.`,
    );
    resolveDefense(state, { takeDamage: true }, { actingPlayerIdx: atk.defenderPlayerIdx }, db, events);
    return;
  }
  state.pendingPrompt = newPrompt(
    atk.defenderPlayerIdx,
    'defend',
    `Defend the ${atk.attackType} attack, or take the damage.`,
    { optional: true },
  );
}

/** Answer step 4, then open the defence. */
export function resolveControlOfCombat(
  state: GameState,
  personalityUid: string | null,
  ctx: CombatCtx,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const atk = state.combat?.currentAttack;
  if (!atk || state.pendingPrompt?.type !== 'controlOfCombat') return 'no Control of Combat choice pending';
  if (ctx.actingPlayerIdx !== atk.defenderPlayerIdx) return 'only the defender announces Control of Combat';

  const defender = state.players[atk.defenderPlayerIdx]!;
  if (personalityUid && personalityUid !== defender.mp.uid) {
    const ally = defender.allies.find((a) => a.uid === personalityUid);
    if (!ally) return 'not one of your personalities';
    for (const a of defender.allies) delete a.inControlOfCombat;
    ally.inControlOfCombat = true;
    state.log.push(`${defender.name}: ${ally.personalityName} takes Control of Combat.`);
  } else {
    for (const a of defender.allies) delete a.inControlOfCombat;
    state.log.push(`${defender.name}: ${defender.mp.personalityName} stays in Control of Combat.`);
  }
  // Control decides who the damage lands on, so re-read it now.
  atk.defenderControllerUid = controllerOf(defender).uid;
  openDefenceWindow(state, atk, db, events);
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

/** Card types that may be played during Combat, to attack or to defend. */
const COMBAT_CARD_TYPES = new Set(['Physical Combat', 'Energy Combat', 'Combat']);

/**
 * Battle-sequence step 7 — Defense Shields on cards already in play.
 *
 * "If the attack was not stopped, the defender MUST now activate any Defense
 * Shields from his cards in play" (CRD ~L337). Mandatory, so there is no prompt
 * to make: it fires or it does not. This window did not exist at all, so 23
 * Non-Combat cards printing "Defense Shield: stops the first unstopped attack"
 * sat in play doing nothing all game.
 *
 * Each shield stops the FIRST unstopped attack of its type this combat, so a
 * spent one is recorded and not offered again. Returns true when the attack is
 * stopped.
 */
function activateDefenseShields(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  c: NonNullable<GameState['combat']>,
  db: CardDb,
  events: GameEvent[],
): boolean {
  const defender = state.players[atk.defenderPlayerIdx];
  if (!defender) return false;

  // The personality in Control is a shield source too. This scanned only
  // zones.inPlay, so the Defense Shields printed on personality cards — Android
  // 18, Android 16, Vegeta Ascendant — never fired at all, and CRD defence
  // option 3 ("use an effect from your Main Personality that stops an attack")
  // was unreachable. The personality's uid marks it as used, exactly like a
  // card's, so it answers once per Combat rather than forever.
  const controller = controllerOf(defender);
  const controllerCardId = controller.levelCardIds[controller.currentLevel - 1];
  const shieldSources: Array<{ uid: string; cardId: string; inPlay: boolean }> = [
    ...defender.zones.inPlay.map((c) => ({ uid: c.uid, cardId: c.cardId, inPlay: true })),
    ...(controllerCardId ? [{ uid: controller.uid, cardId: controllerCardId, inPlay: false }] : []),
  ];

  for (const inst of shieldSources) {
    const card = db.get(inst.cardId);
    const text = card?.rules?.text ?? '';
    if (!/defense\s*shield/i.test(text)) continue;
    if ((c.shieldsUsed ?? []).includes(inst.uid)) continue;

    // "Stops the first unstopped physical attack" / "energy" / neither = both.
    const mentionsPhysical = /physical/i.test(text);
    const mentionsEnergy = /energy/i.test(text);
    const covers =
      (!mentionsPhysical && !mentionsEnergy) ||
      (mentionsPhysical && mentionsEnergy) ||
      (atk.attackType === 'physical' ? mentionsPhysical : mentionsEnergy);
    if (!covers) continue;

    c.shieldsUsed = [...(c.shieldsUsed ?? []), inst.uid];
    atk.stopped = true;
    state.log.push(`${defender.name}: ${card?.name ?? 'a Defense Shield'} activates and stops the attack.`);

    // A personality is not a card in play and cannot be removed from the game;
    // its shield is spent for the Combat by the shieldsUsed mark above.
    if (inst.inPlay && /remov\w*[^.]{0,30}game/i.test(text)) {
      const held = defender.zones.inPlay.find((x) => x.uid === inst.uid);
      defender.zones.inPlay = defender.zones.inPlay.filter((x) => x.uid !== inst.uid);
      if (held) defender.zones.removed.push({ ...held, faceDown: false });
      state.log.push(`${card?.name ?? 'The shield'} is removed from the game.`);
    }
    events.push({ type: 'log', message: `${card?.name ?? 'Defense Shield'} stops the attack` });
    return true;
  }
  return false;
}

/**
 * Find a card this player may play in Combat, in hand or already in play.
 *
 * Both zones count. CRD ~L305 lists five ways to defend and the second is "use
 * one of your Non-Combat cards in play if that card has a starburst on it" —
 * every Defense Shield Drill and every defensive Mastery lives in `inPlay` and
 * never touches hand, so a hand-only check deleted a legal option outright.
 * ~L288 says the same for attacking from a card in play.
 *
 * What matters is that the card is THIS PLAYER'S and is somewhere it can be
 * played from: the old lookup searched both players and the discard pile.
 */
function findCombatCard(
  state: GameState,
  playerIdx: number,
  cardUid: string,
): { inst: CardInstance; zone: 'hand' | 'inPlay' } | undefined {
  const p = state.players[playerIdx];
  if (!p) return undefined;
  const inHand = p.zones.hand.find((c: CardInstance) => c.uid === cardUid);
  if (inHand) return { inst: inHand, zone: 'hand' };
  const inPlay = p.zones.inPlay.find((c: CardInstance) => c.uid === cardUid);
  if (inPlay) return { inst: inPlay, zone: 'inPlay' };
  return undefined;
}

function combatCardError(state: GameState, playerIdx: number, cardUid: string, db: CardDb, verb: string): string | undefined {
  const found = findCombatCard(state, playerIdx, cardUid);
  if (!found) return `that card is not in your hand or in play`;
  const card = db.get(found.inst.cardId);
  const type = db.type(found.inst.cardId);
  // A card in play got there by being legally played, and the CRD lets Drills
  // and Masteries defend, so the combat-type gate applies only to cards
  // coming out of hand.
  if (found.zone !== 'hand') return undefined;
  // 'Unknown' means the printed type line could not be read, not that the card
  // is illegal. Refusing it would take 59 real cards — printed attacks and
  // blocks among them — out of the game on the strength of an OCR failure.
  if (type === 'Unknown') return undefined;
  if (!COMBAT_CARD_TYPES.has(type)) {
    return `${card?.name ?? 'that card'} is a ${type} card and cannot be used to ${verb}`;
  }
  return undefined;
}

/**
 * Send the attack card (battle sequence step 16) and any defense card to the
 * discard pile — or out of the game when the card says so.
 *
 * This was an empty function body. Nothing was ever spent: one attack card
 * could be replayed every phase forever and a single defense card could block
 * an entire game, so hand size and deck construction meant nothing.
 */
/**
 * Send one spent combat card where it belongs — discard, removed, or back to
 * the table when the card grants another use.
 *
 * Pulled out of discardAttackCards because a defence that only PREVENTS damage
 * is spent while the attack carries on, so the defender's card and the
 * attacker's card no longer always leave together.
 */
function spendCombatCard(state: GameState, playerIdx: number, uid: string | undefined, db: CardDb): void {
    if (!uid) return;
    const p = state.players[playerIdx];
    if (!p) return;
    const at = p.zones.hand.findIndex((c: CardInstance) => c.uid === uid);
    if (at === -1) {
      // Defended with a card already in play. Letting it simply stay there cost
      // the defender nothing, so one Drill on the table blocked every attack
      // for the rest of the game.
      //
      // A Non-Combat card in play "stays face up until used, then discarded"
      // (CRD ~L627), so using it spends it. A Drill or Mastery is a permanent
      // and stays — but it is recorded as used, so it answers once per combat
      // rather than forever.
      const inPlayAt = p.zones.inPlay.findIndex((c: CardInstance) => c.uid === uid);
      if (inPlayAt === -1) return;
      const held = p.zones.inPlay[inPlayAt]!;
      const heldCard = db.get(held.cardId);
      const permanent = isDrill(held.cardId, db) || db.type(held.cardId) === 'Mastery';
      const c = state.combat;
      if (c) c.shieldsUsed = [...(c.shieldsUsed ?? []), uid];

      if (!permanent) {
        p.zones.inPlay.splice(inPlayAt, 1);
        const removesInPlay = /remov\w*[^.]{0,30}game/i.test(heldCard?.rules?.text ?? '');
        (removesInPlay ? p.zones.removed : p.zones.discard).push({ ...held, faceDown: false });
        state.log.push(
          `${heldCard?.name ?? 'A card'} is ${removesInPlay ? 'removed from the game' : 'discarded'} after use.`,
        );
      } else {
        state.log.push(`${heldCard?.name ?? 'That card'} has been used this Combat.`);
      }
      return;
    }
    const card = db.get(p.zones.hand[at]!.cardId);

    // "This card stays on the table to be used 1 more time this Combat."
    // Discarding it deleted a use the card explicitly grants, so move it into
    // play instead and let the players count the remaining uses.
    if (/stays on the table/i.test(card?.rules?.text ?? '')) {
      const [held] = p.zones.hand.splice(at, 1);
      if (held) p.zones.inPlay.push({ ...held, faceDown: false });
      state.log.push(`${card?.name ?? 'A card'} stays on the table — track its remaining uses by hand.`);
      return;
    }

    const [spent] = p.zones.hand.splice(at, 1);
    if (!spent) return;
    const removes = (card?.rules?.abilities ?? []).some((a) =>
      a.effects.some((e) => e.kind === 'removeFromGameAfterUse'),
    );
    (removes ? p.zones.removed : p.zones.discard).push({ ...spent, faceDown: false });
    state.log.push(`${card?.name ?? 'A card'} is ${removes ? 'removed from the game' : 'discarded'} after use.`);
}

function discardAttackCards(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  db: CardDb,
  defenseCardUid?: string,
): void {
  spendCombatCard(state, atk.attackerPlayerIdx, atk.cardUid, db);
  spendCombatCard(state, atk.defenderPlayerIdx, defenseCardUid, db);
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
  if (!target) {
    events.push({ type: 'attackResolved', successful: true, powerStages: 0, lifeCards: 0 });
    nextAttackPhase(state, events);
    return;
  }

  atk.resolutionStep = 12; // power stages are dealt
  const overflow = loseStages(target, dmg, db, events);
  atk.powerStagesDealt = dmg - overflow;
  // Step 13 follows: the life cards the card itself owes — Empower, a stated
  // life-card amount, and any "+N life cards" modifier — on top of whatever
  // stages the target could not absorb. Only Empower used to be carried here,
  // so a physical attack printing life cards dealt none of them.
  const cardLife = atk.lifeCardsOwed ?? 0;
  atk.lifeCardsOwed = 0;

  // Stages the personality could not lose become life cards, and count as BOTH
  // kinds of damage (CRD ~L436, ~L579). Handing them to the life-card path is
  // what makes them real: that path is where Endurance, Dragon Ball capture and
  // running out of Life Deck all live, and all three were unreachable from a
  // physical attack while the excess was being dropped on the floor.
  if (overflow + cardLife > 0) {
    if (overflow > 0) {
      state.log.push(
        `${target.personalityName} is out of power stages — ${overflow} converts to life cards of damage.`,
      );
    }
    dealLifeCardsAndFinish(state, atk, overflow + cardLife, db, events);
    return;
  }

  // Say what happened. A successful attack used to be silent — the only sign it
  // landed was a number changing on a card the player may not be looking at,
  // while a STOPPED attack got a log line. Playing it, you could not tell
  // whether your attack had worked.
  state.log.push(
    `${state.players[atk.attackerPlayerIdx]?.name}'s ${atk.attackType} attack hits ${target.personalityName} for ${atk.powerStagesDealt} power stage(s).`,
  );
  events.push({ type: 'attackResolved', successful: true, powerStages: atk.powerStagesDealt, lifeCards: 0 });
  finishSuccessfulAttack(state, atk, db, events);
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
  // "You cannot defend" bars using a CARD. Taking the damage is not defending,
  // and it is the only thing left to do, so it stays available — otherwise a
  // player in this state has no legal answer to an attack at all.
  if (opts.cardUid && c.finalUsed.includes(ctx.actingPlayerIdx)) {
    return 'you cannot defend after a Final Physical Attack';
  }

  // An attack is answered ONCE. Power-stage damage used to end the attack
  // outright, so `currentAttack` never outlived its resolution and this could
  // not be re-entered. Now that overflow routes into the life-card path, that
  // path PAUSES for an Endurance or capture prompt with the attack still on
  // the table — which left this function re-callable. Sending `defend` again
  // re-resolved the whole attack (damage dealt two and three times over), and
  // sending a defense card retroactively STOPPED an attack whose damage had
  // already landed, erasing an earned Dragon Ball capture.
  if (atk.successful || atk.stopped) return 'this attack has already been answered';
  if (state.pendingPrompt && !(state.pendingPrompt.type === 'defend' && state.pendingPrompt.playerIdx === ctx.actingPlayerIdx)) {
    return 'resolve the current prompt first';
  }

  if (opts.cardUid && !opts.takeDamage) {
    const bad = combatCardError(state, atk.defenderPlayerIdx, opts.cardUid, db, 'defend');
    if (bad) return bad;
    // A permanent that already answered this combat does not answer again.
    if ((c.shieldsUsed ?? []).includes(opts.cardUid)) return 'that card has already been used this Combat';

    const found = findCombatCard(state, atk.defenderPlayerIdx, opts.cardUid);
    const cardName = found ? db.get(found.inst.cardId)?.name ?? 'That card' : 'That card';
    const abilities = found ? db.get(found.inst.cardId)?.rules?.abilities ?? [] : [];
    const stops = defenseStops(state, atk.defenderPlayerIdx, opts.cardUid, db);
    const prevents = defensePrevention(state, atk.defenderPlayerIdx, opts.cardUid, atk.attackType, db);

    // The stop has to apply NOW. A card whose only stop is deferred ("stops the
    // next physical attack", "the first successful attack") was being spent to
    // stop the attack in front of it, which is not what it says.
    const nowStops = stops.filter((e) => e.window === undefined || e.window === 'thisAttack' || e.window === 'thisCombat');
    const stopsThis = nowStops.some((e) => (e.attackType ?? 'any') === 'any' || e.attackType === atk.attackType);

    if (!stopsThis) {
      // A card the parser DID read, which turned out to be an attack and
      // nothing else, is not a defence.
      const attackOnly = abilities.length > 0 && abilities.every((a) => a.trigger === 'attack');
      if (attackOnly) return `${cardName} is an attack, not a defence`;
      if (prevents === 0 && stops.length > 0) {
        // It stops attacks — just not this one, and not now.
        return `${cardName} does not stop ${atk.attackType} attacks right now`;
      }
      if (prevents === 0 && abilities.length > 0) {
        // Read, defensive, and it neither stops nor prevents this attack.
        // Resolving it as a stop invented a rule the card does not have.
        return `${cardName} does not stop or prevent this attack`;
      }
    }

    // Everything the card does BESIDES stopping or preventing still happens.
    // CRD ~L387: "If the attack is stopped, the effects are NOT stopped.
    // Secondary effects occur regardless of if an attack is stopped or not."
    const riders = defenseEffects(state, atk.defenderPlayerIdx, opts.cardUid, db).filter(
      (e) => e.kind !== 'stopAttack' && e.kind !== 'preventLifeCards' && e.kind !== 'removeFromGameAfterUse',
    );

    if (!stopsThis && prevents > 0) {
      // PREVENTION IS NOT A STOP. `preventLifeCards` was parsed onto 20 cards,
      // typed in the shared Effect union, and read by nothing — so a card that
      // prevents N life cards fell through and cancelled the whole attack
      // instead. That is better than the card prints, and it also robs the
      // attacker of a success they earned: "an attack is considered successful
      // even if it deals no damage" (~L340 step 8), and the success is what
      // carries the Dragon Ball capture and every "if successful" rider.
      atk.preventedLifeCards = (atk.preventedLifeCards ?? 0) + prevents;
      state.log.push(`${cardName} prevents ${prevents} life card(s) of damage.`);
      if (riders.length > 0) applyOnPlay(state, atk.defenderPlayerIdx, atk.attackerPlayerIdx, riders, db, events);
      // Only the DEFENCE card is spent here; the attack goes on, so the
      // attacker's card is spent with the rest of the attack at step 8.
      spendCombatCard(state, atk.defenderPlayerIdx, opts.cardUid, db);
      // and fall through to Defense Shields and the damage.
    } else {
      if (!stopsThis) {
        // Nothing parsed at all. The engine does not know what the card does,
        // and refusing every unread card would block legal play on missing
        // data, so it still resolves as a stop — flagged, and it costs the
        // defender the card either way.
        state.log.push(`${cardName} has no modelled effect — resolving it as a stop; verify by hand.`);
      }
      atk.stopped = true;
      // A defence may also lock the attacker out for the rest of the combat,
      // but only one that really is combat-long — the parser marks those
      // `scope: 'all'` from "stops ALL ... for the remainder of Combat".
      //
      // Every `thisCombat` stop used to lock out, and 17 cards carry that
      // window without the scope. Reading them, none of them means it: most
      // print "Stops an energy attack" and mention the remainder of Combat for
      // some OTHER rider, and the rest are Defense Shields that stop "the first
      // unstopped attack this combat" — single use. Any one of them ended the
      // opponent's entire offence for the Combat Step.
      for (const e of nowStops) {
        if (e.window === 'thisCombat' && e.scope === 'all') {
          addLockout(state, c, atk.attackerPlayerIdx, e.attackType ?? 'any');
        }
      }
      if (riders.length > 0) applyOnPlay(state, atk.defenderPlayerIdx, atk.attackerPlayerIdx, riders, db, events);
      discardAttackCards(state, atk, db, opts.cardUid);
      events.push({ type: 'attackResolved', successful: false, powerStages: 0, lifeCards: 0 });
      state.log.push(`${state.players[atk.defenderPlayerIdx]!.name} stops the attack.`);
      nextAttackPhase(state, events);
      return undefined;
    }
  }

  // Step 7, before the attack is successful: "If the attack was not stopped,
  // the defender must now activate any Defense Shields from his cards in play."
  atk.resolutionStep = 7;
  if (activateDefenseShields(state, atk, c, db, events)) {
    discardAttackCards(state, atk, db);
    events.push({ type: 'attackResolved', successful: false, powerStages: 0, lifeCards: 0 });
    nextAttackPhase(state, events);
    return undefined;
  }

  // Take the damage -> attack is successful.
  atk.resolutionStep = 8;
  atk.successful = true;
  discardAttackCards(state, atk, db);

  // Steps 9-13 in order: work out the base damage, add the modifiers, deal the
  // power stages, then deal the life cards.
  //
  // This used to be an either/or with an early return, so an attack that stated
  // BOTH resources dealt only one of them — and in opposite directions for the
  // two kinds, since the physical branch read life cards and the energy branch
  // read stages. CRD ~L436 settles it: a modifier is added on top of the base
  // "even if the attack doesn't deal the kind of damage that is being
  // modified", and steps 12 and 13 deal each resource in turn.

  // Step 9. Physical Base Damage comes from the PAT unless the card states its
  // own damage — and it is read HERE, not at declaration. Step 4 is the
  // defender naming who is in Control of Combat, so reading the table first
  // meant a defender who used that rule correctly still took the damage worked
  // out against the personality they had just replaced. The window only opens
  // while the MP is at its bottom two stages, exactly where the PAT gap is
  // widest, so the rule punished them for using it. The attacker's rating can
  // move in between too, so both controllers are re-read from the uids the
  // attack is actually resolving against.
  if (atk.attackType === 'physical' && atk.baseDamage === undefined && atk.damageLifeCards === undefined) {
    const att = findPersonality(state, atk.attackerControllerUid);
    const def = findPersonality(state, atk.defenderControllerUid);
    atk.baseDamage = computeBaseDamage(att?.currentRating ?? 0, def?.currentRating ?? 0);
  }

  atk.resolutionStep = 10; // base damage + modifiers determined

  // Step 10 proper: the modifiers from the table, not just from the attack.
  const board = boardModifiers(state, atk.attackerPlayerIdx, atk.defenderPlayerIdx, atk.attackType, db);
  if (board.stages !== 0 || board.lifeCards !== 0) {
    const parts = [
      board.stages !== 0 ? `${board.stages > 0 ? '+' : ''}${board.stages} power stage(s)` : '',
      board.lifeCards !== 0 ? `${board.lifeCards > 0 ? '+' : ''}${board.lifeCards} life card(s)` : '',
    ].filter(Boolean);
    state.log.push(`Cards in play modify the damage: ${parts.join(', ')}.`);
  }

  // Step 12's total. Floored at 0 — a reduction can cancel an attack's damage
  // but never turn it into healing.
  const stageTotal = Math.max(
    0,
    (atk.baseDamage ?? 0) + (atk.modifiers ?? 0) + (atk.ifSuccessfulStages ?? 0) + board.stages,
  );

  // Step 13's total. Empower is life cards, never stages (~L1102), and so is
  // prevention, which comes off here rather than cancelling the attack.
  const prevented = atk.preventedLifeCards ?? 0;
  if (prevented > 0) {
    state.log.push(`${prevented} life card(s) of damage prevented — the attack still succeeds.`);
  }
  atk.lifeCardsOwed = Math.max(
    0,
    statedLifeCards(atk) +
      (atk.lifeCardModifiers ?? 0) +
      (atk.ifSuccessfulLifeCards ?? 0) +
      (atk.empower ?? 0) +
      board.lifeCards -
      prevented,
  );

  // No power stages to deal: go straight to step 13.
  if (stageTotal <= 0) {
    const owed = atk.lifeCardsOwed;
    atk.lifeCardsOwed = 0;
    dealLifeCardsAndFinish(state, atk, owed, db, events);
    return undefined;
  }

  atk.pendingPowerStageDamage = stageTotal;
  // Offer redirect to a personality not in control of combat (CRD ~L576).
  const targets = redirectTargets(state, atk.defenderPlayerIdx, atk.defenderControllerUid);
  if (stageTotal > 0 && targets.length > 0) {
    state.pendingPrompt = newPrompt(
      atk.defenderPlayerIdx,
      'redirect',
      `Redirect ${stageTotal} power stage(s) of damage to another personality, or take it on your controller.`,
      { optional: true, options: targets.map((t) => ({ uid: t.uid, name: t.personalityName })) },
    );
    return undefined;
  }
  applyPowerStageDamage(state, atk.defenderControllerUid, db, events);
  return undefined;
}

/** Deal `n` life cards to the defender, run if-successful effects, finish the attack. */
/**
 * The life cards this attack's CARD states, before modifiers.
 *
 * An energy attack that states neither resource deals the default 4 (~L343);
 * one that states power stages has those as its base and no life cards unless
 * it names them too.
 */
/**
 * Continuous damage modifiers from the cards on the table (battle-sequence step
 * 10: "any modifiers, from the attack, Drills, personality powers, etc.").
 *
 * Nothing anywhere read either player's inPlay to change damage, so 45 cards
 * printing a signed damage clause were inert in BOTH directions — the +5 Drills
 * and the defensive ones that reduce incoming damage alike.
 *
 * Scans both boards: a card in the attacker's play with "all of your attacks
 * do..." adds, one in the defender's play with "...performed against you"
 * subtracts, and a Location's neutral "all attacks do..." counts once for
 * whoever tabled it. Dragon Balls are included — they are controlled cards in
 * their own zone, and some print a modifier "while you control this".
 */
function boardModifiers(
  state: GameState,
  attackerIdx: number,
  defenderIdx: number,
  attackType: AttackType,
  db: CardDb,
): { stages: number; lifeCards: number } {
  const out = { stages: 0, lifeCards: 0 };
  for (const player of state.players) {
    const mine = player.idx === attackerIdx;
    const theirs = player.idx === defenderIdx;
    if (!mine && !theirs) continue;
    // The personality IN CONTROL of Combat contributes its Constant Combat
    // Power: "You cannot use your MP's Constant Combat Power when an Ally is in
    // control of Combat and vice-versa" (CRD ~L495). 209 of 600 personalities
    // print one and not one of them did anything.
    const controller = controllerOf(player);
    const controllerCardId = controller.levelCardIds[controller.currentLevel - 1];
    const sources = [...player.zones.inPlay, ...player.dragonBalls].map((c) => c.cardId);
    if (controllerCardId) sources.push(controllerCardId);

    for (const cardId of sources) {
      for (const ability of db.get(cardId)?.rules?.abilities ?? []) {
        if (ability.trigger !== 'constant') continue;
        for (const e of ability.effects) {
          if (e.kind !== 'constantDamageModifier') continue;
          if (e.attackType !== 'any' && e.attackType !== attackType) continue;
          const relevant =
            e.applies === 'all' || (e.applies === 'yours' && mine) || (e.applies === 'againstYou' && theirs);
          if (!relevant) continue;
          if (e.resource === 'stages') out.stages += e.amount;
          else out.lifeCards += e.amount;
        }
      }
    }
  }
  return out;
}

function statedLifeCards(atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>): number {
  if (atk.attackType !== 'energy') return atk.damageLifeCards ?? 0;
  if (atk.energyLifeCards !== undefined) return atk.energyLifeCards;
  return atk.baseDamage === undefined ? ENERGY_LIFE_CARDS : 0;
}

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
  atk.resolutionStep = 13; // life cards, and the Endurance window
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
  const stages = atk.powerStagesDealt ?? 0;
  state.log.push(
    `${state.players[atk.attackerPlayerIdx]?.name}'s ${atk.attackType} attack deals ${dealt} life card(s)` +
      `${stages > 0 ? ` and ${stages} power stage(s)` : ''} to ${state.players[atk.defenderPlayerIdx]?.name}.`,
  );
  // An attack that overflowed dealt power stages AND life cards; report both.
  events.push({ type: 'attackResolved', successful: true, powerStages: atk.powerStagesDealt ?? 0, lifeCards: dealt });
  finishSuccessfulAttack(state, atk, db, events);

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
  // Every sibling resolver checks that it is answering its own prompt; this one
  // did not, so the `captureDragonBall` action was a standing offer: any
  // attacker could take a Dragon Ball at any point in a Combat with no life
  // cards dealt at all, and the call clears pendingPrompt on the way out, so it
  // also wiped whatever question the defender was in the middle of answering.
  // The entitlement is the prompt — it is only raised once damage actually
  // crosses LIFE_CARD_CAPTURE_THRESHOLD (~L685).
  const prompt = state.pendingPrompt;
  if (prompt?.type !== 'capture' || prompt.playerIdx !== ctx.actingPlayerIdx) {
    return 'you have not captured a Dragon Ball';
  }

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

/** stopAttack effects carried by the defense card that was just played. */
/**
 * The stops a defender's card provides. Scoped to that player's HAND: this
 * used to search every player and every zone including the discard pile, so a
 * card the opponent had already thrown away could answer for the defense.
 */
function defenseEffects(state: GameState, playerIdx: number, cardUid: string, db: CardDb): Effect[] {
  const found = findCombatCard(state, playerIdx, cardUid);
  if (!found) return [];
  const abilities = db.get(found.inst.cardId)?.rules?.abilities ?? [];
  // A card used to defend contributes its defense ability. Cards with no
  // trigger split contribute what is left once the ATTACK abilities are set
  // aside — falling back to every ability handed the defensive path effects
  // that belong to attacking with the card, so a card defended and then also
  // fired its own attack rider at the person it was defending against.
  const defensive = abilities.filter((a) => a.trigger === 'defense');
  return (defensive.length > 0 ? defensive : abilities.filter((a) => a.trigger !== 'attack')).flatMap(
    (a) => a.effects,
  );
}

function defenseStops(state: GameState, playerIdx: number, cardUid: string, db: CardDb) {
  return defenseEffects(state, playerIdx, cardUid, db).filter((e) => e.kind === 'stopAttack');
}

/**
 * Life cards this defence prevents against `attackType`.
 *
 * `preventLifeCards` was emitted by the parser, typed in the shared Effect
 * union, and read by nothing at all — so a card that prevents N life cards fell
 * through to the "no modelled stop" path and cancelled the attack outright
 * instead. That is strictly better than what it prints, and it also robs the
 * attacker of a success they earned (~L340).
 */
function defensePrevention(
  state: GameState,
  playerIdx: number,
  cardUid: string,
  attackType: AttackType,
  db: CardDb,
): number {
  return defenseEffects(state, playerIdx, cardUid, db).reduce(
    (n, e) =>
      e.kind === 'preventLifeCards' && ((e.attackType ?? 'any') === 'any' || e.attackType === attackType)
        ? n + e.amount
        : n,
    0,
  );
}
/** Answer the redirect prompt: send the pending power-stage damage to a personality. */
export function redirectDamage(state: GameState, toUid: string | null, ctx: CombatCtx, db: CardDb, events: GameEvent[]): string | undefined {
  const atk = state.combat?.currentAttack;
  if (!atk || !state.pendingPrompt || state.pendingPrompt.type !== 'redirect') return 'no redirect pending';
  if (ctx.actingPlayerIdx !== atk.defenderPlayerIdx) return 'only the defender may redirect';
  // The target has to be one the prompt actually offered. Unvalidated, naming
  // any other uid — the attacker's own MP, or a typo — found no personality and
  // the entire attack evaporated: no stages lost, no life cards, and the
  // if-successful chain skipped, all for free and without spending a card.
  if (toUid !== null) {
    const legal = redirectTargets(state, atk.defenderPlayerIdx, atk.defenderControllerUid);
    if (!legal.some((p) => p.uid === toUid)) return 'that personality is not a legal redirect target';
  }
  const target = toUid ?? atk.defenderControllerUid; // null = take it on the controller
  applyPowerStageDamage(state, target, db, events);
  return undefined;
}

/** An Ally takes Control of Combat (MP must be at its bottom 2 stages). */
export function takeControlOfCombat(state: GameState, personalityUid: string, ctx: CombatCtx, events: GameEvent[]): string | undefined {
  const player = state.players[ctx.actingPlayerIdx];
  if (!player) return 'bad player';
  if (state.combat?.currentAttack) return 'control cannot change while an attack is resolving';

  // The MP taking it back is a legal choice, not just an automatic one: "You
  // may choose to keep the current Ally in control of Combat, or have another
  // personality take control of Combat" (CRD ~L585). Only Allies were
  // accepted, so once control left the MP the player could never hand it back.
  if (personalityUid === player.mp.uid) {
    for (const a of player.allies) delete a.inControlOfCombat;
    state.log.push(`${player.name}: ${player.mp.personalityName} takes back Control of Combat.`);
    return undefined;
  }

  const ally = player.allies.find((a) => a.uid === personalityUid);
  if (!ally) return 'not your ally';
  if (player.mp.stageIndex > MP_DOWN_STAGES) return 'MP must be at its bottom 2 power stages';
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

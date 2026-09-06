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
import { advanceStep, draw, MP_DOWN_STAGES, releaseControlIfMpRecovered, syncRating } from './turn.js';
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
  const locked = lockoutAgainst(c, ctx.actingPlayerIdx, attackType);
  if (locked) return `${locked === 'any' ? 'All attacks' : `${locked} attacks`} are stopped for the remainder of this Combat`;
  if (cardUid) {
    const bad = combatCardError(state, ctx.actingPlayerIdx, cardUid, db, 'attack');
    if (bad) return bad;
  }

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

  // Step 4 comes before the defence: "If an Ally can take over Combat for the
  // Main Personality, the Defender must announce which personality is in
  // Control of Combat until this attack is resolved" (CRD ~L325). Only ask
  // when there is a real choice to make.
  if (openControlWindow(state, attack, db)) return undefined;
  openDefenceWindow(state, attack);
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
function openDefenceWindow(state: GameState, atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>): void {
  atk.resolutionStep = 5;
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
  openDefenceWindow(state, atk);
  return undefined;
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

  for (const inst of defender.zones.inPlay) {
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

    if (/remov\w*[^.]{0,30}game/i.test(text)) {
      defender.zones.inPlay = defender.zones.inPlay.filter((x) => x.uid !== inst.uid);
      defender.zones.removed.push({ ...inst, faceDown: false });
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
function discardAttackCards(
  state: GameState,
  atk: NonNullable<NonNullable<GameState['combat']>['currentAttack']>,
  db: CardDb,
  defenseCardUid?: string,
): void {
  const spend = (playerIdx: number, uid: string | undefined): void => {
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
  };
  spend(atk.attackerPlayerIdx, atk.cardUid);
  spend(atk.defenderPlayerIdx, defenseCardUid);
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
  // A physical attack can also carry Empower, which is life cards on top of
  // the stage damage (CRD ~L1102) — the two resources are separate.
  const empowerLife = atk.empower ?? 0;

  // Stages the personality could not lose become life cards, and count as BOTH
  // kinds of damage (CRD ~L436, ~L579). Handing them to the life-card path is
  // what makes them real: that path is where Endurance, Dragon Ball capture and
  // running out of Life Deck all live, and all three were unreachable from a
  // physical attack while the excess was being dropped on the floor.
  if (overflow + empowerLife > 0) {
    if (overflow > 0) {
      state.log.push(
        `${target.personalityName} is out of power stages — ${overflow} converts to life cards of damage.`,
      );
    }
    dealLifeCardsAndFinish(state, atk, overflow + empowerLife, db, events);
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
  if (c.finalUsed.includes(ctx.actingPlayerIdx)) return 'you cannot defend after a Final Physical Attack';

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

    // If the card's defense is modelled, it has to stop THIS kind of attack.
    // Cards whose text is not parsed yet are still allowed through: the engine
    // does not know what they do, and refusing them would block legal play on
    // the strength of missing data. An unmodelled defense is logged as such.
    const stops = defenseStops(state, atk.defenderPlayerIdx, opts.cardUid, db);
    if (stops.length > 0) {
      // The stop has to apply NOW. A card whose only stop is deferred ("stops
      // the next physical attack", "the first successful attack") was being
      // spent to stop the attack in front of it, which is not what it says.
      const nowStops = stops.filter((e) => e.window === undefined || e.window === 'thisAttack' || e.window === 'thisCombat');
      const covers = nowStops.some((e) => (e.attackType ?? 'any') === 'any' || e.attackType === atk.attackType);
      if (!covers) {
        const found = findCombatCard(state, atk.defenderPlayerIdx, opts.cardUid);
        const name = found ? db.get(found.inst.cardId)?.name : undefined;
        return `${name ?? 'That card'} does not stop ${atk.attackType} attacks right now`;
      }
    } else {
      // No modelled stop. Allowing that as a full stop was a mistake: it made
      // EVERY Combat card a perfect defence, including pure attack cards — a
      // physical attack card stopped an energy attack — so no attack could
      // land while the defender held anything.
      //
      // A card the parser DID read, which turned out to be an attack and
      // nothing else, is not a defence and is refused. A card the parser could
      // not read at all is still allowed through, because refusing those would
      // block legal play on missing data — and it costs the defender the card
      // either way, which is the real check on it.
      const found = findCombatCard(state, atk.defenderPlayerIdx, opts.cardUid);
      const abilities = found ? (db.get(found.inst.cardId)?.rules?.abilities ?? []) : [];
      const attackOnly = abilities.length > 0 && abilities.every((a) => a.trigger === 'attack');
      if (attackOnly) {
        return `${db.get(found!.inst.cardId)?.name ?? 'That card'} is an attack, not a defence`;
      }
      state.log.push('Defense card has no modelled stop — resolving it as a stop; verify by hand.');
    }

    atk.stopped = true;
    // A defense card may also lock the attacker out for the whole combat.
    for (const e of stops) {
      if (e.window === 'thisCombat') addLockout(state, c, atk.attackerPlayerIdx, e.attackType ?? 'any');
    }

    // Everything the card does BESIDES stopping still happens. CRD ~L387: "If
    // the attack is stopped, the effects are NOT stopped. Secondary effects
    // occur regardless of if an attack is stopped or not." Only the stop was
    // being read, so every rider a defense card carries — the anger it raises,
    // the stages it takes off the attacker, the card it draws — was thrown
    // away. Disposal is handled by discardAttackCards, so drop that effect.
    const riders = defenseEffects(state, atk.defenderPlayerIdx, opts.cardUid, db).filter(
      (e) => e.kind !== 'stopAttack' && e.kind !== 'removeFromGameAfterUse',
    );
    if (riders.length > 0) {
      applyOnPlay(state, atk.defenderPlayerIdx, atk.attackerPlayerIdx, riders, db, events);
    }

    discardAttackCards(state, atk, db, opts.cardUid);
    events.push({ type: 'attackResolved', successful: false, powerStages: 0, lifeCards: 0 });
    state.log.push(`${state.players[atk.defenderPlayerIdx]!.name} stops the attack.`);
    nextAttackPhase(state, events);
    return undefined;
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

  // Life-card damage: energy attacks, or a physical attack that states a fixed
  // life-card amount ("causing 1 life card of damage").
  const lifeCards =
    atk.attackType === 'energy'
      ? // An energy attack that states POWER-STAGE damage deals power stages.
        // The flat 4-life-card default was applied regardless, so those cards
        // dealt the wrong resource in the wrong amount.
        atk.baseDamage !== undefined
        ? undefined
        : atk.energyLifeCards ?? ENERGY_LIFE_CARDS
      : atk.damageLifeCards; // physical fixed life cards, else undefined -> power stages
  if (lifeCards !== undefined) {
    // Empower adds life cards (CRD ~L1102). It was dropped entirely here, so
    // every Empowered energy attack dealt its flat base and the cost of
    // declaring the Empower bought nothing.
    dealLifeCardsAndFinish(state, atk, lifeCards + (atk.empower ?? 0), db, events);
    return undefined;
  }

  // Otherwise physical power-stage damage from the PAT (+ modifiers).
  // Empower is NOT part of this total: "the attack will do +X life cards"
  // (CRD ~L1102). Adding it here turned life-card damage into power stages,
  // which are a different resource entirely.
  const total = (atk.baseDamage ?? 0) + (atk.modifiers ?? 0) + (atk.ifSuccessfulStages ?? 0);
  atk.resolutionStep = 10; // base damage + modifiers determined
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
  // A card used to defend contributes its defense ability; cards with no
  // trigger split (one parsed ability) contribute that one.
  const defensive = abilities.filter((a) => a.trigger === 'defense');
  return (defensive.length > 0 ? defensive : abilities).flatMap((a) => a.effects);
}

function defenseStops(state: GameState, playerIdx: number, cardUid: string, db: CardDb) {
  return defenseEffects(state, playerIdx, cardUid, db).filter((e) => e.kind === 'stopAttack');
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

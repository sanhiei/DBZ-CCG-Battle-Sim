/**
 * Card ability parsing + execution.
 *
 * `parseAbility` classifies a card (attack / defense) from its (noisy) OCR text
 * and derives machine-readable effects. It distinguishes:
 *   - attack cards that deal PAT power stages (default physical) vs. a FIXED
 *     number of life cards ("causing 1 life card") vs. energy (4 life cards);
 *   - defense cards that STOP or PREVENT attacks (which merely *mention* attacks
 *     and must not be treated as attacks — e.g. Vegeta's "No physical attacks
 *     will work").
 * It is conservative and flags uncertainty; unrecognized cards stay `manual`.
 */
import type { Ability, AttackType, Effect, EffectTarget, GameEvent, GameState } from '@dbz/shared';
import type { CardDb } from './loader.js';
import { currentRatings, draw, setAnger, syncRating } from './turn.js';
import { capturableBalls, discardForEffect } from './damage.js';
import { newPrompt } from './prompt.js';

/* ============================ Execution ============================ */

export function attackKindOf(ability: Ability): AttackType | undefined {
  for (const e of ability.effects) {
    if (e.kind === 'physicalAttack') return 'physical';
    if (e.kind === 'energyAttack') return 'energy';
  }
  return undefined;
}

export function firstAttackAbility(card: { rules?: { abilities?: Ability[] } } | undefined): Ability | undefined {
  return card?.rules?.abilities?.find((a) => a.trigger === 'attack' && attackKindOf(a) !== undefined);
}

function changeMpAnger(state: GameState, playerIdx: number, delta: number, db: CardDb, events: GameEvent[]): void {
  const mp = state.players[playerIdx]?.mp;
  if (!mp) return;
  setAnger(state, mp.uid, mp.anger + delta, db, events);
}

/**
 * Apply a power-stage change to a player's combat controller (MP or ally in
 * control).
 *
 * A loss that runs past the bottom of the ladder is not simply clamped away.
 * CRD ~L390: "When a card effect causes you to lose power stages, not to a
 * minimum of 0, if you go below 0, you must discard the top card of your life
 * deck for every power stage left over." The floor swallowed the remainder, so
 * six cards that print a drain with no minimum did nothing once the target was
 * already at the bottom — and `discardForEffect`, which exists precisely for
 * this, had no caller anywhere in the engine.
 */
function changeControllerStages(
  state: GameState,
  playerIdx: number,
  delta: number,
  db: CardDb,
  events: GameEvent[],
  minimumZero = false,
): void {
  const p = state.players[playerIdx];
  if (!p) return;
  const ctl = p.allies.find((a) => a.inControlOfCombat) ?? p.mp;
  const from = ctl.stageIndex;
  // Clamp BOTH ends. Only the floor was clamped, which was harmless while no
  // card ever emitted a stage gain; now that "Gain 4 power stages" parses, an
  // unclamped gain runs off the top of the ladder and the rating reads back
  // as undefined.
  const top = Math.max(0, currentRatings(ctl, db).length - 1);
  ctl.stageIndex = Math.max(0, Math.min(ctl.stageIndex + delta, top));
  syncRating(ctl, db);
  if (ctl.stageIndex !== from) events.push({ type: 'stageChanged', personalityUid: ctl.uid, from, to: ctl.stageIndex });

  // This is a card EFFECT, not attack damage, so it does not convert to life
  // cards the way overflow damage does (~L436) — the leftover is discarded
  // straight off the top of the Life Deck.
  if (delta < 0 && !minimumZero) {
    const leftover = -delta - (from - ctl.stageIndex);
    if (leftover > 0) {
      const discarded = discardForEffect(state, playerIdx, leftover, db);
      if (discarded > 0) {
        state.log.push(
          `${ctl.personalityName} is below 0 power stages — ${discarded} card(s) discarded from the top of the Life Deck.`,
        );
      }
    }
  }
}

/**
 * "Raise your Main Personality to its highest power stage" / "lower ... to its
 * lowest". A jump to an end of the ladder, not a delta — the amount depends on
 * where the personality currently sits.
 */
function moveControllerToEnd(
  state: GameState,
  playerIdx: number,
  to: 'highest' | 'lowest',
  db: CardDb,
  events: GameEvent[],
): void {
  const p = state.players[playerIdx];
  if (!p) return;
  const ctl = p.allies.find((a) => a.inControlOfCombat) ?? p.mp;
  const from = ctl.stageIndex;
  ctl.stageIndex = to === 'highest' ? Math.max(0, currentRatings(ctl, db).length - 1) : 0;
  syncRating(ctl, db);
  if (ctl.stageIndex !== from) events.push({ type: 'stageChanged', personalityUid: ctl.uid, from, to: ctl.stageIndex });
}

/**
 * Apply an attack ability's setup: performs secondary (immediate) effects (anger,
 * self power changes) and records the attack's damage on the attack object.
 */
export function setupAttackAbility(
  state: GameState,
  ability: Ability,
  attackerIdx: number,
  defenderIdx: number,
  attack: NonNullable<GameState['combat']>['currentAttack'] & object,
  db: CardDb,
  events: GameEvent[],
): void {
  attack.modifiers = attack.modifiers ?? 0;
  attack.ifSuccessfulStages = attack.ifSuccessfulStages ?? 0;
  attack.lifeCardModifiers = attack.lifeCardModifiers ?? 0;
  attack.ifSuccessfulLifeCards = attack.ifSuccessfulLifeCards ?? 0;
  const leftover: Effect[] = [];
  for (const e of ability.effects) {
    // Deferred by the rules, not by convenience: "If successful" effects and
    // effects sharing a sentence with the attack wait until the attack lands
    // (CRD battle-sequence step 3). Applying them here handed the attacker
    // their anger and their card draw before the defender could respond.
    // Scoped to GATEABLE: damageStages also carries `ifSuccessful`, but it is
    // damage and the switch below already banks it into the attack's total.
    // Diverting it here dropped the modifier from the damage entirely.
    if (GATEABLE.has(e.kind) && 'ifSuccessful' in e && e.ifSuccessful) {
      leftover.push(e);
      continue;
    }
    switch (e.kind) {
      // An attack that states BOTH resources deals both. These were written as
      // either/or — and in opposite directions for the two kinds, so a physical
      // attack lost its stated power stages and an energy attack lost its
      // stated life cards. The parser was reading both all along; the executor
      // threw one half away.
      case 'physicalAttack':
        if (e.lifeCards !== undefined) attack.damageLifeCards = e.lifeCards;
        if (e.powerStages !== undefined) attack.baseDamage = e.powerStages;
        break;
      case 'energyAttack':
        if (e.powerStages !== undefined) attack.baseDamage = e.powerStages;
        if (e.lifeCards !== undefined) attack.energyLifeCards = e.lifeCards;
        // An energy attack that states neither deals the default 4 life cards
        // (CRD ~L343).
        if (e.powerStages === undefined && e.lifeCards === undefined) attack.energyLifeCards = 4;
        break;
      case 'damageStages':
        if (e.ifSuccessful) attack.ifSuccessfulStages += e.stages;
        else attack.modifiers += e.stages;
        break;
      case 'damageLifeCards':
        if (e.ifSuccessful) attack.ifSuccessfulLifeCards += e.cards;
        else attack.lifeCardModifiers += e.cards;
        break;
      case 'changeAnger': {
        const who = e.target === 'user' ? attackerIdx : defenderIdx;
        if (e.toZero) {
          const mp = state.players[who]?.mp;
          if (mp) setAnger(state, mp.uid, 0, db, events);
        } else changeMpAnger(state, who, e.delta, db, events);
        break;
      }
      case 'changePowerStages':
        changeControllerStages(state, e.target === 'user' ? attackerIdx : defenderIdx, e.toZero ? -99 : e.delta, db, events, e.toZero || e.minimumZero);
        break;
      case 'movePowerStage':
        moveControllerToEnd(state, e.target === 'user' ? attackerIdx : defenderIdx, e.to, db, events);
        break;
      case 'rejuvenate':
        rejuvenate(state, attackerIdx, e.count, e.from);
        break;
      case 'discardCards':
        discardFromHand(state, e.target === 'user' ? attackerIdx : defenderIdx, e.count);
        break;
      default:
        leftover.push(e); // stopAttack/stun/etc. -> resolve on success (coverage grows)
    }
  }
  if (leftover.length) attack.ifSuccessfulEffects = leftover;
}

/**
 * Move `count` cards from a player's discard pile to the BOTTOM of their Life
 * Deck (rejuvenation). Returns how many actually moved.
 *
 * 'choose' is resolved as the bottom-most cards rather than prompting: the
 * choice rarely changes anything mechanically, and a wrong automated pick is
 * worse than a deterministic one. Cards that specify their own selection stay
 * flagged for review.
 */
export function rejuvenate(state: GameState, playerIdx: number, count: number, from: 'bottom' | 'top' | 'choose'): number {
  const p = state.players[playerIdx];
  if (!p || count <= 0) return 0;
  const pile = p.zones.discard;
  const n = Math.min(count, pile.length);
  if (n === 0) return 0;
  // The discard pile's "top" is the most recently added card (end of array).
  const taken = from === 'top' ? pile.splice(pile.length - n, n) : pile.splice(0, n);
  p.zones.lifeDeck.push(...taken.map((c) => ({ ...c, faceDown: true })));
  state.log.push(`${p.name} rejuvenates ${n} card(s) to the bottom of their Life Deck.`);
  return n;
}

/** Discard `count` cards from a player's hand. Returns how many went. */
export function discardFromHand(state: GameState, playerIdx: number, count: number): number {
  const p = state.players[playerIdx];
  if (!p || count <= 0) return 0;
  const taken = p.zones.hand.splice(0, Math.min(count, p.zones.hand.length));
  p.zones.discard.push(...taken.map((c) => ({ ...c, faceDown: false })));
  if (taken.length) state.log.push(`${p.name} discards ${taken.length} card(s) from hand.`);
  return taken.length;
}

/** Run non-damage "if successful" effects after an attack succeeds (best-effort). */
/**
 * Resolve a Non-Combat card's on-play ability.
 *
 * playCard put the card in play and logged it, and that was all — no effect of
 * any kind was executed, so every Non-Combat card with a parsed ability sat
 * there doing nothing while reading as modelled.
 *
 * Returns whether the card removes itself from the game, which the caller
 * needs in order to put the used card in the right zone.
 */
export function applyOnPlay(
  state: GameState,
  userIdx: number,
  foeIdx: number,
  effects: Effect[],
  db: CardDb,
  events: GameEvent[],
): { removeFromGame: boolean; resolved: number; manual: number } {
  let removeFromGame = false;
  let resolved = 0;
  let manual = 0;
  for (const e of effects) {
    const who = (t: EffectTarget) => (t === 'user' ? userIdx : foeIdx);
    switch (e.kind) {
      case 'changeAnger': {
        if (e.toZero) {
          const mp = state.players[who(e.target)]?.mp;
          if (mp) setAnger(state, mp.uid, 0, db, events);
        } else changeMpAnger(state, who(e.target), e.delta, db, events);
        break;
      }
      case 'changePowerStages':
        changeControllerStages(state, who(e.target), e.toZero ? -99 : e.delta, db, events, e.toZero || e.minimumZero);
        break;
      case 'movePowerStage':
        moveControllerToEnd(state, who(e.target), e.to, db, events);
        break;
      case 'rejuvenate':
        rejuvenate(state, userIdx, e.count, e.from);
        break;
      case 'drawCards':
        draw(state, userIdx, e.count);
        break;
      case 'discardCards':
        discardFromHand(state, who(e.target), e.count);
        break;
      case 'removeFromGameAfterUse':
        removeFromGame = true;
        break;
      case 'captureDragonBall': {
        // A Card Capture (~L682). Unimplemented until now: no Effect carried
        // it, so a card whose whole point is taking a ball did nothing.
        const balls = capturableBalls(state, foeIdx);
        if (balls.length === 0) {
          state.log.push('No Dragon Ball in play to capture.');
          break;
        }
        state.pendingPrompt = newPrompt(
          userIdx,
          'capture',
          "Capture one of your opponent's Dragon Balls.",
          {
            optional: true,
            options: balls.map((b) => ({ uid: b.uid, name: db.get(b.cardId)?.name ?? 'Dragon Ball' })),
          },
        );
        break;
      }
      default:
        // Say so rather than silently doing nothing: a card that looks
        // resolved but was not is worse than one the player knows to resolve.
        state.log.push(`Effect not yet automated: ${e.kind} (resolve manually).`);
        manual++;
        continue;
    }
    resolved++;
  }
  return { removeFromGame, resolved, manual };
}

export function applyIfSuccessful(
  state: GameState,
  effects: Effect[] | undefined,
  db: CardDb,
  events: GameEvent[],
  ctx?: { userIdx: number; foeIdx: number },
): void {
  for (const e of effects ?? []) {
    if (e.kind === 'stopAttack') state.log.push(`Effect: stops a ${e.attackType ?? 'any'} attack (${e.window ?? 'thisAttack'}).`);
    else if (e.kind === 'stunSkipNextPhase') state.log.push('Effect: opponent is stunned (skips next Attack Phase).');
    else if (ctx && GATEABLE.has(e.kind)) {
      // The deferred riders finally happen. applyOnPlay already resolves
      // exactly this set, so they land the same way they would off a
      // Non-Combat card rather than through a second, divergent executor.
      applyOnPlay(state, ctx.userIdx, ctx.foeIdx, [e], db, events);
    } else state.log.push(`Effect not yet automated: ${e.kind} (resolve manually).`);
  }
}

/* ============================ Parser ============================ */

const NUM_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
function toNum(s: string | undefined, fb = 1): number {
  if (!s) return fb;
  if (/^b$/i.test(s)) return 8; // OCR reads 8 as 'b'
  if (/^\d+$/.test(s)) return Number(s);
  return NUM_WORD[s.toLowerCase()] ?? fb;
}
const ifSucc = (t: string) => /if[\s:.\-|\\]{0,6}suc/.test(t);

/**
 * Effects that can be deferred until an attack is known to have landed.
 *
 * Stops and lockouts are deliberately absent: they answer the attack itself and
 * are already routed separately. `removeFromGameAfterUse` is disposal, not an
 * effect, and happens either way.
 */
const GATEABLE = new Set<Effect['kind']>([
  'captureDragonBall',
  'changeAnger',
  'changePowerStages',
  'movePowerStage',
  'drawCards',
  'rejuvenate',
  'discardCards',
]);

function parseRestriction(t: string): Ability['restriction'] | undefined {
  // Named-only comes first: 'Villains, Goku and Gohan only' is NOT a plain
  // villain restriction.
  if (/villains?[, ].{0,20}(goku|gohan)/.test(t)) return { namedOnly: ['Villains', 'Goku', 'Gohan'] };
  if (/heroes only/.test(t)) return { alignment: 'Hero' };
  // stripLead removes this prefix before parsing, so without an explicit check
  // the restriction vanished and a Hero deck could legally play the card.
  if (/villains?\s+only/.test(t)) return { alignment: 'Villain' };
  return undefined;
}

/**
 * Clauses whose numbers are CONDITIONAL and must not be read as the card's
 * base damage: 'if you declared Tokui-Waza, this attack does 5 power stages
 * instead' describes an alternative, not the printed base. Taking the number
 * from one of these makes every copy of the card deal the conditional amount.
 */
const CONDITIONAL_CLAUSE = /\b(if\s+(you|this|your|the)\b|instead\b|tokui[\s-]*waza|toku[\s-]*waza)/;

/** Split a card's text into sentences so a clause's own context can be judged. */
function sentences(t: string): string[] {
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** The sentence containing `needle`, or '' when it is not found. */
function clauseFor(t: string, needle: RegExp): string {
  return sentences(t).find((s) => needle.test(s)) ?? '';
}
function stripLead(t: string): string {
  return t.replace(/^\s*(villains?[^.]*only|heroes only|namekian[^.]*only|saiyan[^.]*only)[.,]?\s*/i, '').trim();
}
/**
 * OCR of the rules panel often captures the embossed type plate above it, so
 * text arrives as "physical combat physical attack doing ..." — and when the
 * plate row merges with the first sentence, the sentence's own qualifier can
 * vanish entirely ("physical combat attack doing +4 ..."). Strip the plate;
 * the caller falls back to the card's declared type for the attack kind.
 * "(non-)combat cards ..." is real rules text and is left alone.
 */
function stripTypePlate(t: string): string {
  const s = t.replace(/^[^a-z0-9]+/, '');
  return s.replace(/^(?:(?:physical|energy|non)\b[^a-z0-9]*)?combat\b(?!\s*cards?)[^a-z0-9]*/, '').trim();
}
/**
 * "Endurance N." is printed BEFORE the rest of the rules text (CRD ~L1118), so
 * it sits between the anchor and the sentence the parser needs to match. Left
 * in place it hides the attack on all 141 Endurance cards. The value itself is
 * already extracted into rules.endurance during enrichment.
 */
function stripEndurance(t: string): string {
  return t.replace(/^endurance\s*[0-9]{1,2}\s*[.,:]?\s*/i, '').trim();
}
/** Leading qualifiers that precede the real sentence on many cards. */
function stripLeadingNoise(t: string): string {
  let out = stripEndurance(stripTypePlate(stripLead(t)));
  // A second pass: some cards carry both a plate and an Endurance prefix.
  out = stripEndurance(stripTypePlate(out));
  return out;
}
function parseCost(t: string): Ability['cost'] | undefined {
  const m = t.match(/cost\w*\s*([0-9b]+)\s*(?:power\s*)?stage/) || t.match(/([0-9b]+)\s*stages?\s*of\s*power\s*(?:drain\s*)?to\s*perform/);
  return m ? { powerStages: toNum(m[1]) } : undefined;
}

/**
 * Fixed base damage, if the card states one. Setting `lifeCards`/`powerStages`
 * makes that amount the card's BASE, which OVERRIDES the Physical Attack Table
 * — so reading the wrong number here does not merely add a little damage, it
 * silently deletes all PAT damage. Two traps, both found by auditing parses
 * against the printed text:
 *
 *  1. "+N life cards" is a MODIFIER added on top of base damage (CRD ~L433),
 *     not a base. Encoding it as a base turned 'physical attack doing +2 life
 *     cards' into 'deal exactly 2 life cards and no power stages'. There is no
 *     life-card modifier Effect kind, so the honest result is NO base and a
 *     review flag.
 *  2. A number inside a CONDITIONAL clause ('if you declared Tokui-Waza, this
 *     attack does 5 power stages instead') is an alternative, not the printed
 *     base. Taking it made every copy of the card deal the conditional amount.
 */
function parseAttackDamage(t: string): { lifeCards?: number; powerStages?: number; conditional?: boolean; lifeCardModifier?: boolean } {
  // Fixed power-stage damage stated WITHOUT a +/- sign (not the "+N" modifier).
  const psRe = /(?:doing|does|deal\w*)\s+([0-9b]+)\s*(?:power\s*)?stages?\s*of\s*damage/;

  // An attack that deals no damage at all is still an attack, and can still be
  // "successful" (CRD battle-sequence step 8). Without a fixed 0 the engine
  // rolled the Physical Attack Table and dealt damage the card forbids.
  if (/does\s+no\s+damage|cannot\s+take\s+[^.]{0,40}damage\s+from\s+this\s+attack/.test(t)) {
    return { powerStages: 0 };
  }

  // A signed life-card amount is a modifier, never a base — but it must not
  // hide a fixed base stated in the same text ("doing 3 power stages of damage
  // ... an additional +3 life cards", Carpet Attack Technique), which used to
  // return here and lose the printed base entirely.
  if (/[+\-]\s?[0-9b]+\s*life\s*cards?/.test(t)) {
    const base = t.match(psRe);
    if (base && !CONDITIONAL_CLAUSE.test(clauseFor(t, psRe))) {
      return { powerStages: toNum(base[1]), lifeCardModifier: true };
    }
    return { lifeCardModifier: true };
  }

  const lcPatterns = [
    /(?:causing|doing|does|do|deal\w*)\s+([0-9b]+)\s*life\s*cards?/,
    /([0-9b]+)\s*life\s*cards?\s*(?:draws?|in damage|of damage)/,
    /([0-9b]+)\s*draws?\s*(?:from\s*the\s*life\s*deck|of damage)/,
    /(?:defender\s+to\s+)?lose\s+([0-9b]+)\s*life\s*cards?/,
  ];
  for (const re of lcPatterns) {
    const m = t.match(re);
    if (!m) continue;
    const clause = clauseFor(t, re);
    if (CONDITIONAL_CLAUSE.test(clause)) return { conditional: true };
    // Some attacks state BOTH bases: 'doing 1 life card of damage and 1 power
    // stage of damage' (Black Jump Kick). Returning at the first match dropped
    // the power-stage half. Read the conjunction from the same sentence only.
    const both = clause.match(/and\s+([0-9b]+)\s*(?:power\s*)?stages?\s*of\s*damage/);
    return { lifeCards: toNum(m[1]), ...(both ? { powerStages: toNum(both[1]) } : {}) };
  }

  const ps = t.match(psRe);
  if (ps) {
    if (CONDITIONAL_CLAUSE.test(clauseFor(t, psRe))) return { conditional: true };
    return { powerStages: toNum(ps[1]) };
  }
  return {};
}

/** Parse stop/prevent effects mentioned anywhere in the text (defense card or rider). */
/**
 * How long a stop lasts. The parser used to default everything to a single
 * attack, which understated ~50 cards: 'stops all attacks for the remainder of
 * Combat' was resolving as 'stop one attack', so every later attack that combat
 * went straight through.
 *
 * Order matters — a card can name several horizons in one sentence, and the
 * longest-lived one wins.
 */
function stopWindow(t: string): 'thisAttack' | 'nextPhase' | 'thisCombat' | 'firstSuccessful' {
  // "Stops the next physical attack performed against you this Combat" is a
  // single deferred stop. It names a combat, so the combat-long test below
  // claimed it and turned one stop into a lockout on every later attack.
  if (/stops?\s+the\s+next\b/.test(t)) return 'nextPhase';
  if (/(remainder|rest)\s+of\s+(the\s+|this\s+)?combat|\bin\s+this\s+combat\b|\bthis\s+combat\b|any\s+more\s+.{0,30}attacks?/.test(t)) {
    return 'thisCombat';
  }
  if (/first\s+successful/.test(t)) return 'firstSuccessful';
  if (/next\s*(phase|round|attack)/.test(t)) return 'nextPhase';
  // "during your opponent's next 'Attacker Attacks' phase" — the phase name
  // sits between "next" and "phase", so the pattern above walked straight past it.
  if (/next\s+[^.]{0,40}phase/.test(t)) return 'nextPhase';
  return 'thisAttack';
}

/** 'stops ALL attacks' / 'any more attacks' -> the stop is not single-target. */
const STOPS_EVERY = /stops?\s+all\b|all\s+attacks?\b|any\s+(other|more)\s+.{0,20}attacks?/;
function parseDefensiveEffects(t: string): Effect[] {
  const out: Effect[] = [];
  const at = (m?: string): AttackType | 'any' => (m === 'physical' || m === 'energy' ? m : 'any');

  // "No physical/energy attacks will work ... this combat" -> stop all, this combat.
  let m = t.match(/no\s+(physical|energy)\s+attacks?\s+will\s+\w*\s*work/);
  if (m) out.push({ kind: 'stopAttack', attackType: at(m[1]), window: 'thisCombat', scope: 'all' });

  // "the first successful (physical|energy) attack ... is stopped"
  m = t.match(/first\s+successful\s+(physical|energy)?\s*(?:life\s*card\s*)?attack/);
  if (m && /stop/.test(t)) out.push({ kind: 'stopAttack', attackType: at(m[1]), window: 'firstSuccessful' });

  // "prevents N life cards ..."
  m = t.match(/prevent\w*\s+(?:up\s*to\s+)?([0-9b]+)\s*life\s*cards?/);
  if (m) out.push({ kind: 'preventLifeCards', amount: toNum(m[1]), attackType: /energy/.test(t) ? 'energy' : /physical/.test(t) ? 'physical' : 'any' });

  // "stops ... (physical|energy) attack" — tolerate interposed words
  // ("stops a successful physical attack", "stops a single named foe ... attack").
  // A card can stop twice — "Stops an energy attack. Stops all energy
  // attacks for the remainder of Combat." (Frieza's Force Bubble). Matching
  // once against the whole text dropped the combat-long clause, so walk the
  // sentences and keep every distinct stop.
  for (const s of sentences(t)) {
    const sm = s.match(/stop\w*\s+.{0,40}?(physical|energy)?\s*attack/);
    if (!sm) continue;
    // "Stops a physical or energy attack" means either type. The lazy match
    // above walks past "physical or" and captures "energy", which left the
    // engine refusing to let the card stop a physical attack at all.
    const eitherType = /(physical\s+or\s+energy|energy\s+or\s+physical)/.test(s);
    const scope = STOPS_EVERY.test(s) ? 'all' : /single|a named|one\s+(named\s+)?foe/.test(s) ? 'single' : undefined;
    const eff: Effect = {
      kind: 'stopAttack',
      attackType: eitherType ? 'any' : at(sm[1]),
      window: stopWindow(s),
      ...(scope ? { scope } : {}),
    };
    const dup = out.some((e) => e.kind === 'stopAttack' && e.attackType === eff.attackType && e.window === eff.window);
    if (!dup) out.push(eff);
  }
  // "prevents an energy/physical attack" (no number)
  if (!out.some((e) => e.kind === 'stopAttack')) {
    const p = t.match(/prevent\w*\s+(?:an?\s+)?(physical|energy)\s+attack/);
    if (p) out.push({ kind: 'stopAttack', attackType: at(p[1]), window: 'thisAttack' });
  }
  return out;
}

/**
 * Anger changes, judged one sentence at a time.
 *
 * Reading the whole text at once produced three separate defects, each
 * found by auditing parses against printed cards:
 *   - "Raise your anger 1 level. Lower your opponent's anger 3 levels."
 *     (Gohan's Ready) emitted only the foe half, because the user branch
 *     was suppressed whenever a foe-lowering clause appeared anywhere;
 *   - "Lower your anger 3 levels." (Android 17's Neck Hold) emitted
 *     nothing, since the user branch only understood raising;
 *   - amounts leaked between clauses, so the foe effect could take its
 *     number from the user's sentence.
 * Each sentence carries its own target, direction and amount.
 */
function pushAnger(effects: Effect[], t: string): void {
  // Split on "and"/"then" first: one sentence often states both players'
  // anger changes, and a single target for the whole sentence loses one.
  const clauses = sentences(t).flatMap((s) =>
    /anger[^.]*\band\b[^.]*anger/.test(s) ? s.split(/\s+(?:and|then)\s+/) : [s],
  );
  for (const s of clauses) {
    if (!/anger/.test(s)) continue;

    // Bind the target to the possessive attached to "anger", not to whether
    // the sentence mentions an opponent at all: "If you declared a Tokui-Waza
    // and your opponent did not, raise your anger 2 levels" (Blue Speediness)
    // names the opponent in its condition and raises the USER'S anger.
    const foeAnger = /(opponent|foe|his|her|their)'?s?\s+(current\s+)?anger/.test(s);
    const ownAnger = /(your|user'?s?|own)\s+(current\s+)?anger/.test(s);
    const foe = foeAnger && !ownAnger;

    // "Lower ALL PLAYERS' anger levels to 0" (Goku's Conquering Stance) names
    // no possessive at all, so it matched neither test and fell through to the
    // user — the card zeroed only its own player's anger, which is close to
    // the opposite of what it says. EffectTarget has no 'both', so emit one
    // effect per player rather than widening the schema for a handful of cards.
    const everyone = /\ball\s+(players|personalities)'?s?\b|\bboth\s+players'?s?\b|\beach\s+player'?s?\b/.test(s);
    const targets = everyone ? (['user', 'foe'] as const) : ([foe ? 'foe' : 'user'] as const);
    // Both halves in one sentence ("raise your anger 1 level and lower your
    // opponent's anger 2 levels", Red Fist Lunge) are handled by the split
    // below rather than by picking one target for the whole sentence.
    // A set, not a delta: as delta 0 it was a no-op that still looked modelled.
    if (/anger[^.]{0,24}\bto\s*(0|zero)\b/.test(s)) {
      for (const target of targets) effects.push({ kind: 'changeAnger', target, delta: 0, toZero: true });
      continue;
    }

    const lowers = /\b(low\w*|reduc\w*|decreas\w*|loses?)\b/.test(s);
    const raises = /\b(rais\w*|gain\w*|increas\w*|add)\b/.test(s);
    if (!lowers && !raises) continue;

    const n =
      s.match(/anger[^0-9]*levels?\s*(\d)/) ??
      s.match(/anger[^0-9]{0,10}(\d)/) ??
      s.match(/(\d)\s*(?:anger|levels?)/);
    const amount = toNum(n?.[1], 1);
    for (const target of targets) effects.push({ kind: 'changeAnger', target, delta: lowers ? -amount : amount });
  }
}
/** "to a minimum of 0" turns a stage loss into a simple floor (CRD ~L390). */
const MIN_ZERO = /minimum\s+of\s+0/i;

function pushSelfPowerLoss(effects: Effect[], t: string): void {
  const m = t.match(/attacker\s+([0-9b]+)\s*stages?\s*of\s*power|attacker\s+to\s+lose\s+([0-9b]+)\s*stages?/);
  if (m) {
    effects.push({
      kind: 'changePowerStages',
      target: 'user',
      delta: -toNum(m[1] ?? m[2]),
      ...(MIN_ZERO.test(t) ? { minimumZero: true } : {}),
    });
  }
}
/**
 * Power-stage changes stated outside the damage clause.
 *
 * The old pattern only understood "raise ... power rating by N", so the far
 * more common printings were dropped even though the effect already existed:
 * "Gain 4 power stages" (Piccolo's Destruction Attack, Cell's Charge) and
 * "Your opponent loses 4 power stages" (Saiyan Lightning Dodge).
 */
function pushRaiseOwnPower(effects: Effect[], t: string): void {
  for (const s of sentences(t)) {
    // Damage clauses belong to the attack parser; this is the extra rider.
    if (/of\s*damage/.test(s)) continue;
    // As with anger, the opponent merely being named in a condition does not
    // make the gain theirs — require them to be the one losing/gaining.
    const foe = /(opponent|foe)\S*(\s+main\s+personality)?\s+(los|gain|rais)/.test(s);

    if (foe) {
      const loss = s.match(/los\w*\s*([0-9b]+)\s*(?:power\s*)?stages?/);
      if (loss) {
        effects.push({
          kind: 'changePowerStages',
          target: 'foe',
          delta: -toNum(loss[1]),
          ...(MIN_ZERO.test(s) ? { minimumZero: true } : {}),
        });
      }
      continue;
    }
    const gain = s.match(/\b(?:gain|rais|increas)\w*\b[^.]{0,40}?([0-9b]+)\s*(?:power\s*)?stages?\b/);
    if (gain) {
      effects.push({ kind: 'changePowerStages', target: 'user', delta: toNum(gain[1]) });
      continue;
    }
    const rating = s.match(/(?:rais|increas)\w*[^.]{0,30}power\s*rating\s*by\s*([0-9b]+)/);
    if (rating) effects.push({ kind: 'changePowerStages', target: 'user', delta: toNum(rating[1]) });
  }
}
/**
 * Continuous damage modifiers printed on cards that sit on the table.
 *
 * Battle-sequence step 10 adds "any modifiers, from the attack, Drills,
 * personality powers, etc." to the Base Damage. Only the attack's own were ever
 * read, so 45 in-play cards printing a signed damage clause were inert in both
 * directions — including the ones that REDUCE damage, which meant a defensive
 * Drill did nothing for the player who tabled it.
 *
 * Three printed shapes, and the possessive is what decides who is affected:
 *   "All of your physical attacks do +2 power stages of damage."
 *   "All energy attacks performed against you do 1 less life card of damage."
 *   "All physical attacks do +1 power stage of damage."   (a neutral Location)
 *
 * Deliberately narrow. A clause carrying a condition ("If you declared a
 * Tokui-Waza...", "for each card you have drawn") or scoped to a Combat
 * ("for the remainder of Combat") is NOT continuous board state and is left
 * alone rather than guessed at.
 */
function pushConstantModifiers(effects: Effect[], t: string): void {
  const CONTINUOUS = /\ball\s+(of\s+your\s+|your\s+)?(physical\s+|energy\s+)?attacks?\s*(you\s+perform\s+|performed\s+against\s+you\s*)?,?\s*(?:do|does)\s+(?:an\s+additional\s+)?([+-]?\d+)\s*(more\s+|less\s+|additional\s+)?(power\s+stages?|life\s+cards?)(\s+or\s+life\s+cards?)?/gi;
  for (const s of sentences(t)) {
    // Conditional or combat-scoped clauses are not board state.
    if (/\bif\b|\bwhile\b|\bfor\s+each\b|remainder\s+of\s+combat|this\s+combat/i.test(s)) continue;
    CONTINUOUS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONTINUOUS.exec(s)) !== null) {
      const yours = Boolean(m[1]) || /you\s+perform/i.test(m[3] ?? '');
      const against = /performed\s+against\s+you/i.test(m[3] ?? '');
      const attackType = m[2] ? (/energy/i.test(m[2]) ? 'energy' : 'physical') : 'any';
      // The sign is stripped before toNum: it only accepts bare digits, and
      // silently returns its fallback of 1 for anything else — so "+2" was
      // reading as +1, which is worse than not parsing the card at all.
      const signed = m[4]!;
      const magnitude = toNum(signed.replace(/^[+-]/, ''));
      // "1 less" is a reduction even though the number is written unsigned.
      const reduces = /less/i.test(m[5] ?? '') || signed.startsWith('-');
      const amount = reduces ? -magnitude : magnitude;
      const bothResources = Boolean(m[7]);
      const resources: Array<'stages' | 'lifeCards'> = bothResources
        ? ['stages', 'lifeCards']
        : [/life/i.test(m[6]!) ? 'lifeCards' : 'stages'];
      for (const resource of resources) {
        effects.push({
          kind: 'constantDamageModifier',
          amount,
          resource,
          attackType,
          applies: against ? 'againstYou' : yours ? 'yours' : 'all',
        });
      }
    }
  }
}

/**
 * "Capture an opponent's Dragon Ball" as a card effect (~L682).
 *
 * Card Captures were unimplemented: no Effect carried them, so a card whose
 * whole point is taking a ball did nothing when it resolved.
 */
function pushCapture(effects: Effect[], t: string): void {
  for (const s of sentences(t)) {
    if (!/captur\w*[^.]{0,40}dragon\s*ball/.test(s)) continue;
    // "cannot be captured" / "if your opponent captures" are not an instruction
    // to capture one.
    if (/cannot|can\s*not|unless|whenever|if\s+your\s+opponent/.test(s)) continue;
    effects.push({ kind: 'captureDragonBall' });
    return;
  }
}

function pushDraw(effects: Effect[], t: string): void {
  const m = t.match(/draw\s+([0-9b]+|a)\s*cards?\b/);
  if (m) effects.push({ kind: 'drawCards', count: m[1] === 'a' ? 1 : toNum(m[1]) });
}

/**
 * Rejuvenation: cards travel from the discard pile to the BOTTOM of the Life
 * Deck. Anchored on "at/on the bottom of ... life deck" so it cannot fire on
 * the many cards that merely mention the discard pile (searching it, removing
 * from it, counting it).
 */
function pushRejuvenate(effects: Effect[], t: string): void {
  if (!/bottom of (your|his|her|the)\s+life\s*deck/.test(t)) return;
  if (!/discard\s*pile/.test(t)) return;
  // "place the bottom 4 cards from your discard pile at the bottom of your Life Deck"
  // "choose 3 cards from your discard pile, and put them on the bottom ..."
  // "place the top card from your discard pile at the bottom ..."
  const m =
    t.match(/(bottom|top)\s+([0-9b]+)?\s*cards?\s+(?:of|from)\s+your\s+discard\s*pile/) ??
    t.match(/(choose|select)\s+([0-9b]+)\s+cards?\s+from\s+your\s+discard\s*pile/);
  if (!m) return;
  const where = m[1] === 'top' ? 'top' : m[1] === 'bottom' ? 'bottom' : 'choose';
  effects.push({ kind: 'rejuvenate', count: m[2] ? toNum(m[2]) : 1, from: where });
}

/**
 * Hand discards. The subject matters: "your opponent must discard 2 cards" is
 * an effect ON the foe, while "discard 1 card from your hand to ..." is a cost
 * the user pays. Anything that does not name a side is left alone.
 */
function pushDiscardCards(effects: Effect[], t: string): void {
  const foe = t.match(/(?:opponent|foe)[^.]{0,40}?discards?\s+([0-9b]+|a)\s+cards?/);
  if (foe) {
    effects.push({ kind: 'discardCards', target: 'foe', count: foe[1] === 'a' ? 1 : toNum(foe[1]) });
    return;
  }
  const self = t.match(/\b(?:you\s+may\s+)?discard\s+([0-9b]+|a)\s+cards?\s+from\s+your\s+hand/);
  if (self) {
    effects.push({ kind: 'discardCards', target: 'user', count: self[1] === 'a' ? 1 : toNum(self[1]) });
  }
}
function pushStun(effects: Effect[], t: string): void {
  if (/(foe|opponent)[^.]{0,60}skip\w*[^.]{0,40}attack\s*phase|skip\w*\s+(his|her|their)\s+next\s+attack\s*phase/.test(t)) {
    effects.push({ kind: 'stunSkipNextPhase' });
  }
}
/**
 * "Raise your Main Personality to its highest power stage."
 *
 * The old pattern wanted the literal "your personality" and the literal
 * "highest stage", so the usual printings — "your Main Personality", and
 * "highest power stage" — were dropped. "All personalities in play"
 * (Gohan's Peaceful Stance) raises the opponent's as well.
 */
function pushMoveStage(effects: Effect[], t: string): void {
  for (const s of sentences(t)) {
    if (/highest\s*(?:power\s*)?stage/.test(s) && /rais\w*|power\s*up\b/.test(s)) {
      const everyone = /all\s+(?:the\s+)?personalities\s+in\s+play/.test(s);
      const foeOnly = !everyone && /(your\s+opponent|the\s+opponent|opponent\S*|foe\S*)/.test(s);
      effects.push({ kind: 'movePowerStage', target: foeOnly ? 'foe' : 'user', to: 'highest' });
      if (everyone) effects.push({ kind: 'movePowerStage', target: 'foe', to: 'highest' });
      continue;
    }
    if (/low\w*[^.]{0,60}(foe|opponent)[^.]{0,50}lowest\s*(?:power\s*)?stage/.test(s)) {
      effects.push({ kind: 'movePowerStage', target: 'foe', to: 'lowest' });
    }
  }
}
const removesAfterUse = (t: string) => /remov\w*[^.]{0,30}game[^.]{0,20}after\s*use/.test(t);
/** "If this attack is performed by <name>" — a condition the engine can't check yet. */
const hasPerformerCondition = (t: string) => /if\s+this\s+attack\s+is\s+performed\s+by/.test(t);

/** Card types that sit on the table, where a continuous clause stays in effect. */
const IN_PLAY_TYPES = new Set(['Non-Combat', 'Drill', 'Location', 'Battleground', 'Dragon Ball']);

/**
 * The power box on a Personality card, split into the abilities it actually
 * contains.
 *
 * Personalities were skipped by the parser outright — 0 of 600 carried an
 * ability, though every one of them has rules text. Every Main Personality and
 * Ally in the game was a stat block with inert text, and one of the two legal
 * ways to spend an Attack Phase (using a Personality Power) did not exist.
 *
 * A power box holds up to two different things, and they are not
 * interchangeable:
 *
 *   "Power: ..."                  a Personality Power, USED once per turn
 *   "Constant Combat Power: ..."  continuous, in effect while in Combat
 *
 * They can appear in either order and either may be absent, so the markers are
 * located and the text between them is what belongs to each. Text before the
 * first marker is flavour or a restriction note and is not parsed.
 *
 * parseAbility still returns one Ability, which is why this is a separate
 * function rather than a change to it: a personality can legitimately have both
 * kinds at once, and every other card in the game has at most one.
 */
const CCP_MARKER = /\(?\s*constant\s+combat\s+power\s*\)?\s*:?/i;
const POWER_MARKER = /(?:^|[.)\]]\s*)power\s*:/gi;

/**
 * "When entering Combat" — the Prepare Phase (CRD ~L258-266).
 *
 * The trigger was declared in the shared union, emitted by no parser branch and
 * consumed by nothing, so 149 cards printing the phrase did nothing all game
 * and the Prepare Phase was one line: the defender's draw.
 *
 * Only MANDATORY effects are claimed. 48 of those cards say "you may", and an
 * optional effect fired automatically is not a smaller bug than one that never
 * fires — it takes the decision away. Those stay manual until there is a prompt
 * to hang them on. Deck searching and "look at the top 2 cards" are likewise
 * left alone: the engine has no model for either.
 */
export function parseWhenEnteringCombat(rawText: string): Ability | null {
  const t = (rawText ?? '').toLowerCase().replace(/\s+/g, ' ');
  const at = t.search(/when\s+entering\s+combat/);
  if (at === -1) return null;
  // Just the sentence the trigger opens; the rest of the card is not part of it.
  const rest = t.slice(at);
  const sentence = rest.split(/(?<=\.)\s/)[0] ?? rest;
  // "you may" is a decision, not a skip: it is offered to the player instead of
  // being applied for them, and instead of being dropped as it used to be.
  const optional = /\bmay\b/.test(sentence);

  const effects: Effect[] = [];
  pushAnger(effects, sentence);
  pushMoveStage(effects, sentence);
  pushRaiseOwnPower(effects, sentence);
  pushDraw(effects, sentence);
  pushRejuvenate(effects, sentence);
  pushDiscardCards(effects, sentence);
  if (effects.length === 0) return null;

  const ability: Ability = { trigger: 'whenEnteringCombat', effects, source: 'parsed' };
  if (optional) ability.optional = true;
  // Several cards fire only for one side: "When entering Combat as the
  // defender, ...".
  if (/as\s+the\s+defender/.test(sentence)) ability.role = 'defender';
  else if (/as\s+the\s+attacker/.test(sentence)) ability.role = 'attacker';
  return ability;
}

export function parsePersonalityPowers(rawText: string, type = 'Personality'): Ability[] {
  const text = (rawText ?? '').trim();
  if (!text) return [];

  const ccp = CCP_MARKER.exec(text);
  const ccpFrom = ccp ? ccp.index : -1;
  const ccpTo = ccp ? ccp.index + ccp[0].length : -1;

  // Find a "Power:" that is not the tail of "Constant Combat Power:". The two
  // markers appear in EITHER order — "Power: ... Constant Combat Power: ..." is
  // the commoner printing — so this cannot just search after the CCP.
  let power: { from: number; to: number } | null = null;
  POWER_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POWER_MARKER.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (ccp && end <= ccpTo && end > ccpFrom) continue; // inside the CCP marker
    power = { from: m.index, to: end };
    break;
  }

  const marks: Array<{ kind: 'constant' | 'personalityPower'; from: number }> = [];
  if (ccp) marks.push({ kind: 'constant', from: ccpTo });
  if (power) marks.push({ kind: 'personalityPower', from: power.to });
  if (marks.length === 0) return [];
  marks.sort((a, c) => a.from - c.from);

  // Where each section ENDS: at the other marker's start, not its body.
  const starts = [ccp ? ccpFrom : -1, power ? power.from : -1].filter((n) => n >= 0).sort((a, c) => a - c);

  const out: Ability[] = [];
  for (const mark of marks) {
    const next = starts.find((s) => s > mark.from);
    const body = text.slice(mark.from, next ?? text.length).trim();
    if (!body) continue;

    // A "When entering Combat" clause inside either half of the box belongs to
    // the Prepare Phase, not to the continuous layer or the activated power.
    const entering = parseWhenEnteringCombat(body);
    if (entering) out.push(entering);

    if (mark.kind === 'constant') {
      // A Constant Combat Power is continuous board state, so only the
      // continuous shapes are read from it. The rest — "your anger cannot be
      // lowered", "you cannot use Endurance" — are prohibitions the engine has
      // no layer for, and inventing one would be worse than leaving them.
      const effects: Effect[] = [];
      pushConstantModifiers(effects, body);
      if (effects.length > 0) out.push({ trigger: 'constant', effects, source: 'parsed' });
      continue;
    }

    // A Personality Power is used like a card: an attack, a defence (Defense
    // Shield), or a bundle of riders.
    const inner = parseAbility(body, type);
    if (inner) {
      out.push({ ...inner, trigger: 'personalityPower' });
      continue;
    }
    // parseAbility only claims a rider-only card when its TYPE says Non-Combat,
    // which a Personality's never does — so a power like "Raise your anger 1
    // level" fell through it entirely. Read the riders directly.
    // Lower-cased, because parseAbility lower-cases its input before it does
    // anything and every rider pattern is written against that. Handing them
    // the raw text matched nothing at all.
    const lower = body.toLowerCase().replace(/\s+/g, ' ');
    const riders: Effect[] = [];
    pushAnger(riders, lower);
    pushMoveStage(riders, lower);
    pushRaiseOwnPower(riders, lower);
    pushDraw(riders, lower);
    pushStun(riders, lower);
    pushRejuvenate(riders, lower);
    pushDiscardCards(riders, lower);
    pushCapture(riders, lower);
    if (riders.length > 0) out.push({ trigger: 'personalityPower', effects: riders, source: 'parsed' });
  }
  return out;
}

export function parseAbility(rawText: string, type: string): Ability | null {
  const t = rawText
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // Cards print the damage modifier both ways: "+4 power stages of damage"
    // and "4+ power stages of damage". Fold the trailing-plus form into the
    // leading-plus form so one well-tested modifier path handles both, rather
    // than the trailing form being read as a fixed base (Red Knee Bash).
    .replace(/(\d+)\s?\+(\s*(?:power\s*)?stages?\s*of\s*damage)/g, '+$1$2')
    .trim();
  const restriction = parseRestriction(t);
  const body = stripLeadingNoise(t);
  const needsReview: string[] = [];

  // A bare "attack ..." opener after the plate was stripped means the plate
  // swallowed the qualifier; the card's declared type says which kind it was.
  const bareAttack = /^(?:focused\s+)?(a\s+)?attack[\s.,]/.test(body);
  // 'Focused' is the only qualifier that precedes the attack noun (67 cards);
  // it is a real mechanic (resists some stops) that the engine does not model
  // yet, so it parses but is flagged. NOT a blanket wildcard: 'all physical
  // attacks ...' is a statement about attacks, not a declaration of one.
  const focused = /^focused\s+/.test(body);
  const core = focused ? body.replace(/^focused\s+/, '') : body;
  const startsPhysical = /^(a\s+)?phys\w*\s+attack/.test(core) || (bareAttack && type === 'Physical Combat');
  const startsEnergy =
    /^(a\s+)?energy\s+attack/.test(core) ||
    /^(does|do|doing)\s+[0-9b]+\s*life\s*cards?\s*draws?\s*of\s*damage/.test(body) ||
    (bareAttack && type === 'Energy Combat');
  const defenseEffects = parseDefensiveEffects(t);
  const startsDefense =
    /^(stops?|prevent\w*|no\s+(physical|energy)|the\s+first\s+successful|defensive|allows|when\s+\w+\s+is\s+forced)/.test(body) ||
    /will\s+\w*\s*work\s+against/.test(body);

  // ---- ATTACK card ----
  if (startsPhysical || startsEnergy) {
    const isEnergy = startsEnergy && !startsPhysical;
    const dmg = parseAttackDamage(body);
    const effects: Effect[] = [];
    if (isEnergy) {
      effects.push({ kind: 'energyAttack', ...(dmg.lifeCards !== undefined ? { lifeCards: dmg.lifeCards } : {}), ...(dmg.powerStages !== undefined ? { powerStages: dmg.powerStages } : {}) });
    } else {
      effects.push({ kind: 'physicalAttack', ...(dmg.lifeCards !== undefined ? { lifeCards: dmg.lifeCards } : {}), ...(dmg.powerStages !== undefined ? { powerStages: dmg.powerStages } : {}) });
    }
    // "+N stages of damage" modifier (only for PAT-based physical, i.e. no fixed damage)
    if (dmg.lifeCards === undefined && dmg.powerStages === undefined) {
      const md = body.match(/([+\-])\s?(\d+)[\s|\\]*(?:power\s*)?stages?\s*of\s*damage/);
      if (md) effects.push({ kind: 'damageStages', stages: toNum(md[2]) * (md[1] === '-' ? -1 : 1), ...(ifSucc(body) ? { ifSuccessful: true } : {}) });
    }
    // "+N life cards of damage" — the mirror of the stage modifier above, and
    // it had no Effect to be carried by. parseAttackDamage recognised the shape
    // and set a bare boolean that was only ever used to flag the ability for
    // review, so the printed amount was parsed and then dropped on the floor.
    //
    // Unlike the stage modifier this is NOT gated on the attack having no fixed
    // damage: CRD ~L436 says a modifier is added on top of the base "even if
    // the attack doesn't deal the kind of damage that is being modified", which
    // is exactly the physical-attack-plus-life-cards case.
    if (dmg.lifeCardModifier) {
      const ld = body.match(/([+\-])\s?(\d+)\s*life\s*cards?/);
      if (ld) {
        effects.push({
          kind: 'damageLifeCards',
          cards: toNum(ld[2]) * (ld[1] === '-' ? -1 : 1),
          ...(ifSucc(body) ? { ifSuccessful: true } : {}),
        });
      }
    }
    // Attacks carry non-damage riders too — 'Gain 4 power stages' (Piccolo's
    // Destruction Attack), 'Raise your Main Personality to his highest power
    // stage' (Blue Knockdown).
    //
    // WHEN they happen is a rule, not a detail. CRD battle-sequence step 3
    // resolves secondary effects at declaration, but excludes two cases: an
    // effect with "If successful" attached, and an effect sharing a sentence
    // with the attack ("An effect in the same sentence as an attack is
    // considered an 'If successful' effect"). Both were being applied the
    // moment the attack was declared — so the attacker's anger rose, and their
    // cards were drawn, before the defender was even offered their defence,
    // and they kept it all when the attack was stopped.
    //
    // Riders are therefore read one sentence at a time, and the sentence that
    // declares the attack — or says "if successful" — produces deferred effects.
    for (const s of sentences(body)) {
      const riders: Effect[] = [];
      pushAnger(riders, s);
      pushRaiseOwnPower(riders, s);
      pushMoveStage(riders, s);
      pushSelfPowerLoss(riders, s);
      pushDraw(riders, s);
      pushStun(riders, s);
      pushRejuvenate(riders, s);
      pushDiscardCards(riders, s);
      pushCapture(riders, s);

      const declaresAttack = /\b(physical|energy)\s+attack\b/.test(s);
      const deferred = ifSucc(s) || declaresAttack;
      for (const e of riders) {
        effects.push(deferred && GATEABLE.has(e.kind) ? ({ ...e, ifSuccessful: true } as Effect) : e);
      }
    }
    if (removesAfterUse(body)) effects.push({ kind: 'removeFromGameAfterUse' });
    // stop riders ("plus it stops...", "if successful ... stops ... next phase")
    for (const s of defenseEffects) if (s.kind === 'stopAttack') effects.push({ ...s, window: s.window ?? 'nextPhase' });

    const ability: Ability = { trigger: 'attack', effects, source: 'parsed' };
    const cost = parseCost(body);
    if (cost) ability.cost = cost;
    if (restriction) ability.restriction = restriction;
    if (isEnergy && dmg.lifeCards === undefined && dmg.powerStages === undefined) needsReview.push('energyLifeCards');
    // Riders gated on who performs the attack can't be honoured yet; keep the
    // attack but flag it so the card stays out of 'full' coverage.
    if (hasPerformerCondition(body)) needsReview.push('performerCondition');
    if (dmg.conditional) needsReview.push('conditionalDamage');
    // Only still under review if the amount could not be read off the text;
    // when it can, it is now a real effect with a real number.
    if (dmg.lifeCardModifier && !effects.some((e) => e.kind === 'damageLifeCards')) {
      needsReview.push('lifeCardModifier');
    }
    if (bareAttack) needsReview.push('attackKindFromType');
    if (focused) needsReview.push('focusedAttack');
    if (needsReview.length) ability.needsReview = needsReview;
    return ability;
  }

  // ---- DEFENSE card ----
  if (startsDefense || defenseEffects.length) {
    const effects: Effect[] = [...defenseEffects];
    pushAnger(effects, t);
    pushRaiseOwnPower(effects, t);
    pushMoveStage(effects, t);
    pushDraw(effects, t);
    if (removesAfterUse(t)) effects.push({ kind: 'removeFromGameAfterUse' });
    if (!effects.length) return null;
    const ability: Ability = { trigger: 'defense', effects, source: 'parsed' };
    if (restriction) ability.restriction = restriction;
    return ability;
  }

  // ---- CONTINUOUS board modifier (Drill / Location / Battleground / Ball) ----
  // Checked before the Non-Combat branch: a Drill's damage clause is in effect
  // for as long as the card is on the table, not once when it is played, and
  // playCard already refuses to resolve an onPlay ability on a Drill for
  // exactly that reason.
  if (IN_PLAY_TYPES.has(type)) {
    const constant: Effect[] = [];
    pushConstantModifiers(constant, body);
    if (constant.length > 0) {
      const ability: Ability = { trigger: 'constant', effects: constant, source: 'parsed' };
      if (restriction) ability.restriction = restriction;
      return ability;
    }
  }

  // ---- NON-COMBAT / utility card ("Use when needed. ...") ----
  // Only claim it when at least one concrete effect parses; a bare "use when
  // needed" with unmodelled effects must stay manual.
  if (/^use\s+(when\s+needed|once|at\s+any\s+time|during)/.test(body) || type === 'Non-Combat') {
    const effects: Effect[] = [];
    pushAnger(effects, body);
    pushMoveStage(effects, body);
    pushRaiseOwnPower(effects, body);
    pushDraw(effects, body);
    pushStun(effects, body);
    pushRejuvenate(effects, body);
    pushDiscardCards(effects, body);
    pushCapture(effects, body);
    if (effects.length === 0) return null;
    if (removesAfterUse(body)) effects.push({ kind: 'removeFromGameAfterUse' });
    const ability: Ability = { trigger: 'onPlay', effects, source: 'parsed' };
    if (restriction) ability.restriction = restriction;
    return ability;
  }

  return null;
}

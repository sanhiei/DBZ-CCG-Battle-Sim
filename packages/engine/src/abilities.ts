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

/** Apply a power-stage change to a player's combat controller (MP or ally in control). */
function changeControllerStages(state: GameState, playerIdx: number, delta: number, db: CardDb, events: GameEvent[]): void {
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
  const leftover: Effect[] = [];
  for (const e of ability.effects) {
    switch (e.kind) {
      case 'physicalAttack':
        if (e.lifeCards !== undefined) attack.damageLifeCards = e.lifeCards;
        else if (e.powerStages !== undefined) attack.baseDamage = e.powerStages;
        break;
      case 'energyAttack':
        if (e.powerStages !== undefined) attack.baseDamage = e.powerStages;
        else attack.energyLifeCards = e.lifeCards ?? 4;
        break;
      case 'damageStages':
        if (e.ifSuccessful) attack.ifSuccessfulStages += e.stages;
        else attack.modifiers += e.stages;
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
        changeControllerStages(state, e.target === 'user' ? attackerIdx : defenderIdx, e.toZero ? -99 : e.delta, db, events);
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
        changeControllerStages(state, who(e.target), e.toZero ? -99 : e.delta, db, events);
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
    else if (e.kind === 'rejuvenate' && ctx) rejuvenate(state, ctx.userIdx, e.count, e.from);
    else if (e.kind === 'movePowerStage' && ctx) {
      moveControllerToEnd(state, e.target === 'user' ? ctx.userIdx : ctx.foeIdx, e.to, db, events);
    }
    else if (e.kind === 'discardCards' && ctx) {
      discardFromHand(state, e.target === 'user' ? ctx.userIdx : ctx.foeIdx, e.count);
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
    // Both halves in one sentence ("raise your anger 1 level and lower your
    // opponent's anger 2 levels", Red Fist Lunge) are handled by the split
    // below rather than by picking one target for the whole sentence.
    const target = foe ? ('foe' as const) : ('user' as const);

    // A set, not a delta: as delta 0 it was a no-op that still looked modelled.
    if (/anger[^.]{0,24}\bto\s*(0|zero)\b/.test(s)) {
      effects.push({ kind: 'changeAnger', target, delta: 0, toZero: true });
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
    effects.push({ kind: 'changeAnger', target, delta: lowers ? -amount : amount });
  }
}
function pushSelfPowerLoss(effects: Effect[], t: string): void {
  const m = t.match(/attacker\s+([0-9b]+)\s*stages?\s*of\s*power|attacker\s+to\s+lose\s+([0-9b]+)\s*stages?/);
  if (m) effects.push({ kind: 'changePowerStages', target: 'user', delta: -toNum(m[1] ?? m[2]) });
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
      if (loss) effects.push({ kind: 'changePowerStages', target: 'foe', delta: -toNum(loss[1]) });
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
    pushAnger(effects, body);
    // Attacks carry non-damage riders too — 'Gain 4 power stages' (Piccolo's
    // Destruction Attack), 'Raise your Main Personality to his highest power
    // stage' (Blue Knockdown). Neither parser ran on the attack branch, so
    // those clauses were dropped while the card looked fully modelled.
    pushRaiseOwnPower(effects, body);
    pushMoveStage(effects, body);
    pushSelfPowerLoss(effects, body);
    pushDraw(effects, body);
    pushStun(effects, body);
    pushRejuvenate(effects, body);
    pushDiscardCards(effects, body);
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
    if (dmg.lifeCardModifier) needsReview.push('lifeCardModifier');
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
    if (effects.length === 0) return null;
    if (removesAfterUse(body)) effects.push({ kind: 'removeFromGameAfterUse' });
    const ability: Ability = { trigger: 'onPlay', effects, source: 'parsed' };
    if (restriction) ability.restriction = restriction;
    return ability;
  }

  return null;
}

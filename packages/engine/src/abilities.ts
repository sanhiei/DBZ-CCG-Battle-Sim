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
import type { Ability, AttackType, Effect, GameEvent, GameState } from '@dbz/shared';
import type { CardDb } from './loader.js';
import { setAnger, syncRating } from './turn.js';

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
  ctl.stageIndex = Math.max(0, ctl.stageIndex + delta);
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
      case 'changeAnger':
        changeMpAnger(state, e.target === 'user' ? attackerIdx : defenderIdx, e.delta, db, events);
        break;
      case 'changePowerStages':
        changeControllerStages(state, e.target === 'user' ? attackerIdx : defenderIdx, e.toZero ? -99 : e.delta, db, events);
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
export function applyIfSuccessful(
  state: GameState,
  effects: Effect[] | undefined,
  _db: CardDb,
  _events: GameEvent[],
  ctx?: { userIdx: number; foeIdx: number },
): void {
  for (const e of effects ?? []) {
    if (e.kind === 'stopAttack') state.log.push(`Effect: stops a ${e.attackType ?? 'any'} attack (${e.window ?? 'thisAttack'}).`);
    else if (e.kind === 'stunSkipNextPhase') state.log.push('Effect: opponent is stunned (skips next Attack Phase).');
    else if (e.kind === 'rejuvenate' && ctx) rejuvenate(state, ctx.userIdx, e.count, e.from);
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
  if (/heroes only/.test(t)) return { alignment: 'Hero' };
  if (/villains?[, ].{0,20}(goku|gohan)/.test(t)) return { namedOnly: ['Villains', 'Goku', 'Gohan'] };
  return undefined;
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

/** Fixed base damage on an attack, if the card states one (overrides PAT). */
function parseAttackDamage(t: string): { lifeCards?: number; powerStages?: number } {
  const lc =
    t.match(/(?:causing|doing|does|do|deal\w*)\s+([0-9b]+)\s*life\s*cards?/) ||
    t.match(/([0-9b]+)\s*life\s*cards?\s*(?:draws?|in damage|of damage)/) ||
    t.match(/([0-9b]+)\s*draws?\s*(?:from\s*the\s*life\s*deck|of damage)/) ||
    t.match(/(?:defender\s+to\s+)?lose\s+([0-9b]+)\s*life\s*cards?/);
  if (lc) return { lifeCards: toNum(lc[1]) };
  // Fixed power-stage damage stated WITHOUT a +/- sign (not the "+N" modifier).
  const ps = t.match(/(?:doing|does|deal\w*)\s+([0-9b]+)\s*(?:power\s*)?stages?\s*of\s*damage/);
  if (ps) return { powerStages: toNum(ps[1]) };
  return {};
}

/** Parse stop/prevent effects mentioned anywhere in the text (defense card or rider). */
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
  const alreadyStop = out.some((e) => e.kind === 'stopAttack');
  m = t.match(/stop\w*\s+.{0,40}?(physical|energy)?\s*attack/);
  if (m && !alreadyStop) {
    const window = /next\s*(phase|round)/.test(t) ? 'nextPhase' : /first successful/.test(t) ? 'firstSuccessful' : 'thisAttack';
    const scope = /single|a named|one\s+(named\s+)?foe/.test(t) ? 'single' : undefined;
    out.push({ kind: 'stopAttack', attackType: at(m[1]), window, ...(scope ? { scope } : {}) });
  }
  // "prevents an energy/physical attack" (no number)
  if (!out.some((e) => e.kind === 'stopAttack') && !m) {
    const p = t.match(/prevent\w*\s+(?:an?\s+)?(physical|energy)\s+attack/);
    if (p) out.push({ kind: 'stopAttack', attackType: at(p[1]), window: 'thisAttack' });
  }
  return out;
}

function pushAnger(effects: Effect[], t: string): void {
  // Strip foe-possessives as UNITS first, so "raise your opponent's anger"
  // cannot leave a bare "your" behind and read as user-anger. The errata'd TTS
  // text says "Raise your anger 1 level" where 2001-era scans said "Raise card
  // user's anger level 1" — both must parse.
  const selfOnly = t.replace(/your\s+opponent'?s?|the\s+opponent'?s?|foe'?s?|opponent'?s?/g, '');
  if (/rais\w*[^.]*anger|gain\w*[^.]*anger[^.]*level|anger\s*level\s*\d/.test(t) && /(card\s*)?user|your|gains?|self/.test(selfOnly)) {
    const n = t.match(/anger[^0-9]*level\s*(\d)/) ?? t.match(/anger[^0-9]{0,8}(\d)/);
    // Only user-anger here; foe handled below.
    if (!/low\w*[^.]*(foe|opponent)[^.]*anger/.test(t)) effects.push({ kind: 'changeAnger', target: 'user', delta: toNum(n?.[1], 1) });
  }
  if (/low\w*[^.]*(foe|opponent)[^.]*anger|low\w*[^.]*anger[^.]*(foe|opponent)|reduc\w*[^.]*(foe|opponent)[^.]*anger/.test(t)) {
    const n = t.match(/anger[^0-9]{0,10}(\d)/);
    effects.push({ kind: 'changeAnger', target: 'foe', delta: -toNum(n?.[1], 1) });
  }
}
function pushSelfPowerLoss(effects: Effect[], t: string): void {
  const m = t.match(/attacker\s+([0-9b]+)\s*stages?\s*of\s*power|attacker\s+to\s+lose\s+([0-9b]+)\s*stages?/);
  if (m) effects.push({ kind: 'changePowerStages', target: 'user', delta: -toNum(m[1] ?? m[2]) });
}
function pushRaiseOwnPower(effects: Effect[], t: string): void {
  const m = t.match(/rais\w*[^.]*power\s*rating\s*by\s*([0-9b]+)|increase\w*[^.]*power\s*rating\s*by\s*([0-9b]+)/);
  if (m) effects.push({ kind: 'changePowerStages', target: 'user', delta: toNum(m[1] ?? m[2]) });
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
function pushMoveStage(effects: Effect[], t: string): void {
  if (/rais\w*[^.]{0,60}(all of your personalities|your personality|your mp)[^.]{0,40}highest\s*stage/.test(t)) {
    effects.push({ kind: 'movePowerStage', target: 'user', to: 'highest' });
  } else if (/low\w*[^.]{0,60}(foe|opponent)[^.]{0,50}lowest\s*stage/.test(t)) {
    effects.push({ kind: 'movePowerStage', target: 'foe', to: 'lowest' });
  }
}
const removesAfterUse = (t: string) => /remov\w*[^.]{0,30}game[^.]{0,20}after\s*use/.test(t);
/** "If this attack is performed by <name>" — a condition the engine can't check yet. */
const hasPerformerCondition = (t: string) => /if\s+this\s+attack\s+is\s+performed\s+by/.test(t);

export function parseAbility(rawText: string, type: string): Ability | null {
  const t = rawText.toLowerCase().replace(/\s+/g, ' ').trim();
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

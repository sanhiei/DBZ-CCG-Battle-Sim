/**
 * The back half of a turn: Declare, Discard, Rejuvenation.
 *
 * All three are named in STEPS and all three did nothing. That is not three
 * small gaps, it is the turn's whole economy:
 *
 *  - Declare (CRD ~L232) was not a decision. The attacker was marched into
 *    Combat every turn, so the defensive line of play — skip Combat, rebuild,
 *    take the card back — did not exist.
 *  - Discard (~L240) never trimmed a hand. Both players drew 3 a turn and 3
 *    more entering Combat and discarded nothing, so hands only grew. A
 *    defender always held an answer, which is why no amount of work on the
 *    combat rules changed how a game actually played.
 *  - Rejuvenation (~L244) never gave the card back, which is the entire payoff
 *    for declining Combat. Without it, declining would be a pure loss and the
 *    decision above would be a fake one.
 *
 * They are in one module because they only make sense together.
 */
import type { GameState, PlayerState } from '@dbz/shared';
import type { CardDb } from './loader.js';
import { newPrompt } from './prompt.js';

/** CRD ~L240: "you may have no more than 1 card in your hand at the end of this step". */
export const HAND_LIMIT = 1;

type Ctx = { actingPlayerIdx: number };

const other = (state: GameState, idx: number): number => (idx + 1) % state.players.length;

/* ---------------------------------------------------------------- Declare */

/**
 * Entering the Declare Step. A Location or Battleground played this turn has
 * already spent the Combat Step (~L233), so there is nothing to decide and we
 * record the non-declaration rather than asking a question with one answer.
 */
export function openDeclarePrompt(state: GameState): void {
  if (state.skipCombatThisTurn) {
    state.declaredCombat = false;
    return;
  }
  state.pendingPrompt = newPrompt(
    state.activePlayerIdx,
    'declareCombat',
    'Declare Combat this turn?',
  );
}

export function resolveDeclareCombat(state: GameState, declare: boolean, ctx: Ctx): string | undefined {
  if (state.step !== 'declare') return 'you may only declare Combat in your Declare Step';
  if (ctx.actingPlayerIdx !== state.activePlayerIdx) return 'only the attacker declares Combat';
  if (declare && state.skipCombatThisTurn) {
    return 'a Location or Battleground played this turn costs you the Combat Step';
  }
  state.declaredCombat = declare;
  delete state.pendingPrompt;
  // Declining is logged by advanceStep, which is where the Combat Step is
  // actually skipped; logging it here too would say it twice.
  if (declare) state.log.push(`${state.players[state.activePlayerIdx]!.name} declares Combat.`);
  return undefined;
}

/* ---------------------------------------------------------------- Discard */

const overLimit = (p: PlayerState): boolean => p.zones.hand.length > HAND_LIMIT;

/**
 * Entering the Discard Step, and again after the attacker has discarded: the
 * attacker trims first, "your opponent does the same, right after you discard"
 * (~L241). A player already at the limit is skipped rather than asked.
 */
export function openDiscardPrompt(state: GameState, playerIdx: number, db: CardDb): void {
  const p = state.players[playerIdx];
  if (!p) return;
  if (!overLimit(p)) {
    // Nothing to trim. The attacker's turn to discard still hands off.
    if (playerIdx === state.activePlayerIdx) openDiscardPrompt(state, other(state, playerIdx), db);
    return;
  }
  state.pendingPrompt = newPrompt(
    playerIdx,
    'discard',
    `Discard down to ${HAND_LIMIT} — choose the card to keep, or keep none.`,
    {
      // "You may discard all of your cards if you want" (~L240), so declining
      // to keep one is a legal answer, not a refusal to answer.
      optional: true,
      // Names, not ids: this prompt is a list of buttons the player reads.
      options: p.zones.hand.map((c) => ({ uid: c.uid, name: db.get(c.cardId)?.name ?? 'card' })),
    },
  );
}

export function resolveDiscard(state: GameState, keepUid: string | null, ctx: Ctx, db: CardDb): string | undefined {
  const prompt = state.pendingPrompt;
  if (prompt?.type !== 'discard') return 'no discard is pending';
  if (prompt.playerIdx !== ctx.actingPlayerIdx) return 'that is not your discard';
  const p = state.players[prompt.playerIdx]!;

  const kept = keepUid ? p.zones.hand.filter((c) => c.uid === keepUid) : [];
  if (keepUid && kept.length === 0) return 'that card is not in your hand';
  const discarded = p.zones.hand.filter((c) => c.uid !== keepUid);

  p.zones.discard.push(...discarded.map((c) => ({ ...c, faceDown: false })));
  p.zones.hand = kept;
  state.log.push(`${p.name} discards ${discarded.length} card${discarded.length === 1 ? '' : 's'}.`);
  delete state.pendingPrompt;

  if (prompt.playerIdx === state.activePlayerIdx) {
    openDiscardPrompt(state, other(state, prompt.playerIdx), db);
  }
  return undefined;
}

/* ----------------------------------------------------------- Rejuvenation */

/**
 * Entering the Rejuvenation Step. The step is not optional and always happens
 * (~L248, so that card effects keyed to it still fire), but the card only
 * comes back if the attacker did not declare Combat.
 *
 * A forced skip counts. "If you place a Battleground or Location into play in
 * the Non-Combat Step, you must skip the Combat Step" leaves the attacker
 * having not declared Combat, which is exactly the condition ~L245 names — and
 * it is the payoff that makes playing a Location worth its cost.
 */
export function openRejuvenationPrompt(state: GameState): void {
  if (state.declaredCombat === true) return;
  const p = state.players[state.activePlayerIdx];
  if (!p || p.zones.discard.length === 0) return;
  state.pendingPrompt = newPrompt(
    state.activePlayerIdx,
    'rejuvenate',
    'Skipped Combat — put the top card of your discard pile on the bottom of your Life Deck?',
    { optional: true },
  );
}

export function resolveRejuvenation(state: GameState, take: boolean, ctx: Ctx): string | undefined {
  const prompt = state.pendingPrompt;
  if (prompt?.type !== 'rejuvenate') return 'no rejuvenation is pending';
  if (prompt.playerIdx !== ctx.actingPlayerIdx) return 'only the attacker rejuvenates';
  delete state.pendingPrompt;
  if (!take) return undefined;

  const p = state.players[prompt.playerIdx]!;
  // The discard pile is pushed to, so its last entry is the top card. The Life
  // Deck is drawn from the front, so its bottom is the end.
  const card = p.zones.discard.pop();
  if (!card) return undefined;
  p.zones.lifeDeck.push({ ...card, faceDown: true });
  state.log.push(`${p.name} rejuvenates a card to the bottom of their Life Deck.`);
  return undefined;
}

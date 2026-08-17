/**
 * The Non-Combat Step (CRD ~L627-716).
 *
 * Cards placed in front of you during your Non-Combat Step:
 *
 *  - **Non-Combat / Non-Drill** — stays face up until used, then discarded.
 *  - **Drill** — stays in play and is CONSTANTLY in effect; all of your Drills
 *    are discarded the moment your MP gains or loses a personality level
 *    (~L636). Freestyle Drills (title does not start with a Style) may be
 *    played in any deck and duplicated in play; Styled Drills name a Style.
 *  - **Battleground / Location** — played the same way, but playing a Location
 *    forces you to SKIP the Combat Step this turn (~L233, ~L713). That cost is
 *    the whole point of the card type, so it is enforced rather than logged.
 *
 * Allies also enter during this step, and only at a level at or below the MP's
 * (~L544) — a level-1 MP cannot field a level-3 Ally.
 */
import type { CardInstance, GameEvent, GameState } from '@dbz/shared';
import type { CardDb } from './loader.js';

/** Card types that may be placed in play during the Non-Combat Step. */
const PLAYABLE_IN_PLAY = new Set(['Non-Combat', 'Drill', 'Location', 'Battleground']);

/** Types that cost you the Combat Step when played. */
const SKIPS_COMBAT = new Set(['Location', 'Battleground']);

export function isDrill(cardId: string, db: CardDb): boolean {
  return db.type(cardId) === 'Drill';
}

/**
 * A Drill is Freestyle unless its title starts with a Martial Arts Style
 * (~L640). Freestyle Drills are legal in any deck and may be duplicated in
 * play; Styled ones are bound to the declared Tokui-Waza.
 */
export function isFreestyleDrill(cardId: string, db: CardDb): boolean {
  if (!isDrill(cardId, db)) return false;
  const name = db.get(cardId)?.name ?? '';
  return !/^(red|blue|orange|black|saiyan|namekian)\b/i.test(name);
}

/** Discard every Drill a player controls (MP gained or lost a level). */
export function discardDrills(state: GameState, playerIdx: number, db: CardDb): number {
  const p = state.players[playerIdx];
  if (!p) return 0;
  const drills = p.zones.inPlay.filter((c) => isDrill(c.cardId, db));
  if (drills.length === 0) return 0;
  p.zones.inPlay = p.zones.inPlay.filter((c) => !isDrill(c.cardId, db));
  p.zones.discard.push(...drills.map((c) => ({ ...c, faceDown: false })));
  state.log.push(`${p.name}'s ${drills.length} Drill(s) are discarded.`);
  return drills.length;
}

/**
 * Play a card from hand into play during your Non-Combat Step.
 * Returns an error string when the play is illegal.
 */
export function playCard(
  state: GameState,
  playerIdx: number,
  cardUid: string,
  db: CardDb,
  events: GameEvent[],
): string | undefined {
  const player = state.players[playerIdx];
  if (!player) return 'no such player';
  if (state.activePlayerIdx !== playerIdx) return 'only the active player may play cards in the Non-Combat Step';
  if (state.step !== 'nonCombat') return 'cards enter play during the Non-Combat Step';

  const at = player.zones.hand.findIndex((c: CardInstance) => c.uid === cardUid);
  if (at === -1) return 'card is not in your hand';

  const card = player.zones.hand[at]!;
  const type = db.type(card.cardId);
  if (!PLAYABLE_IN_PLAY.has(type)) {
    return `${db.get(card.cardId)?.name ?? 'that card'} is a ${type} card and does not enter play in the Non-Combat Step`;
  }

  player.zones.hand.splice(at, 1);
  player.zones.inPlay.push({ ...card, faceDown: false });
  const name = db.get(card.cardId)?.name ?? 'a card';
  state.log.push(`${player.name} plays ${name}.`);

  if (SKIPS_COMBAT.has(type)) {
    state.skipCombatThisTurn = true;
    state.log.push(`${name} is a ${type} — ${player.name} must skip the Combat Step this turn.`);
  }

  events.push({ type: 'log', message: `${player.name} plays ${name}` });
  return undefined;
}

/**
 * Highest Ally level a player may field: an Ally must be at or below the MP's
 * current level (~L544).
 */
export function maxAllyLevel(state: GameState, playerIdx: number): number {
  return state.players[playerIdx]?.mp.currentLevel ?? 1;
}

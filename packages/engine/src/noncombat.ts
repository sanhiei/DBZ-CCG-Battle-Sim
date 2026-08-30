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
import { applyOnPlay } from './abilities.js';
import { isDragonBall } from './damage.js';
// Re-exported so callers keep importing the Non-Combat Step's rules from one
// place; they live in drills.ts to keep turn.ts from importing this module.
export { discardDrills, isDrill, isFreestyleDrill } from './drills.js';
import { isDrill } from './drills.js';

/**
 * Card types that may be placed in play during the Non-Combat Step.
 *
 * Dragon Balls belong here — CRD ~L216 lists them explicitly — and leaving them
 * out meant they could never reach the table at all. Everything downstream of
 * them was already built and tested: capture off life-card damage, the seven-
 * of-a-set win, the deferred claim when the seventh is taken from an opponent,
 * and the Dragon Ball Loop. An entire victory condition had no on-ramp.
 */
const PLAYABLE_IN_PLAY = new Set(['Non-Combat', 'Drill', 'Location', 'Battleground', 'Dragon Ball']);

/** Types that cost you the Combat Step when played. */
const SKIPS_COMBAT = new Set(['Location', 'Battleground']);

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
  const name = db.get(card.cardId)?.name ?? 'a card';

  // A Dragon Ball you play is one you CONTROL, and control is what the victory
  // condition counts (CRD ~L163). It lives in its own zone, not among the
  // Drills and Settings, so that capture can move it between players.
  if (isDragonBall(card, db)) {
    player.dragonBalls.push({ ...card, faceDown: false });
    state.log.push(`${player.name} plays ${name} — ${player.dragonBalls.length} Dragon Ball(s) controlled.`);
    events.push({ type: 'log', message: `${player.name} plays ${name}` });
    return undefined;
  }

  player.zones.inPlay.push({ ...card, faceDown: false });
  state.log.push(`${player.name} plays ${name}.`);

  if (SKIPS_COMBAT.has(type)) {
    state.skipCombatThisTurn = true;
    state.log.push(`${name} is a ${type} — ${player.name} must skip the Combat Step this turn.`);
  }

  // Resolve what the card actually does. Until now the card entered play and
  // nothing else happened, for every effect kind.
  //
  // Drills are the exception: they are CONSTANTLY in effect, so resolving one
  // on entry would apply it once and then discard it. The parser cannot tell a
  // Drill from any other Non-Combat card — most Drills are typed `Non-Combat` —
  // so 28 of them carry an `onPlay` ability they should never resolve.
  const drill = isDrill(card.cardId, db);
  const ability = drill ? undefined : db.get(card.cardId)?.rules?.abilities?.find((a) => a.trigger === 'onPlay');
  if (ability) {
    const foeIdx = playerIdx === 0 ? 1 : 0;
    const { removeFromGame } = applyOnPlay(state, playerIdx, foeIdx, ability.effects, db, events);

    // A used Non-Combat card does not stay on the table (~L6): it is discarded,
    // or removed from the game when the card says so. Drills, Locations and
    // Battlegrounds are continuous and stay where they are.
    if (type === 'Non-Combat') {
      const used = player.zones.inPlay.findIndex((c: CardInstance) => c.uid === cardUid);
      if (used !== -1) {
        const [spent] = player.zones.inPlay.splice(used, 1);
        if (spent) {
          (removeFromGame ? player.zones.removed : player.zones.discard).push(spent);
          state.log.push(`${name} is ${removeFromGame ? 'removed from the game' : 'discarded'} after use.`);
        }
      }
    }
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

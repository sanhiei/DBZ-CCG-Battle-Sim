/**
 * Drills — cards that stay in play and are CONSTANTLY in effect.
 *
 * These live apart from the rest of the Non-Combat Step because the Power-Up
 * Step needs them too: all of a player's Drills are discarded the moment their
 * MP gains or loses a personality level (CRD ~L636). Keeping them here lets
 * turn.ts and noncombat.ts share the rules without importing each other, which
 * would otherwise close an import cycle through the ability executor.
 */
import type { GameState } from '@dbz/shared';
import type { CardDb } from './loader.js';
import type { Style } from '@dbz/shared';
import { MARTIAL_STYLES, styleOf } from './mastery.js';

/**
 * A card is a Drill when its TITLE says so.
 *
 * The catalog's type field is unreliable here: 262 cards are named "... Drill"
 * and exactly 4 of them carry the type `Drill` — the rest are typed
 * `Non-Combat`, which is what the printed type line on most of them actually
 * says. Trusting the type meant `discardDrills` fired on almost nothing and
 * Freestyle-vs-Styled legality went unenforced. The title is the reliable
 * signal; every Drill in the game has "Drill" in its name.
 */
export function isDrill(cardId: string, db: CardDb): boolean {
  if (db.type(cardId) === 'Drill') return true;
  return /\bdrills?\b/i.test(db.get(cardId)?.name ?? '');
}

/**
 * The Martial Arts Style of a Drill, or null for Freestyle.
 *
 * "A Styled Drill will have the name of a Style as the first word of its title
 * as well as a Kanji that matches the Style" (~L644). The title is checked
 * first because that is the printed rule, and the catalog's `style` field is
 * null on nine Styled Drills — trusting that field alone let those nine slip
 * every Style check in the game.
 */
/** The first word of a title, letters only — a Styled Drill names its Style there. */
function firstWord(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').replace(/[^A-Za-z]/g, '');
}

export function drillStyleOf(cardId: string, db: CardDb): Style | null {
  if (!isDrill(cardId, db)) return null;
  const card = db.get(cardId);
  const first = firstWord(card?.name ?? '');
  const byTitle = MARTIAL_STYLES.find((s) => s.toLowerCase() === first.toLowerCase());
  return byTitle ?? styleOf(card);
}

/**
 * Whether `cardId` may join the Drills this player already has on the table
 * (CRD ~L646-648): no second Style, and no second copy of the same Styled
 * Drill. Returns the reason it may not, or undefined.
 *
 * There was no check at all — any mix of Styles and any number of duplicates
 * went down together, across 159 Styled Drills. That was survivable only while
 * Drills were inert; once their damage modifiers apply, tabling every Drill you
 * draw is simply the best thing to do.
 */
export function drillPlayError(state: GameState, playerIdx: number, cardId: string, db: CardDb): string | undefined {
  if (!isDrill(cardId, db)) return undefined;
  const player = state.players[playerIdx];
  if (!player) return undefined;
  const style = drillStyleOf(cardId, db);
  // "You can have multiple copies of a Freestyle Drill in play" (~L640).
  if (style === null) return undefined;

  const name = db.get(cardId)?.name ?? 'that Drill';
  for (const inPlay of player.zones.inPlay) {
    const otherStyle = drillStyleOf(inPlay.cardId, db);
    if (otherStyle === null) continue;
    if (otherStyle !== style) {
      return `you have a ${otherStyle} Style Drill in play, so you cannot play a ${style} Style Drill`;
    }
    // Same Style is fine, but "you can only have 1 copy of that Drill in play".
    if ((db.get(inPlay.cardId)?.name ?? '') === name) return `${name} is already in play`;
  }
  return undefined;
}

/**
 * A Drill is Freestyle unless its title starts with a Martial Arts Style
 * (~L640). Freestyle Drills are legal in any deck and may be duplicated in
 * play; Styled ones are bound to the declared Tokui-Waza.
 */
export function isFreestyleDrill(cardId: string, db: CardDb): boolean {
  if (!isDrill(cardId, db)) return false;
  return drillStyleOf(cardId, db) === null;
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

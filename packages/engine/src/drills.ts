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

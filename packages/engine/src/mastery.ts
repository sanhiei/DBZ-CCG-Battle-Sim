/**
 * Masteries and Tokui-Waza (CRD ~L67-84, setup step 2 at ~L189).
 *
 * A Mastery is limit 1 per deck, counts toward deck size, and is placed in play
 * BEFORE the game begins. Playing one requires declaring a Tokui-Waza, which:
 *
 *  - requires every Styled card in the deck to match the Mastery's style
 *    (Freestyle/unstyled cards are always allowed),
 *  - requires at least one Martial Arts Styled card besides the Mastery itself,
 *  - grants the Main Personality **+1 PUR for the rest of the game**, and
 *  - is what unlocks Endurance on cards that have it (CRD ~L1121).
 *
 * Each Mastery's ongoing text is bespoke — thirty cards, thirty rules — so the
 * per-card effects are NOT modelled here. What is modelled is the structure
 * every deck depends on; individual Mastery powers stay `manual` coverage and
 * surface in the UI as such.
 */
import type { Style } from '@dbz/shared';
import type { CardDb, EngineCard } from './loader.js';

/** PUR bonus granted for declaring a Tokui-Waza (CRD ~L76). */
export const TOKUI_WAZA_PUR_BONUS = 1;

export const MARTIAL_STYLES: readonly Style[] = ['Red', 'Blue', 'Orange', 'Black', 'Saiyan', 'Namekian'];

export function isMastery(card: EngineCard | undefined): boolean {
  return card?.rules?.type === 'Mastery';
}

/** The Martial Arts style of a card, or null for Freestyle/unstyled. */
export function styleOf(card: EngineCard | undefined): Style | null {
  const s = card?.style;
  return s && (MARTIAL_STYLES as readonly string[]).includes(s) ? (s as Style) : null;
}

export interface TokuiWazaCheck {
  /** The declared style, when the deck legally supports one. */
  style: Style | null;
  /** Why the declaration is not legal (empty when it is, or when none declared). */
  errors: string[];
}

/**
 * Validate a Tokui-Waza declaration for a deck that includes `masteryId`.
 * `cardIds` is every card in the deck (Life Deck + Sensei Deck), expanded or
 * not — only distinct ids matter for the style checks.
 */
export function checkTokuiWaza(masteryId: string | undefined, cardIds: string[], db: CardDb): TokuiWazaCheck {
  if (!masteryId) return { style: null, errors: [] };

  const mastery = db.get(masteryId);
  const errors: string[] = [];
  if (!isMastery(mastery)) {
    return { style: null, errors: [`${mastery?.name ?? masteryId} is not a Mastery card`] };
  }

  const style = styleOf(mastery);
  // Freestyle Mastery declares a Freestyle Tokui-Waza, which requires ZERO
  // styled cards rather than matching ones (CRD ~L84).
  const freestyle = style === null;

  let styledOthers = 0;
  for (const id of new Set(cardIds)) {
    if (id === masteryId) continue;
    const cardStyle = styleOf(db.get(id));
    if (!cardStyle) continue;
    styledOthers++;
    if (freestyle) {
      errors.push(`a Freestyle Tokui-Waza allows no Styled cards (${db.get(id)?.name ?? id} is ${cardStyle})`);
      break;
    }
    if (cardStyle !== style) {
      errors.push(`${db.get(id)?.name ?? id} is ${cardStyle} Style but your Mastery is ${style}`);
      break;
    }
  }

  if (!freestyle && styledOthers === 0) {
    errors.push('a Tokui-Waza needs at least one Martial Arts Styled card besides the Mastery');
  }

  return { style, errors };
}

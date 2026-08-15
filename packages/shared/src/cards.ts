/**
 * Card schema for the SCORE Dragon Ball Z CCG.
 *
 * A `Card` = catalog data (from the scraper) + an optional `rules` block that is
 * authored incrementally. `coverage` tells the engine/UI how much of a card the
 * rules engine can actually resolve. See docs/ARCHITECTURE.md.
 */
import type { Ability } from './abilities.js';

/** The 6 Martial Arts Styles plus Freestyle (no style). */
export const STYLES = [
  'Red',
  'Blue',
  'Orange',
  'Black',
  'Saiyan',
  'Namekian',
  'Freestyle',
] as const;
export type Style = (typeof STYLES)[number];

export const SAGAS = [
  'Saiyan',
  'Frieza',
  'Trunks',
  'Androids',
  'Cell',
  'Cell Games',
  'World Games',
  'Babidi',
  'Buu',
  'Fusion',
  'Kid Buu',
  'Promo',
  'Subset',
  'Other',
] as const;
export type Saga = (typeof SAGAS)[number];

export const RARITIES = [
  'Common',
  'Uncommon',
  'Rare',
  'Ultra Rare',
  'Starter',
  'Promo',
  'Preview',
  'Fixed',
  'Unknown',
] as const;
export type Rarity = (typeof RARITIES)[number];

/**
 * Card types (CRD §4). Note: "Ally" is not a type — it is a role a Personality
 * card plays. Battleground and Location are treated as one type family.
 */
export const CARD_TYPES = [
  'Personality',
  'Mastery',
  'Sensei',
  'Dragon Ball',
  'Combat',
  'Physical Combat',
  'Energy Combat',
  'Non-Combat',
  'Drill',
  'Location',
  'Unknown',
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export type Alignment = 'Hero' | 'Villain' | 'Rogue';

/** A power rating printed in a power stage. King Kai & friends use 'Z'. */
export type PowerRating = number | 'Z';

/** Keywords defined by the rules (CRD §7); extend as coverage grows. */
export const KEYWORDS = [
  'Empower',
  'Endurance',
  'Focused',
  'Fusion',
  'Defense Shield',
  'Namekian Heritage',
  'Saiyan Heritage',
] as const;
export type Keyword = (typeof KEYWORDS)[number];

/** How much of a card the engine can resolve. Mirrors the source app's model. */
export type Coverage = 'full' | 'partial' | 'metadata' | 'unknown';

/** Raw catalog entry produced by the scraper. */
export interface CatalogCard {
  /** Stable id, e.g. "saiyan-60" or "saiyan-60-blue-one-arm-shoulder-throw". */
  id: string;
  /** Printed collector number within its set/saga, when parseable. */
  number: number | null;
  name: string;
  style: Style | null;
  saga: Saga;
  rarity: Rarity;
  /** Best-available image URL (retrodbzccg.com / i0.wp.com). */
  imageUrl: string;
  /** Gallery/set slug the card was scraped from (e.g. "saiyan-saga-commons"). */
  setSlug: string;
  /** Original alt/caption text, kept for debugging + re-parsing. */
  rawLabel: string;
}

/** Personality-specific rules data (Main Personality levels and Allies). */
export interface PersonalityRules {
  /** Personality level 1..5. */
  level: number;
  /** The personality's name used for level-consecutiveness + named-card limits. */
  personalityName: string;
  alignment: Alignment;
  /** Power ratings from stage 0 upward, in printed order. */
  powerRatings: PowerRating[];
  /** Which stage index the card starts referencing as "0" (usually 0). */
  zeroStageIndex: number;
  /** Power-Up Rating. */
  pur: number;
  /** True if this personality may be played as an Ally. */
  canBeAlly: boolean;
  /** True for the Personality Capture list (CRD ~L688). */
  canCaptureDragonBall?: boolean;
}

/** Rules metadata authored on top of a catalog card. */
export interface CardRules {
  type: CardType;
  coverage: Coverage;
  keywords?: Keyword[];
  /** Free-text rules text transcribed from the card. */
  text?: string;
  /** Present only for Personality cards. */
  personality?: PersonalityRules;
  /** Deck copy limit override (defaults derived from type/name per CRD §2). */
  copyLimit?: number;
  /** Machine-readable ability specs the engine executes (added as coverage grows). */
  abilities?: Ability[];
}

export interface Card extends CatalogCard {
  rules?: CardRules;
}

/** Convenience: the set of Allies that may capture a Dragon Ball (CRD ~L688). */
export const CAPTURING_ALLIES = [
  'Bulma',
  'Chi-Chi',
  'Frieza',
  'Garlic Jr.',
  'Guldo',
  'Krillin',
  'Master Roshi',
  'Saibaimen',
  'Videl',
  'Tien',
  'Yamcha',
] as const;

/** Personalities whose power ratings are 'Z' (PAT result vs. them is always 2). */
export const Z_PERSONALITIES = [
  'King Kai',
  'Grand Kai',
  'Supreme Kai',
  'Supreme West Kai',
  'Mr. Popo',
] as const;

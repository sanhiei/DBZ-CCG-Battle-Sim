/**
 * The slice of the Tabletop Simulator save format we care about.
 *
 * A TTS save is a tree of objects. Cards live inside bags/decks (`ContainedObjects`),
 * and each card's face is one cell of a sprite-sheet atlas declared in `CustomDeck`.
 * A card's `CardID` encodes both which atlas and which cell:
 *
 *     atlasKey  = floor(CardID / 100)   -> key into CustomDeck
 *     cellIndex = CardID % 100          -> row-major index into a NumWidth x NumHeight grid
 *
 * NOTE: everything read out of a mod file is untrusted third-party content. It is
 * treated purely as data — no script field is ever executed or acted upon.
 */

export interface TtsCustomDeck {
  FaceURL?: string;
  BackURL?: string;
  NumWidth?: number;
  NumHeight?: number;
  UniqueBack?: boolean;
}

export interface TtsObject {
  Name?: string;
  Nickname?: string;
  Description?: string;
  GUID?: string;
  CardID?: number;
  CustomDeck?: Record<string, TtsCustomDeck>;
  ContainedObjects?: TtsObject[];
  States?: Record<string, TtsObject>;
}

export interface TtsSave {
  SaveName?: string;
  ObjectStates?: TtsObject[];
}

/** Where a card's face lives inside an atlas. */
export interface AtlasRef {
  faceUrl: string;
  /** Grid dimensions of the sheet. */
  numWidth: number;
  numHeight: number;
  /** Row-major cell index within the sheet. */
  cellIndex: number;
  /** Zero-based grid position, derived from cellIndex. */
  col: number;
  row: number;
}

/**
 * One card extracted from the mod.
 *
 * Identity is the atlas cell, NOT the name: TTS nicknames do not distinguish
 * personality levels (every Goku level card is just "Goku"), so name-based
 * dedupe silently collapses distinct cards. One atlas cell = one card face.
 */
export interface TtsCard {
  /** Stable id derived from the atlas face + cell. */
  id: string;
  /** Card title as printed (TTS `Nickname`). */
  name: string;
  /** Best-guess saga, preferring a main-set container over subsets/promos. */
  saga: string;
  /** Every container path this card was found in, for provenance. */
  containers: string[];
  /** Errata / ruling note the mod author attached, if any. */
  errata?: string;
  atlas: AtlasRef;
  /** How many card objects across the mod resolve to this face. */
  copies: number;
  guid?: string;
}

export interface ExtractResult {
  saveName: string;
  cards: TtsCard[];
  /** Distinct atlases referenced, for the image slicing step. */
  atlases: Array<{ faceUrl: string; numWidth: number; numHeight: number; cards: number }>;
  stats: {
    cardObjects: number;
    uniqueCards: number;
    withErrata: number;
    unresolvedAtlas: number;
    bySaga: Record<string, number>;
  };
}

/** Walks a TTS save tree and pulls out every card with its atlas coordinates. */
import { createHash } from 'node:crypto';
import type { AtlasRef, ExtractResult, TtsCard, TtsCustomDeck, TtsObject, TtsSave } from './types.js';

const CARD_OBJECTS = new Set(['Card', 'CardCustom']);

/**
 * Container-name patterns -> saga. Matched against the whole container path, so
 * `SaiyanSagaPCB` and `Saiyan Saga Booster Box` both resolve. Order matters:
 * "CellG" must be tested before "Cell".
 */
const SAGA_PATTERNS: Array<[RegExp, string]> = [
  [/cellg|cell\s*games/i, 'Cell Games'],
  [/kid\s*buu|kidsaga/i, 'Kid Buu'],
  [/saiyan/i, 'Saiyan'],
  [/frieza|fresaga|frisaga/i, 'Frieza'],
  [/trunks|trusaga/i, 'Trunks'],
  [/android|andsaga/i, 'Android'],
  [/wog|world\s*games/i, 'World Games'],
  [/babidi|babsaga/i, 'Babidi'],
  [/fusion|fussaga/i, 'Fusion'],
  [/buu/i, 'Buu'],
  [/cell/i, 'Cell'],
];

/** A main-set box (`SaiyanSagaPCB`) beats a subset/promo bag when picking a saga. */
const MAIN_SET_CONTAINER = /saga\s*pcb$/i;

export function sagaFromContainer(container: string): string {
  for (const [pattern, saga] of SAGA_PATTERNS) {
    if (pattern.test(container)) return saga;
  }
  return 'Unknown';
}

/**
 * Resolve a card's face position. `CardID` packs the atlas key and the cell:
 * atlasKey = floor(id/100), cell = id%100.
 */
export function resolveAtlas(cardId: number | undefined, decks: Record<string, TtsCustomDeck>): AtlasRef | undefined {
  if (cardId === undefined || !Number.isFinite(cardId)) return undefined;
  const atlasKey = String(Math.floor(cardId / 100));
  const deck = decks[atlasKey] ?? Object.values(decks)[0];
  if (!deck?.FaceURL) return undefined;
  const numWidth = deck.NumWidth && deck.NumWidth > 0 ? deck.NumWidth : 1;
  const numHeight = deck.NumHeight && deck.NumHeight > 0 ? deck.NumHeight : 1;
  const cellIndex = cardId % 100;
  return {
    faceUrl: deck.FaceURL,
    numWidth,
    numHeight,
    cellIndex,
    col: cellIndex % numWidth,
    row: Math.floor(cellIndex / numWidth),
  };
}

const clean = (s: string | undefined): string => (s ?? '').replace(/\r/g, '').trim();

/** Stable, deterministic id for an atlas cell. */
function cardId(faceUrl: string, cellIndex: number): string {
  return `tts-${createHash('sha1').update(faceUrl).digest('hex').slice(0, 8)}-${cellIndex}`;
}

/**
 * A card sits in several bags (a subset bag, its release-saga box, a starter
 * deck). Prefer the saga named by a main-set container before falling back to
 * any container that names one at all.
 */
export function pickSaga(containers: string[]): string {
  const main = containers.filter((c) => MAIN_SET_CONTAINER.test(c.split(' > ').at(-1) ?? ''));
  for (const container of [...main, ...containers]) {
    const saga = sagaFromContainer(container);
    if (saga !== 'Unknown') return saga;
  }
  return 'Unknown';
}

/**
 * Extract every distinct card. The same card appears many times across the mod
 * (packs, boxes, starter decks), so results are deduped on name + saga with a
 * copy count kept for provenance.
 */
export function extractCards(save: TtsSave): ExtractResult {
  const byKey = new Map<string, TtsCard>();
  let cardObjects = 0;
  let unresolvedAtlas = 0;

  const visit = (obj: TtsObject, trail: string[], inheritedDecks: Record<string, TtsCustomDeck>): void => {
    // A deck/bag declares the atlas its children use; children may override it.
    const decks = obj.CustomDeck ? { ...inheritedDecks, ...obj.CustomDeck } : inheritedDecks;

    if (CARD_OBJECTS.has(obj.Name ?? '')) {
      cardObjects++;
      const name = clean(obj.Nickname);
      const atlas = resolveAtlas(obj.CardID, decks);
      if (!atlas) unresolvedAtlas++;
      if (name && atlas) {
        const container = trail.join(' > ');
        const key = `${atlas.faceUrl}#${atlas.cellIndex}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.copies++;
          if (!existing.containers.includes(container)) existing.containers.push(container);
          if (!existing.errata && clean(obj.Description)) existing.errata = clean(obj.Description);
        } else {
          const card: TtsCard = {
            id: cardId(atlas.faceUrl, atlas.cellIndex),
            name,
            saga: 'Unknown', // resolved below once every container is known
            containers: [container],
            atlas,
            copies: 1,
          };
          const errata = clean(obj.Description);
          if (errata) card.errata = errata;
          if (obj.GUID) card.guid = obj.GUID;
          byKey.set(key, card);
        }
      }
    }

    const nickname = clean(obj.Nickname);
    const childTrail = nickname && !CARD_OBJECTS.has(obj.Name ?? '') ? [...trail, nickname] : trail;
    for (const child of obj.ContainedObjects ?? []) visit(child, childTrail, decks);
    for (const state of Object.values(obj.States ?? {})) visit(state, childTrail, decks);
  };

  for (const obj of save.ObjectStates ?? []) visit(obj, [], {});

  for (const card of byKey.values()) card.saga = pickSaga(card.containers);

  const cards = [...byKey.values()].sort((a, b) => a.saga.localeCompare(b.saga) || a.name.localeCompare(b.name));

  const atlasCounts = new Map<string, { faceUrl: string; numWidth: number; numHeight: number; cards: number }>();
  const bySaga: Record<string, number> = {};
  for (const card of cards) {
    bySaga[card.saga] = (bySaga[card.saga] ?? 0) + 1;
    if (!card.atlas.faceUrl) continue;
    const entry = atlasCounts.get(card.atlas.faceUrl);
    if (entry) entry.cards++;
    else {
      atlasCounts.set(card.atlas.faceUrl, {
        faceUrl: card.atlas.faceUrl,
        numWidth: card.atlas.numWidth,
        numHeight: card.atlas.numHeight,
        cards: 1,
      });
    }
  }

  return {
    saveName: save.SaveName ?? 'unknown',
    cards,
    atlases: [...atlasCounts.values()].sort((a, b) => b.cards - a.cards),
    stats: {
      cardObjects,
      uniqueCards: cards.length,
      withErrata: cards.filter((c) => c.errata).length,
      unresolvedAtlas,
      bySaga,
    },
  };
}

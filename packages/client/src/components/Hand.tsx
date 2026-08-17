/**
 * The local player's hand.
 *
 * A card's click meaning depends on what the game is waiting for, so the hand
 * takes an explicit `mode` rather than guessing: it is the board that knows
 * whether we are declaring an attack, answering a defend prompt, or idle.
 * Cards that cannot be used in the current mode are dimmed and unclickable,
 * which keeps illegal actions from ever reaching the server.
 */
import type { CardInstance } from '@dbz/shared';
import type { CardDb } from '@dbz/engine';

export type HandMode = 'idle' | 'attack' | 'defend' | 'play';

export interface HandProps {
  cards: CardInstance[];
  db: CardDb | null;
  mode: HandMode;
  onUse(cardUid: string): void;
}

/** Card types that can be used as an attack from hand. */
const ATTACK_TYPES = new Set(['Physical Combat', 'Energy Combat', 'Combat']);
/** Card types that can answer a defend prompt. */
const DEFEND_TYPES = new Set(['Physical Combat', 'Energy Combat', 'Combat']);
/** Card types that enter play during the Non-Combat Step (CRD ~L627). */
const PLAY_TYPES = new Set(['Non-Combat', 'Drill', 'Location', 'Battleground']);

export function Hand({ cards, db, mode, onUse }: HandProps) {
  if (cards.length === 0) {
    return (
      <div className="hand hand--empty">
        <span className="muted">Hand is empty</span>
      </div>
    );
  }

  /**
   * Whether a click DOES something in the current mode. Idle is always true:
   * the click opens the card for reading, which is how an unautomated card gets
   * resolved by hand.
   */
  const usable = (cardId: string): boolean => {
    if (mode === 'idle') return true;
    const type = db?.type(cardId) ?? 'Unknown';
    // Unknown-typed cards stay usable: coverage is partial by design, and the
    // server is the authority on legality anyway.
    if (type === 'Unknown') return true;
    if (mode === 'play') return PLAY_TYPES.has(type);
    return mode === 'attack' ? ATTACK_TYPES.has(type) : DEFEND_TYPES.has(type);
  };

  return (
    <div className={`hand hand--${mode}`}>
      {cards.map((c) => {
        const card = db?.get(c.cardId);
        const hidden = !c.cardId; // redacted (should not happen for our own hand)
        const can = !hidden && usable(c.cardId);
        return (
          <button
            key={c.uid}
            type="button"
            className={`handcard ${can ? (mode === 'idle' ? 'handcard--inspect' : 'handcard--usable') : ''}`}
            disabled={!can}
            title={mode === 'idle' ? `${card?.name ?? 'Card'} — click to read` : (card?.rules?.text ?? card?.name ?? 'Card')}
            onClick={() => can && onUse(c.uid)}
          >
            {hidden ? (
              <span className="handcard__back" />
            ) : (
              <img
                src={`/cards/${c.cardId}.jpg`}
                alt={card?.name ?? c.cardId}
                loading="lazy"
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
              />
            )}
            <span className="handcard__name">{card?.name ?? '—'}</span>
          </button>
        );
      })}
    </div>
  );
}

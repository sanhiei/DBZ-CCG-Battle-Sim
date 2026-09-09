/**
 * The local player's hand.
 *
 * Two different gestures, because they mean two different things:
 *
 *   click  - read the card. Always available, never commits anything.
 *   drag   - play it. Dropping it on a field is what spends the card.
 *
 * Clicking used to do both, which meant the only way to look at a card was to
 * play it, and a misclick was a spent card. Cards that cannot be used in the
 * current mode are still readable — they are just not draggable.
 */
import type { CardInstance } from '@dbz/shared';
import type { CardDb } from '@dbz/engine';

export type HandMode = 'idle' | 'attack' | 'defend' | 'play' | 'final';

export interface HandProps {
  cards: CardInstance[];
  db: CardDb | null;
  mode: HandMode;
  /** Open the card to read it. */
  onInspect(cardUid: string): void;
  /** A drag started/ended, so the board can light up the drop target. */
  onDragChange(cardUid: string | null): void;
}

/** Card types that can be used as an attack from hand. */
const ATTACK_TYPES = new Set(['Physical Combat', 'Energy Combat', 'Combat']);
/** Card types that can answer a defend prompt. */
const DEFEND_TYPES = new Set(['Physical Combat', 'Energy Combat', 'Combat']);
/** Card types that enter play during the Non-Combat Step (CRD ~L627). */
const PLAY_TYPES = new Set(['Non-Combat', 'Drill', 'Location', 'Battleground', 'Dragon Ball']);

export function Hand({ cards, db, mode, onInspect, onDragChange }: HandProps) {
  if (cards.length === 0) {
    return (
      <div className="hand hand--empty">
        <span className="muted">Hand is empty</span>
      </div>
    );
  }

  /** Whether dragging this card anywhere would do something. */
  const playable = (cardId: string): boolean => {
    if (mode === 'idle') return false;
    const type = db?.type(cardId) ?? 'Unknown';
    // Unknown-typed cards stay usable: coverage is partial by design, and the
    // server is the authority on legality anyway.
    if (type === 'Unknown') return true;
    if (mode === 'play') return PLAY_TYPES.has(type);
    // A Final Physical Attack is paid for with ANY card in hand (CRD ~L409).
    if (mode === 'final') return true;
    return mode === 'attack' ? ATTACK_TYPES.has(type) : DEFEND_TYPES.has(type);
  };

  return (
    <div className={`hand hand--${mode}`}>
      {cards.map((c) => {
        const card = db?.get(c.cardId);
        const hidden = !c.cardId; // redacted (should not happen for our own hand)
        const can = !hidden && playable(c.cardId);
        return (
          <div
            key={c.uid}
            className={`handcard ${can ? 'handcard--playable' : ''}`}
            draggable={can}
            onDragStart={(e) => {
              if (!can) return;
              e.dataTransfer.setData('text/plain', c.uid);
              e.dataTransfer.effectAllowed = 'move';
              onDragChange(c.uid);
            }}
            onDragEnd={() => onDragChange(null)}
            onClick={() => !hidden && onInspect(c.uid)}
            title={card?.name ? `${card.name} — click to read${can ? ', drag to play' : ''}` : 'Card'}
          >
            {hidden ? (
              <span className="handcard__back" />
            ) : (
              <img
                src={`/cards/${c.cardId}.jpg`}
                alt={card?.name ?? c.cardId}
                loading="lazy"
                draggable={false}
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
              />
            )}
            <span className="handcard__name">{card?.name ?? '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A player's half of the table.
 *
 * The board used to show personalities as a bare Scouter and every zone as a
 * number, which meant the one thing you most need to read — what your Main
 * Personality's power box actually says — was never on screen. Personalities
 * are their card now, and clicking one opens it.
 *
 * Cards are DRAGGED here to play them. Click is for reading; drag is for
 * committing. Dropping is what the zone is for, so the zone says so while a
 * card is in the air.
 */
import { useState } from 'react';
import type { CardInstance, PersonalityInPlay, PlayerState } from '@dbz/shared';
import type { CardDb } from '@dbz/engine';
import { Scouter } from './Scouter.tsx';
import { AngerSword } from './AngerSword.tsx';

export type DropIntent = 'play' | 'attack' | 'defend';

export interface FieldProps {
  player: PlayerState;
  own: boolean;
  active: boolean;
  db: CardDb | null;
  /** Background image for this half, or null for the default mat. */
  mat: string | null;
  /** What a card dropped here would do right now, or null if nothing would. */
  dropIntent: DropIntent | null;
  onDropCard(cardUid: string): void;
  onInspectPersonality(p: PersonalityInPlay): void;
  onInspectCard(cardId: string): void;
}

const DROP_LABEL: Record<DropIntent, string> = {
  play: 'Drop to play',
  attack: 'Drop to attack',
  defend: 'Drop to defend',
};

function PersonalityTile({
  personality,
  db,
  onOpen,
  ally,
}: {
  personality: PersonalityInPlay;
  db: CardDb | null;
  onOpen(): void;
  ally?: boolean;
}) {
  const cardId = personality.levelCardIds[personality.currentLevel - 1];
  const card = cardId ? db?.get(cardId) : undefined;
  return (
    <button
      type="button"
      className={`ptile ${ally ? 'ptile--ally' : ''} ${personality.inControlOfCombat ? 'ptile--control' : ''}`}
      onClick={onOpen}
      title={`${personality.personalityName} — click to read${card?.rules?.text ? '' : ''}`}
    >
      <span className="ptile__art">
        {cardId ? (
          <img
            src={`/cards/${cardId}.jpg`}
            alt={card?.name ?? personality.personalityName}
            loading="lazy"
            onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
          />
        ) : null}
      </span>
      <span className="ptile__meta">
        <span className="ptile__name">
          {personality.personalityName} <em>Lv{personality.currentLevel}</em>
        </span>
        <Scouter personality={personality} compact={ally === true} />
        {!ally && <AngerSword personality={personality} />}
      </span>
      {personality.inControlOfCombat && <span className="ptile__flag">in control</span>}
    </button>
  );
}

export function Field({
  player,
  own,
  active,
  db,
  mat,
  dropIntent,
  onDropCard,
  onInspectPersonality,
  onInspectCard,
}: FieldProps) {
  const [over, setOver] = useState(false);
  const z = player.zones;

  const accept = (e: React.DragEvent) => {
    if (!dropIntent) return;
    // Without preventDefault on BOTH dragover and drop the browser refuses the
    // drop and navigates to the dragged data instead.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  return (
    <section
      className={`field ${own ? 'field--own' : 'field--foe'} ${active ? 'field--active' : ''} ${
        dropIntent ? 'field--target' : ''
      } ${over ? 'field--over' : ''}`}
      style={mat ? { backgroundImage: `url(${mat})` } : undefined}
      onDragOver={accept}
      onDragEnter={accept}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!dropIntent) return;
        e.preventDefault();
        setOver(false);
        const uid = e.dataTransfer.getData('text/plain');
        if (uid) onDropCard(uid);
      }}
      onDragOverCapture={() => dropIntent && setOver(true)}
    >
      <header className="field__head">
        <span className={`dot ${player.connected ? 'dot--on' : 'dot--off'}`} />
        <h2>{player.name}</h2>
        {active && <span className="badge">active</span>}
        {dropIntent && <span className="field__hint">{DROP_LABEL[dropIntent]}</span>}
      </header>

      <div className="field__rows">
        <div className="field__people">
          <PersonalityTile
            personality={player.mp}
            db={db}
            onOpen={() => onInspectPersonality(player.mp)}
          />
          {player.allies.map((a) => (
            <PersonalityTile
              key={a.uid}
              personality={a}
              db={db}
              ally
              onOpen={() => onInspectPersonality(a)}
            />
          ))}
        </div>

        <div className="field__play">
          {z.inPlay.length === 0 && player.dragonBalls.length === 0 ? (
            <span className="field__empty muted">nothing in play</span>
          ) : (
            <>
              {z.inPlay.map((c: CardInstance) => (
                <button
                  key={c.uid}
                  type="button"
                  className="inplay"
                  onClick={() => c.cardId && onInspectCard(c.cardId)}
                  title={db?.get(c.cardId)?.name ?? 'card'}
                >
                  <img
                    src={`/cards/${c.cardId}.jpg`}
                    alt={db?.get(c.cardId)?.name ?? ''}
                    loading="lazy"
                    onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                  />
                </button>
              ))}
              {player.dragonBalls.map((b: CardInstance) => (
                <button
                  key={b.uid}
                  type="button"
                  className="inplay inplay--ball"
                  onClick={() => b.cardId && onInspectCard(b.cardId)}
                  title={db?.get(b.cardId)?.name ?? 'Dragon Ball'}
                >
                  <img
                    src={`/cards/${b.cardId}.jpg`}
                    alt={db?.get(b.cardId)?.name ?? ''}
                    loading="lazy"
                    onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                  />
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="counts">
        <span title="Life Deck">
          <b>{z.lifeDeck.length}</b> deck
        </span>
        <span title="Hand">
          <b>{z.hand.length}</b> hand
        </span>
        <span title="Discard">
          <b>{z.discard.length}</b> discard
        </span>
        <span title="Removed from game">
          <b>{z.removed.length}</b> removed
        </span>
        <span title="Dragon Balls controlled">
          <b>{player.dragonBalls.length}</b> balls
        </span>
      </div>
    </section>
  );
}

/**
 * Card detail popover.
 *
 * Manual resolution only works if the player can read the card, so any card in
 * hand opens this. The coverage badge is the important part: it tells the
 * player whether the engine will resolve this card for them or whether they
 * need to apply it by hand in Manual mode.
 */
import type { EngineCard } from '@dbz/engine';

export interface CardDetailProps {
  card: EngineCard | undefined;
  /** Actions available for this card right now. */
  actions: Array<{ label: string; run(): void }>;
  onClose(): void;
}

const COVERAGE_BLURB: Record<string, string> = {
  full: 'Fully automated — the engine resolves this card.',
  partial: 'Partly automated — the attack/defense resolves, but some riders may need Manual mode.',
  metadata: 'Not automated — resolve this card by hand in Manual mode.',
  unknown: 'No rules data — resolve this card by hand in Manual mode.',
};

export function CardDetail({ card, actions, onClose }: CardDetailProps) {
  if (!card) return null;
  const coverage = card.rules?.coverage ?? 'unknown';

  return (
    <div className="detail" role="dialog" aria-label={card.name}>
      <button className="detail__close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <img
        src={`/cards/${card.id}.jpg`}
        alt={card.name}
        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
      />
      <div className="detail__body">
        <h3>{card.name}</h3>
        <div className="detail__tags">
          <span className={`cov cov--${coverage}`}>{coverage}</span>
          {card.rules?.type && <span className="muted">{card.rules.type}</span>}
          {card.style && <span className="muted">{card.style} Style</span>}
          <span className="muted">{card.saga}</span>
          {card.rules?.endurance !== undefined && <span className="muted">Endurance {card.rules.endurance}</span>}
        </div>
        {card.rules?.text && <p className="detail__text">{card.rules.text}</p>}
        {card.rules?.errata && (
          <p className="detail__errata">
            <strong>Ruling:</strong> {card.rules.errata}
          </p>
        )}
        <p className="detail__coverage muted">{COVERAGE_BLURB[coverage]}</p>
        {actions.length > 0 && (
          <div className="detail__actions">
            {actions.map((a) => (
              <button key={a.label} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

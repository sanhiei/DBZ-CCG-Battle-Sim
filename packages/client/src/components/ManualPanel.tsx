/**
 * Manual mode — the tabletop fallback.
 *
 * Card coverage is partial by design (docs/ARCHITECTURE.md): the engine
 * automates what it can read, and everything else is resolved by the players
 * exactly as they would at a table. This panel is that table: nudge any
 * personality's power stage or anger, and move cards between zones.
 *
 * These are deliberately unrestricted — the server permits uid-targeted
 * adjustments on either side precisely so an unautomated card can be honoured.
 * The log records every change, so the other player can see what happened.
 */
import type { GameState, PersonalityInPlay, Zone } from '@dbz/shared';

export interface ManualPanelProps {
  state: GameState;
  seat: number | null;
  onSetStage(personalityUid: string, stageIndex: number): void;
  onSetAnger(personalityUid: string, anger: number): void;
  onMoveCard(cardUid: string, toZone: Zone): void;
  open: boolean;
  onToggle(): void;
}

const MOVE_TARGETS: Zone[] = ['discard', 'inPlay', 'removed', 'hand', 'lifeDeck'];

function PersonalityRow({
  p,
  owner,
  onSetStage,
  onSetAnger,
}: {
  p: PersonalityInPlay;
  owner: string;
  onSetStage(uid: string, stage: number): void;
  onSetAnger(uid: string, anger: number): void;
}) {
  return (
    <div className="manual__row">
      <span className="manual__who">
        {owner} · {p.personalityName}
        {p.isAlly && <em> (ally)</em>}
      </span>
      <span className="manual__group">
        stage
        <button onClick={() => onSetStage(p.uid, Math.max(0, p.stageIndex - 1))}>−</button>
        <strong>{p.stageIndex}</strong>
        <button onClick={() => onSetStage(p.uid, p.stageIndex + 1)}>+</button>
        <span className="muted">({typeof p.currentRating === 'number' ? p.currentRating.toLocaleString('en-US') : p.currentRating})</span>
      </span>
      {!p.isAlly && (
        <span className="manual__group">
          anger
          <button onClick={() => onSetAnger(p.uid, Math.max(0, p.anger - 1))}>−</button>
          <strong>{p.anger}</strong>
          <button onClick={() => onSetAnger(p.uid, p.anger + 1)}>+</button>
        </span>
      )}
    </div>
  );
}

export function ManualPanel({ state, seat, onSetStage, onSetAnger, onMoveCard, open, onToggle }: ManualPanelProps) {
  if (!open) {
    return (
      <button className="manual__handle" onClick={onToggle} title="Resolve an unautomated card by hand">
        Manual mode ▲
      </button>
    );
  }

  const me = seat !== null ? state.players[seat] : undefined;

  return (
    <div className="manual">
      <header className="manual__head">
        <strong>Manual mode</strong>
        <span className="muted">
          For cards the engine does not automate — adjust by hand, exactly as at a table. Every change is logged.
        </span>
        <button className="ghost" onClick={onToggle}>
          Close ▼
        </button>
      </header>

      <div className="manual__rows">
        {state.players.map((pl) => (
          <div key={pl.idx}>
            <PersonalityRow p={pl.mp} owner={pl.name} onSetStage={onSetStage} onSetAnger={onSetAnger} />
            {pl.allies.map((a) => (
              <PersonalityRow key={a.uid} p={a} owner={pl.name} onSetStage={onSetStage} onSetAnger={onSetAnger} />
            ))}
          </div>
        ))}
      </div>

      {me && me.zones.hand.length > 0 && (
        <div className="manual__move">
          <span className="muted">Move a card from your hand:</span>
          <div className="manual__moveRows">
            {me.zones.hand.map((c) => (
              <div key={c.uid} className="manual__moveRow">
                <span className="manual__cardId">{c.cardId || '(hidden)'}</span>
                {MOVE_TARGETS.map((z) => (
                  <button key={z} onClick={() => onMoveCard(c.uid, z)}>
                    → {z}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

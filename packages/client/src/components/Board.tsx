/**
 * Board — one screen showing both sides, the step track, and the log.
 *
 * The local seat is always rendered at the bottom. Zones show counts rather
 * than contents where the rules keep them hidden; redaction already happened
 * server-side, so a blank cardId here simply means "not for you to see".
 */
import type { GameState, PlayerState, Step } from '@dbz/shared';
import { STEPS } from '@dbz/shared';
import { Scouter } from './Scouter.tsx';
import { AngerSword } from './AngerSword.tsx';

export interface BoardProps {
  state: GameState;
  seat: number | null;
  onAction(kind: 'advanceStep' | 'powerUp' | 'pass'): void;
  onOpenCard(cardId: string): void;
}

function Zones({ player, own }: { player: PlayerState; own: boolean }) {
  const z = player.zones;
  const entries: Array<[string, number]> = [
    ['Life Deck', z.lifeDeck.length],
    ['Hand', z.hand.length],
    ['Discard', z.discard.length],
    ['In Play', z.inPlay.length],
    ['Removed', z.removed.length],
    ['Dragon Balls', player.dragonBalls.length],
  ];
  return (
    <div className="zones">
      {entries.map(([label, n]) => (
        <div key={label} className={`zone ${own && label === 'Hand' ? 'zone--own' : ''}`}>
          <span className="zone__n">{n}</span>
          <span className="zone__label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function Side({ player, own, active }: { player: PlayerState; own: boolean; active: boolean }) {
  return (
    <section className={`side ${own ? 'side--own' : 'side--foe'} ${active ? 'side--active' : ''}`}>
      <header className="side__head">
        <span className={`dot ${player.connected ? 'dot--on' : 'dot--off'}`} title={player.connected ? 'connected' : 'disconnected'} />
        <h2>{player.name}</h2>
        <span className="side__mp">
          {player.mp.personalityName} <em>Lv{player.mp.currentLevel}</em>
        </span>
        {active && <span className="badge">active</span>}
      </header>
      <div className="side__body">
        <AngerSword personality={player.mp} />
        <div className="side__center">
          <Scouter personality={player.mp} />
          {player.allies.length > 0 && (
            <div className="allies">
              {player.allies.map((a) => (
                <div key={a.uid} className="ally">
                  <span className="ally__name">{a.personalityName}</span>
                  <Scouter personality={a} compact />
                </div>
              ))}
            </div>
          )}
        </div>
        <Zones player={player} own={own} />
      </div>
    </section>
  );
}

function StepTrack({ step, turn }: { step: Step; turn: number }) {
  return (
    <div className="steps">
      <span className="steps__turn">Turn {turn}</span>
      {STEPS.map((s) => (
        <span key={s} className={`steps__item ${s === step ? 'steps__item--now' : ''}`}>
          {s}
        </span>
      ))}
    </div>
  );
}

export function Board({ state, seat, onAction }: BoardProps) {
  // Spectators have no seat, but still need both sides laid out; show seat 0 on
  // top and seat 1 at the bottom rather than collapsing to a single side.
  const bottomIdx = seat ?? 1;
  const me = state.players[bottomIdx];
  const foe = state.players.find((p) => p.idx !== bottomIdx);
  const myTurn = seat != null && state.activePlayerIdx === seat;

  return (
    <div className="board">
      {foe && <Side player={foe} own={false} active={state.activePlayerIdx === foe.idx} />}

      <div className="board__mid">
        <StepTrack step={state.step} turn={state.turnNumber} />
        {state.pendingPrompt && (
          <div className="prompt">
            <strong>{state.pendingPrompt.message}</strong>
            {state.pendingPrompt.playerIdx === seat ? (
              <span className="prompt__you">your call</span>
            ) : (
              <span className="prompt__wait">waiting on opponent…</span>
            )}
          </div>
        )}
        <div className="controls">
          <button disabled={!myTurn} onClick={() => onAction('advanceStep')}>
            Advance step
          </button>
          <button disabled={!myTurn || state.step !== 'powerUp'} onClick={() => onAction('powerUp')}>
            Power up
          </button>
          <button disabled={!state.combat} onClick={() => onAction('pass')}>
            Pass
          </button>
        </div>
        {state.phase === 'ended' && (
          <div className="ended">
            Winner: {state.players[state.winnerIdx ?? 0]?.name} ({state.victoryType})
          </div>
        )}
      </div>

      {me && <Side player={me} own active={myTurn} />}

      <aside className="log">
        {state.log.slice(-40).map((line, i) => (
          <div key={i} className="log__line">
            {line}
          </div>
        ))}
      </aside>
    </div>
  );
}

/**
 * Board — one screen showing both sides, the step track, the log, and every
 * control the local player currently has.
 *
 * The local seat is always rendered at the bottom. Zones show counts rather
 * than contents where the rules keep them hidden; redaction already happened
 * server-side, so a blank cardId here simply means "not for you to see".
 *
 * What a hand card does depends on what the game is waiting for, so the board
 * derives a single `handMode` from state and passes it down — nothing else in
 * the UI has to re-derive that.
 */
import type { AttackType, GameState, PlayerState, Step } from '@dbz/shared';
import { STEPS } from '@dbz/shared';
import type { CardDb } from '@dbz/engine';
import { Scouter } from './Scouter.tsx';
import { AngerSword } from './AngerSword.tsx';
import { Hand, type HandMode } from './Hand.tsx';
import { PromptPanel, type PromptChoice } from './PromptPanel.tsx';

export interface BoardProps {
  state: GameState;
  seat: number | null;
  db: CardDb | null;
  onAdvanceStep(): void;
  onPowerUp(): void;
  onPass(): void;
  onAttack(attackType: AttackType, cardUid?: string): void;
  onAnswer(promptId: string, choice: PromptChoice | string | null): void;
  onConcede(): void;
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

export function Board({
  state,
  seat,
  db,
  onAdvanceStep,
  onPowerUp,
  onPass,
  onAttack,
  onAnswer,
  onConcede,
}: BoardProps) {
  // Spectators have no seat but still need both sides laid out.
  const bottomIdx = seat ?? 1;
  const me = state.players[bottomIdx];
  const foe = state.players.find((p) => p.idx !== bottomIdx);
  const myTurn = seat != null && state.activePlayerIdx === seat;
  const prompt = state.pendingPrompt;

  const combat = state.combat;
  const myAttackPhase = seat != null && combat !== undefined && combat.phasePlayerIdx === seat && !combat.currentAttack;
  const awaitingMyDefence = prompt?.type === 'defend' && prompt.playerIdx === seat;

  // One derivation of what a hand click means right now.
  const handMode: HandMode = awaitingMyDefence ? 'defend' : myAttackPhase ? 'attack' : 'idle';

  const useCard = (cardUid: string) => {
    if (handMode === 'defend' && prompt) onAnswer(prompt.id, { cardUid });
    else if (handMode === 'attack') onAttack('physical', cardUid);
  };

  return (
    <div className="board">
      {foe && <Side player={foe} own={false} active={state.activePlayerIdx === foe.idx} />}

      <div className="board__mid">
        <StepTrack step={state.step} turn={state.turnNumber} />

        {prompt && (
          <PromptPanel
            prompt={prompt}
            seat={seat}
            canDefendWith={me?.zones.hand.length ?? 0}
            onAnswer={(choice) => onAnswer(prompt.id, choice)}
          />
        )}

        {myAttackPhase && !prompt && (
          <div className="attackbar">
            <strong>Your Attack Phase</strong>
            <button onClick={() => onAttack('physical')}>Physical attack</button>
            <button onClick={() => onAttack('energy')}>Energy attack</button>
            <span className="muted">or click a Combat card in hand</span>
          </div>
        )}

        <div className="controls">
          <button disabled={!myTurn || !!prompt} onClick={onAdvanceStep}>
            Advance step
          </button>
          <button disabled={!myTurn || state.step !== 'powerUp' || !!prompt} onClick={onPowerUp}>
            Power up
          </button>
          <button disabled={!combat || !!prompt || seat === null || combat.phasePlayerIdx !== seat} onClick={onPass}>
            Pass
          </button>
          {seat !== null && state.phase === 'playing' && (
            <button className="ghost danger" onClick={onConcede}>
              Concede
            </button>
          )}
        </div>

        {state.phase === 'ended' && (
          <div className="ended">
            {state.players[state.winnerIdx ?? 0]?.name} wins — {state.victoryType}
          </div>
        )}
      </div>

      {me && <Side player={me} own active={myTurn} />}

      {seat !== null && me && (
        <div className="board__hand">
          <Hand cards={me.zones.hand} db={db} mode={handMode} onUse={useCard} />
        </div>
      )}

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

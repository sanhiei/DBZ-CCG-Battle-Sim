/**
 * Board — one screen showing both sides, the step track, the log, and every
 * control the local player currently has.
 *
 * The local seat is always rendered at the bottom. Zones show counts rather
 * than contents where the rules keep them hidden; redaction already happened
 * server-side, so a blank cardId here simply means "not for you to see".
 *
 * Two gestures, and they mean different things. CLICK reads a card — a hand
 * card, a card in play, a personality — and never commits anything. DRAG plays
 * it: where you drop it is what it does, so an attack goes onto your opponent's
 * half and a Drill onto your own. Clicking used to do both, which made the only
 * way to look at a card be to play it.
 *
 * What a drop means depends on what the game is waiting for, so the board
 * derives a single `handMode` and a drop intent per side from state; nothing
 * else in the UI re-derives that.
 */
import { useState } from 'react';
import type { AttackType, GameState, PersonalityInPlay, Step, Zone } from '@dbz/shared';
import { BATTLE_SEQUENCE } from '@dbz/shared';
import { STEPS } from '@dbz/shared';
import type { CardDb } from '@dbz/engine';
import { Hand, type HandMode } from './Hand.tsx';
import { Field, type DropIntent } from './Field.tsx';
import { PromptPanel, type PromptChoice } from './PromptPanel.tsx';
import { ManualPanel } from './ManualPanel.tsx';
import { CardDetail } from './CardDetail.tsx';
import { PlaymatPicker, usePlaymat } from './Playmat.tsx';
import { PatTableView } from './PatTableView.tsx';
import { getPatTable } from '@dbz/engine';

export interface BoardProps {
  state: GameState;
  seat: number | null;
  db: CardDb | null;
  onAdvanceStep(): void;
  onPowerUp(): void;
  onPass(): void;
  onAttack(attackType: AttackType, cardUid?: string): void;
  onFinalPhysicalAttack(discardUid: string): void;
  onUsePower(): void;
  onAnswer(promptId: string, choice: PromptChoice | string | null): void;
  onConcede(): void;
  onSetStage(personalityUid: string, stageIndex: number): void;
  onSetAnger(personalityUid: string, anger: number): void;
  onMoveCard(cardUid: string, toZone: Zone): void;
  onPlayCard(cardUid: string): void;
}

/** Current power rating of a personality anywhere on the table. */
function findRating(state: GameState, uid: string): number | undefined {
  for (const p of state.players) {
    if (p.mp.uid === uid) return typeof p.mp.currentRating === 'number' ? p.mp.currentRating : undefined;
    const ally = p.allies.find((a) => a.uid === uid);
    if (ally) return typeof ally.currentRating === 'number' ? ally.currentRating : undefined;
  }
  return undefined;
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
  onFinalPhysicalAttack,
  onUsePower,
  onAnswer,
  onConcede,
  onSetStage,
  onSetAnger,
  onMoveCard,
  onPlayCard,
}: BoardProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  /** A card in hand opened for reading. */
  const [inspecting, setInspecting] = useState<string | null>(null);
  /** Any catalog card opened for reading (in play, or a personality). */
  const [reading, setReading] = useState<string | null>(null);
  /** The personality whose card is open, so its power can be offered. */
  const [openPersonality, setOpenPersonality] = useState<PersonalityInPlay | null>(null);
  /** Waiting for the player to pick the card that pays for a Final Physical Attack. */
  const [armingFinal, setArmingFinal] = useState(false);
  /** The hand card currently being dragged, so the fields can light up. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [patOpen, setPatOpen] = useState(false);
  const playmat = usePlaymat();

  // Spectators have no seat but still need both sides laid out.
  const bottomIdx = seat ?? 1;
  const me = state.players[bottomIdx];
  const foe = state.players.find((p) => p.idx !== bottomIdx);
  const myTurn = seat != null && state.activePlayerIdx === seat;
  const prompt = state.pendingPrompt;
  const over = state.phase === 'ended';

  const combat = state.combat;
  const myAttackPhase = seat != null && combat !== undefined && combat.phasePlayerIdx === seat && !combat.currentAttack;
  const awaitingMyDefence = prompt?.type === 'defend' && prompt.playerIdx === seat;
  const myNonCombatStep = seat != null && state.activePlayerIdx === seat && state.step === 'nonCombat';

  // A Personality Power belongs to whoever is in Control of Combat, and it is
  // once per turn (CRD ~L492).
  const myController = me ? me.allies.find((a) => a.inControlOfCombat) ?? me.mp : undefined;
  const powerCardId = myController?.levelCardIds[myController.currentLevel - 1];
  const hasPower = !!db && !!powerCardId
    && (db.get(powerCardId)?.rules?.abilities ?? []).some((a) => a.trigger === 'personalityPower');
  const canUsePower = myAttackPhase && hasPower && myController?.usedPowerTurn !== state.turnNumber;

  const handMode: HandMode = over
    ? 'idle'
    : awaitingMyDefence
      ? 'defend'
      : myAttackPhase && armingFinal
        ? 'final'
        : myAttackPhase
          ? 'attack'
          : myNonCombatStep
            ? 'play'
            : 'idle';

  /**
   * Where a dragged card may be dropped, and what that means. An attack goes at
   * your opponent; everything else stays on your own half. Nothing lights up
   * when no card is in the air, so the board is quiet until you pick one up.
   */
  const intentFor = (own: boolean): DropIntent | null => {
    if (!dragging) return null;
    if (handMode === 'attack' || handMode === 'final') return own ? null : 'attack';
    if (handMode === 'defend') return own ? 'defend' : null;
    if (handMode === 'play') return own ? 'play' : null;
    return null;
  };

  const dropCard = (cardUid: string) => {
    setDragging(null);
    if (handMode === 'defend' && prompt) onAnswer(prompt.id, { cardUid });
    else if (handMode === 'final') {
      setArmingFinal(false);
      onFinalPhysicalAttack(cardUid);
    } else if (handMode === 'attack') onAttack('physical', cardUid);
    else if (handMode === 'play') onPlayCard(cardUid);
  };

  const inspected = me?.zones.hand.find((c) => c.uid === inspecting);
  const readingCard = reading ? db?.get(reading) : undefined;

  const openPersonalityCard = (p: PersonalityInPlay) => {
    const cardId = p.levelCardIds[p.currentLevel - 1];
    if (!cardId) return;
    setOpenPersonality(p);
    setReading(cardId);
  };

  // Only offered on your OWN personality, only the one in Control, and only
  // when the engine would actually accept it.
  const personalityActions =
    openPersonality && me && (openPersonality.uid === myController?.uid) && canUsePower
      ? [
          {
            label: 'Use Personality Power',
            run: () => {
              onUsePower();
              setReading(null);
              setOpenPersonality(null);
            },
          },
        ]
      : [];

  return (
    <div className={`board ${logOpen ? '' : 'board--nolog'}`}>
      <div className="board__table">
        {foe && (
          <Field
            player={foe}
            own={false}
            active={state.activePlayerIdx === foe.idx}
            db={db}
            mat={null}
            dropIntent={intentFor(false)}
            onDropCard={dropCard}
            onInspectPersonality={openPersonalityCard}
            onInspectCard={setReading}
          />
        )}

        <div className="board__mid">
          <StepTrack step={state.step} turn={state.turnNumber} />

          {combat?.currentAttack && (
            <p className="seqbar">
              <span className="seqbar__n">Battle Sequence {combat.currentAttack.resolutionStep}/16</span>
              <span className="seqbar__label">
                {BATTLE_SEQUENCE[combat.currentAttack.resolutionStep] ?? 'resolving'}
              </span>
            </p>
          )}

          {prompt && (
            <PromptPanel
              prompt={prompt}
              seat={seat}
              canDefendWith={me?.zones.hand.length ?? 0}
              onAnswer={(choice) => onAnswer(prompt.id, choice)}
            />
          )}

          {myNonCombatStep && !prompt && (
            <div className="attackbar">
              <strong>Non-Combat Step</strong>
              <span className="muted">Drag a Non-Combat card, Drill, Location or Ball onto your side</span>
            </div>
          )}

          {myAttackPhase && !prompt && (
            <div className="attackbar">
              <strong>Your Attack Phase</strong>
              {armingFinal ? (
                <>
                  <span className="muted">Drag any card onto your opponent to spend it</span>
                  <button className="ghost" onClick={() => setArmingFinal(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="muted">Drag a Combat card onto your opponent to attack</span>
                  <button onClick={onUsePower} disabled={!canUsePower}>
                    Use Personality Power
                  </button>
                  <button
                    className="ghost"
                    onClick={() => setArmingFinal(true)}
                    disabled={(me?.zones.hand.length ?? 0) === 0}
                  >
                    Final Physical Attack
                  </button>
                </>
              )}
            </div>
          )}

          {/* Once the game is over every one of these is refused by the server,
              so leaving them live just produced a row of errors at exactly the
              moment a player is deciding whether to play again. */}
          <div className="controls">
            <button disabled={over || !myTurn || !!prompt} onClick={onAdvanceStep}>
              Advance step
            </button>
            {/* Entering the Power-Up Step claims the once-per-turn flag, so this
                is the manual fallback for the case where something cleared it —
                not a second free power-up. */}
            <button
              disabled={over || !myTurn || state.step !== 'powerUp' || !!prompt || !!state.poweredUpThisTurn}
              onClick={onPowerUp}
            >
              Power up
            </button>
            <button
              disabled={over || !combat || !!prompt || seat === null || combat.phasePlayerIdx !== seat}
              onClick={onPass}
            >
              Pass
            </button>
            <button className="ghost" onClick={() => setPatOpen(true)} title="Physical Attack Table">
              PAT
            </button>
            <PlaymatPicker
              mat={playmat.mat}
              error={playmat.error}
              onPick={playmat.set}
              onClear={playmat.clear}
            />
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

        {me && (
          <Field
            player={me}
            own
            active={myTurn}
            db={db}
            mat={playmat.mat}
            dropIntent={intentFor(true)}
            onDropCard={dropCard}
            onInspectPersonality={openPersonalityCard}
            onInspectCard={setReading}
          />
        )}
      </div>

      {seat !== null && me && (
        <div className="board__hand">
          <Hand
            cards={me.zones.hand}
            db={db}
            mode={handMode}
            onInspect={setInspecting}
            onDragChange={setDragging}
          />
        </div>
      )}

      <aside className={`log ${logOpen ? '' : 'log--closed'}`}>
        <button className="log__toggle" onClick={() => setLogOpen((v) => !v)}>
          {logOpen ? '▶ hide log' : '◀ log'}
        </button>
        {logOpen &&
          state.log.slice(-60).map((line, i) => (
            <div key={i} className="log__line">
              {line}
            </div>
          ))}
      </aside>

      <ManualPanel
        state={state}
        seat={seat}
        open={manualOpen}
        onToggle={() => setManualOpen((v) => !v)}
        onSetStage={onSetStage}
        onSetAnger={onSetAnger}
        onMoveCard={onMoveCard}
      />

      {inspected && (
        <CardDetail
          card={db?.get(inspected.cardId)}
          onClose={() => setInspecting(null)}
          actions={[
            { label: 'Discard', run: () => { onMoveCard(inspected.uid, 'discard'); setInspecting(null); } },
            { label: 'Put in play', run: () => { onMoveCard(inspected.uid, 'inPlay'); setInspecting(null); } },
            { label: 'Remove from game', run: () => { onMoveCard(inspected.uid, 'removed'); setInspecting(null); } },
          ]}
        />
      )}

      {patOpen && (
        <PatTableView
          table={getPatTable()}
          // Highlight the row and column this combat is actually using, so the
          // table answers "why did that hit for 3?" rather than just listing
          // numbers.
          attackerRating={
            combat?.currentAttack
              ? findRating(state, combat.currentAttack.attackerControllerUid)
              : undefined
          }
          defenderRating={
            combat?.currentAttack
              ? findRating(state, combat.currentAttack.defenderControllerUid)
              : undefined
          }
          onClose={() => setPatOpen(false)}
        />
      )}

      {readingCard && (
        <CardDetail
          card={readingCard}
          onClose={() => {
            setReading(null);
            setOpenPersonality(null);
          }}
          actions={personalityActions}
        />
      )}
    </div>
  );
}

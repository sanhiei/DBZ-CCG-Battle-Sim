/**
 * Answers the engine's pending decision.
 *
 * The engine surfaces every required choice as `state.pendingPrompt`; this
 * renders the controls for whichever kind is outstanding and sends the matching
 * `answerPrompt`. Prompts aimed at the opponent render as a waiting notice, so
 * both players can see what the game is blocked on.
 */
import type { Prompt } from '@dbz/shared';

export interface PromptChoice {
  cardUid?: string;
  takeDamage?: boolean;
  uid?: string | null;
  toUid?: string | null;
}

export interface PromptPanelProps {
  prompt: Prompt;
  seat: number | null;
  /** Cards the local player could answer with (hand), for the defend case. */
  canDefendWith: number;
  onAnswer(choice: PromptChoice | string | null): void;
}

interface Option {
  uid: string;
  name: string;
}

function options(prompt: Prompt): Option[] {
  if (!Array.isArray(prompt.options)) return [];
  return prompt.options.filter((o): o is Option => typeof o === 'object' && o !== null && 'uid' in o);
}

export function PromptPanel({ prompt, seat, canDefendWith, onAnswer }: PromptPanelProps) {
  const mine = prompt.playerIdx === seat;

  if (!mine) {
    return (
      <div className="prompt prompt--waiting">
        <strong>{prompt.message}</strong>
        <span className="prompt__wait">waiting on opponent…</span>
      </div>
    );
  }

  return (
    <div className="prompt prompt--mine">
      <strong>{prompt.message}</strong>
      <div className="prompt__actions">
        {prompt.type === 'defend' && (
          <>
            <button onClick={() => onAnswer({ takeDamage: true })}>Take the damage</button>
            <span className="muted">
              {canDefendWith > 0
                ? 'or click a card in hand to defend with it'
                : 'no cards in hand to defend with'}
            </span>
          </>
        )}

        {prompt.type === 'redirect' && (
          <>
            {options(prompt).map((o) => (
              <button key={o.uid} onClick={() => onAnswer({ toUid: o.uid })}>
                Redirect to {o.name}
              </button>
            ))}
            <button className="ghost" onClick={() => onAnswer({ toUid: null })}>
              Take it on the controller
            </button>
          </>
        )}

        {prompt.type === 'capture' && (
          <>
            {options(prompt).map((o) => (
              <button key={o.uid} onClick={() => onAnswer({ uid: o.uid })}>
                Capture {o.name}
              </button>
            ))}
            <button className="ghost" onClick={() => onAnswer({ uid: null })}>
              Decline
            </button>
          </>
        )}

        {!['defend', 'redirect', 'capture'].includes(prompt.type) && (
          <span className="muted">
            No UI for prompt type “{prompt.type}” yet — resolve it manually.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Per-recipient redaction. The authoritative state holds every hidden zone in
 * the clear; each connection only ever receives what that seat may legally see.
 * Hidden cards keep their `uid` (so counts and animations line up) but lose
 * their `cardId`.
 */
import type { CardInstance, GameState, PlayerState, Prompt, Zone } from '@dbz/shared';

/** cardId of a card the recipient is not allowed to identify. */
export const HIDDEN_CARD_ID = '';

function hide(inst: CardInstance): CardInstance {
  return { uid: inst.uid, cardId: HIDDEN_CARD_ID, faceDown: true };
}

const hideAll = (cards: CardInstance[]): CardInstance[] => cards.map(hide);

/** In play, only face-down-and-unrevealed cards are secret, and only from opponents. */
function redactInPlay(cards: CardInstance[], own: boolean): CardInstance[] {
  return cards.map((c) => (own || !c.faceDown || c.revealed ? c : hide(c)));
}

function redactPlayer(p: PlayerState, own: boolean): PlayerState {
  const zones: Record<Zone, CardInstance[]> = {
    ...p.zones,
    // The Life Deck is secret from everyone, including its owner (order matters).
    lifeDeck: hideAll(p.zones.lifeDeck),
    hand: own ? p.zones.hand : hideAll(p.zones.hand),
    sensei: own ? p.zones.sensei : hideAll(p.zones.sensei),
    inPlay: redactInPlay(p.zones.inPlay, own),
    // discard + removed are public zones and stay as-is.
  };
  return { ...p, zones };
}

/** Everyone sees that a prompt is pending; only its target sees the options. */
function redactPrompt(prompt: Prompt, viewerIdx: number | null): Prompt {
  if (prompt.playerIdx === viewerIdx) return prompt;
  const { options: _options, ...rest } = prompt;
  return rest;
}

/**
 * Build the view of `state` for one recipient. `viewerIdx` is the seat index,
 * or `null` for a spectator (who sees only public information).
 */
export function viewFor(state: GameState, viewerIdx: number | null): GameState {
  const view: GameState = {
    ...state,
    players: state.players.map((p) => redactPlayer(p, p.idx === viewerIdx)),
  };
  if (state.pendingPrompt) view.pendingPrompt = redactPrompt(state.pendingPrompt, viewerIdx);
  return view;
}

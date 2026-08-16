/** Client<->server protocol and the engine's Action/Event unions. */
import type { AttackType, GameState, Step, Zone } from './state.js';

/**
 * Actions are the only way to mutate game state. They are validated + applied by
 * the engine on the server (authoritatively) and optimistically on the client.
 * Every action carries a clientActionId for reconciliation.
 */
export type Action =
  | { type: 'loadDeck'; playerIdx: number; deck: DeckList }
  | { type: 'setReady'; playerIdx: number }
  | { type: 'chooseFirstPlayer'; playerIdx: number; firstIdx: number }
  | { type: 'advanceStep' }
  | { type: 'powerUp'; playerIdx: number }
  | { type: 'setStage'; personalityUid: string; stageIndex: number }
  | { type: 'setAnger'; personalityUid: string; anger: number }
  | { type: 'playAlly'; playerIdx: number; cardUid: string }
  | { type: 'drawCards'; playerIdx: number; count: number }
  | { type: 'moveCard'; cardUid: string; toZone: Zone; toPlayerIdx?: number }
  | { type: 'declareAttack'; attackType: AttackType; cardUid?: string }
  | { type: 'takeControlOfCombat'; personalityUid: string }
  | { type: 'declareEmpower'; amount: number }
  | { type: 'defend'; cardUid?: string; takeDamage?: boolean }
  | { type: 'redirectDamage'; toPersonalityUid: string }
  | { type: 'captureDragonBall'; ballUid: string }
  | { type: 'useEndurance'; cardUid?: string }
  | { type: 'pass' }
  | { type: 'answerPrompt'; promptId: string; choice: unknown }
  | { type: 'concede'; playerIdx: number }
  | { type: 'chat'; playerIdx: number; text: string };

export type ActionWithMeta = Action & { clientActionId: string };

/** Emitted by the engine so the UI can animate / log what happened. */
export type GameEvent =
  | { type: 'stepChanged'; step: Step; turnNumber: number; activePlayerIdx: number }
  | { type: 'poweredUp'; playerIdx: number }
  | { type: 'stageChanged'; personalityUid: string; from: number; to: number }
  | { type: 'angerChanged'; personalityUid: string; from: number; to: number }
  | { type: 'personalityAdvanced'; personalityUid: string; toLevel: number }
  | { type: 'attackDeclared'; attackType: AttackType }
  | { type: 'attackResolved'; successful: boolean; powerStages: number; lifeCards: number }
  | { type: 'dragonBallCaptured'; ballUid: string; byPlayerIdx: number }
  | { type: 'prompt'; playerIdx: number; promptId: string }
  | { type: 'gameEnded'; winnerIdx: number; victoryType: string }
  | { type: 'log'; message: string };

export interface ReduceResult {
  state: GameState;
  events: GameEvent[];
  /** If the action was illegal, why (state unchanged). */
  error?: string;
}

/** A deck the client submits. Card ids reference the catalog. */
export interface DeckList {
  name: string;
  /** Ordered MP personality level card ids (level 1..N). */
  mpLevels: string[];
  masteryId?: string;
  senseiId?: string;
  /** cardId -> quantity for the Life Deck. */
  life: Array<{ cardId: string; qty: number }>;
  senseiDeck?: Array<{ cardId: string; qty: number }>;
}

/* ---- Lobby (pre-game) ---- */

/** One seat in a room before the game starts. */
export interface LobbySeat {
  idx: number;
  name: string;
  connected: boolean;
  /** Name of the submitted deck, if any. */
  deckName?: string;
  ready: boolean;
}

/** Room state before `createGame` runs. Replaced by `GameState` once started. */
export interface LobbyView {
  roomCode: string;
  seats: LobbySeat[];
  spectators: number;
  started: boolean;
}

/* ---- WebSocket envelopes ---- */

export type ClientMessage =
  | { kind: 'join'; roomCode: string; playerName: string; token?: string; spectate?: boolean }
  | { kind: 'action'; action: ActionWithMeta }
  | { kind: 'ping' };

export type ServerMessage =
  | { kind: 'session'; roomCode: string; token: string; playerIdx: number | null; spectate: boolean }
  /** `clientActionId` echoes a lobby action (loadDeck/setReady) so the client
   *  can retire the matching optimistic prediction. */
  | { kind: 'lobby'; lobby: LobbyView; clientActionId?: string }
  /**
   * Authoritative state, redacted for the recipient. `clientActionId` echoes the
   * action that produced this broadcast so a client can retire the matching
   * optimistic prediction.
   */
  | { kind: 'state'; state: GameState; events: GameEvent[]; clientActionId?: string }
  | { kind: 'error'; message: string; clientActionId?: string }
  | { kind: 'pong' };

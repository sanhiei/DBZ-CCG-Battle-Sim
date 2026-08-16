import type { Action, GameEvent, GameState, LobbyView } from '@dbz/shared';
import { CardDb, type EngineCard } from '@dbz/engine';
export type ConnState = 'connecting' | 'open' | 'closed' | 'error';
export interface GameSession {
    conn: ConnState;
    /** Seat index, or null while spectating. */
    seat: number | null;
    roomCode: string | null;
    lobby: LobbyView | null;
    /** State with local predictions applied — what the UI should render. */
    state: GameState | null;
    events: GameEvent[];
    errors: string[];
    db: CardDb | null;
    cards: EngineCard[];
    pendingCount: number;
    join(roomCode: string, playerName: string, spectate?: boolean): void;
    send(action: Action): void;
}
export declare function useGame(): GameSession;
//# sourceMappingURL=useGame.d.ts.map
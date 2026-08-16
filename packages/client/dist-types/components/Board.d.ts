/**
 * Board — one screen showing both sides, the step track, and the log.
 *
 * The local seat is always rendered at the bottom. Zones show counts rather
 * than contents where the rules keep them hidden; redaction already happened
 * server-side, so a blank cardId here simply means "not for you to see".
 */
import type { GameState } from '@dbz/shared';
export interface BoardProps {
    state: GameState;
    seat: number | null;
    onAction(kind: 'advanceStep' | 'powerUp' | 'pass'): void;
    onOpenCard(cardId: string): void;
}
export declare function Board({ state, seat, onAction }: BoardProps): import("react").JSX.Element;
//# sourceMappingURL=Board.d.ts.map
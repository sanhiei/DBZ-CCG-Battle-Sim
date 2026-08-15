/**
 * A room: two seats, any number of spectators, one authoritative GameState.
 *
 * Transport-agnostic on purpose — a client is anything with a `send`, so rooms
 * are unit-testable without sockets. `hub.ts` adapts WebSockets onto this.
 *
 * Lifecycle: lobby (seats submit decks + ready up) -> `createGame` -> playing.
 * The reducer owns everything from `createGame` onward; the lobby lives here
 * because there is no GameState to reduce against yet.
 */
import { randomUUID } from 'node:crypto';
import type {
  ActionWithMeta,
  DeckList,
  GameEvent,
  GameState,
  LobbySeat,
  LobbyView,
  ServerMessage,
} from '@dbz/shared';
import { createGame, reduce, type CardDb } from '@dbz/engine';
import { viewFor } from './redact.js';
import { validateDeck, type DeckValidationOptions } from './decks.js';

export const SEAT_COUNT = 2;

export interface RoomClient {
  id: string;
  send(msg: ServerMessage): void;
}

interface Seat {
  token: string;
  name: string;
  deck?: DeckList;
  ready: boolean;
  /** Client currently occupying this seat, if connected. */
  clientId?: string;
}

export interface RoomOptions {
  db: CardDb;
  /** Fixed seed makes a game reproducible; defaults to random. */
  seed?: number;
  deckRules?: DeckValidationOptions;
}

export interface JoinRequest {
  client: RoomClient;
  playerName: string;
  /** Reconnect token from a previous session. */
  token?: string;
  spectate?: boolean;
}

export interface JoinResult {
  seatIdx: number | null;
  token: string;
}

export class Room {
  readonly code: string;
  private readonly db: CardDb;
  private readonly seed: number;
  private readonly deckRules: DeckValidationOptions;
  private readonly seats: Array<Seat | null> = new Array(SEAT_COUNT).fill(null);
  /** clientId -> seat index, or null for spectators. */
  private readonly clients = new Map<string, { client: RoomClient; seatIdx: number | null }>();
  private state: GameState | undefined;
  /** Set when the last client leaves; used by the hub to reap idle rooms. */
  emptySince: number | undefined;

  constructor(code: string, opts: RoomOptions) {
    this.code = code;
    this.db = opts.db;
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.deckRules = opts.deckRules ?? {};
  }

  get started(): boolean {
    return this.state !== undefined;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Current authoritative state (undefined while in the lobby). Read-only. */
  get gameState(): GameState | undefined {
    return this.state;
  }

  // ---- membership ----

  join(req: JoinRequest): JoinResult {
    const { client, playerName, token } = req;
    const name = sanitizeName(playerName);

    // 1. Reconnect: a matching token reclaims its seat, even mid-game.
    const existing = token ? this.seats.findIndex((s) => s?.token === token) : -1;
    if (existing !== -1) {
      const seat = this.seats[existing]!;
      seat.clientId = client.id;
      seat.name = name || seat.name;
      this.clients.set(client.id, { client, seatIdx: existing });
      this.syncConnected();
      this.emptySince = undefined;
      return { seatIdx: existing, token: seat.token };
    }

    // 2. Spectators, and anyone arriving after both seats are taken.
    const free = this.seats.findIndex((s) => s === null);
    if (req.spectate || free === -1 || this.started) {
      this.clients.set(client.id, { client, seatIdx: null });
      this.emptySince = undefined;
      return { seatIdx: null, token: token ?? randomUUID() };
    }

    // 3. New player takes the open seat.
    const seat: Seat = { token: randomUUID(), name: name || `Player ${free + 1}`, ready: false, clientId: client.id };
    this.seats[free] = seat;
    this.clients.set(client.id, { client, seatIdx: free });
    this.syncConnected();
    this.emptySince = undefined;
    return { seatIdx: free, token: seat.token };
  }

  /** Drop a connection. The seat is held (token-reclaimable), not vacated. */
  leave(clientId: string): void {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    this.clients.delete(clientId);
    if (entry.seatIdx !== null) {
      const seat = this.seats[entry.seatIdx];
      if (seat?.clientId === clientId) delete seat.clientId;
      // An un-started room releases the seat outright so the code stays usable.
      if (!this.started && seat && !seat.deck) this.seats[entry.seatIdx] = null;
      this.syncConnected();
    }
    if (this.clients.size === 0) this.emptySince = Date.now();
    this.broadcast();
  }

  seatOf(clientId: string): number | null {
    return this.clients.get(clientId)?.seatIdx ?? null;
  }

  // ---- actions ----

  /**
   * Apply one client action. Lobby actions (`loadDeck`, `setReady`) are handled
   * here; everything else goes to the engine with the sender's seat as the
   * acting player, so a client can never act for its opponent.
   */
  handleAction(clientId: string, action: ActionWithMeta): void {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    const { client, seatIdx } = entry;
    const reject = (message: string) =>
      client.send({ kind: 'error', message, ...(action.clientActionId ? { clientActionId: action.clientActionId } : {}) });

    if (seatIdx === null) return reject('spectators cannot act');

    if (!this.started) {
      switch (action.type) {
        case 'loadDeck':
          return this.loadDeck(seatIdx, action.deck, reject);
        case 'setReady':
          return this.setReady(seatIdx, reject);
        default:
          return reject('game has not started');
      }
    }

    if (action.type === 'loadDeck' || action.type === 'setReady') return reject('game already started');

    const denied = authorize(action, seatIdx, this.state!);
    if (denied) return reject(denied);

    const result = reduce(this.state!, action, this.db, seatIdx);
    if (result.error) return reject(result.error);
    this.state = result.state;
    this.broadcast(result.events, action.clientActionId);
  }

  private loadDeck(seatIdx: number, deck: DeckList, reject: (m: string) => void): void {
    const seat = this.seats[seatIdx];
    if (!seat) return reject('no seat');
    const errors = validateDeck(deck, this.db, this.deckRules);
    if (errors.length) return reject(`illegal deck: ${errors.join('; ')}`);
    seat.deck = deck;
    seat.ready = false; // a new deck un-readies you
    this.broadcast();
  }

  private setReady(seatIdx: number, reject: (m: string) => void): void {
    const seat = this.seats[seatIdx];
    if (!seat) return reject('no seat');
    if (!seat.deck) return reject('load a deck first');
    seat.ready = true;
    if (this.seats.every((s) => s?.ready && s.deck)) this.start();
    else this.broadcast();
  }

  private start(): void {
    const players = this.seats.map((s) => ({ name: s!.name, deck: s!.deck! }));
    this.state = createGame({ seed: this.seed, players }, this.db);
    this.syncConnected();
    this.broadcast();
  }

  // ---- outbound ----

  /** Mirror socket presence into the game state so the UI can show it. */
  private syncConnected(): void {
    if (!this.state) return;
    for (const [idx, seat] of this.seats.entries()) {
      const player = this.state.players[idx];
      if (player) player.connected = seat?.clientId !== undefined;
    }
  }

  lobbyView(): LobbyView {
    const seats: LobbySeat[] = [];
    for (const [idx, seat] of this.seats.entries()) {
      if (!seat) continue;
      const entry: LobbySeat = {
        idx,
        name: seat.name,
        connected: seat.clientId !== undefined,
        ready: seat.ready,
      };
      if (seat.deck) entry.deckName = seat.deck.name;
      seats.push(entry);
    }
    return {
      roomCode: this.code,
      seats,
      spectators: [...this.clients.values()].filter((c) => c.seatIdx === null).length,
      started: this.started,
    };
  }

  private sendTo(client: RoomClient, seatIdx: number | null, events: GameEvent[], clientActionId?: string): void {
    if (!this.state) {
      client.send({ kind: 'lobby', lobby: this.lobbyView() });
      return;
    }
    client.send({
      kind: 'state',
      state: viewFor(this.state, seatIdx),
      events,
      ...(clientActionId ? { clientActionId } : {}),
    });
  }

  /** Push the current lobby/state view to every connection in the room. */
  broadcast(events: GameEvent[] = [], clientActionId?: string): void {
    for (const { client, seatIdx } of this.clients.values()) {
      this.sendTo(client, seatIdx, events, clientActionId);
    }
  }
}

/**
 * Server-side authority checks the reducer does not make. The reducer trusts
 * `actingPlayerIdx` for combat, but actions that carry their own `playerIdx`
 * (drawCards, powerUp, playAlly, concede, …) would otherwise let a client act
 * out of the opponent's seat.
 *
 * Deliberately *not* blocked: uid-targeted manual adjustments (`setStage`,
 * `setAnger`, `moveCard`) on an opponent's cards. Coverage is partial, so those
 * are the tabletop-assist fallback for effects the engine can't resolve yet.
 */
function authorize(action: ActionWithMeta, seatIdx: number, state: GameState): string | undefined {
  const named = (action as { playerIdx?: unknown }).playerIdx;
  if (typeof named === 'number' && named !== seatIdx) return 'cannot act for another player';
  if (action.type === 'advanceStep' && state.activePlayerIdx !== seatIdx) return 'not your turn';
  return undefined;
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 24);
}

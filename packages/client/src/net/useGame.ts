/**
 * The authoritative-server / optimistic-client loop (docs/ARCHITECTURE.md).
 *
 * The SAME reducer runs here as on the server. When the local player acts we
 * apply the action immediately for a responsive UI and remember it as pending.
 * Every server broadcast replaces our base state; pending actions that the
 * broadcast has not yet accounted for are replayed on top of it.
 *
 * A prediction is retired when the server echoes its `clientActionId` (accepted)
 * or rejects it with that id (illegal — the prediction is simply dropped, and
 * the next render shows authority again).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Action,
  ActionWithMeta,
  ClientMessage,
  GameEvent,
  GameState,
  LobbyView,
  ServerMessage,
} from '@dbz/shared';
import { CardDb, reduce, setPatTable, type EngineCard, type PatTable } from '@dbz/engine';

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

const TOKEN_KEY = (room: string) => `dbz.token.${room.toUpperCase()}`;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

let actionSeq = 0;
const nextActionId = () => `a${Date.now().toString(36)}-${actionSeq++}`;

export function useGame(): GameSession {
  const [conn, setConn] = useState<ConnState>('connecting');
  const [seat, setSeat] = useState<number | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [authoritative, setAuthoritative] = useState<GameState | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [cards, setCards] = useState<EngineCard[]>([]);

  const socket = useRef<WebSocket | null>(null);
  /** Predictions awaiting server confirmation, in submission order. */
  const pending = useRef<ActionWithMeta[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const seatRef = useRef<number | null>(null);
  seatRef.current = seat;

  const db = useMemo(() => (cards.length ? new CardDb(cards) : null), [cards]);

  // Catalog powers both the local reducer and the card browser.
  useEffect(() => {
    let alive = true;
    fetch('/api/cards')
      .then((r) => r.json() as Promise<{ cards: EngineCard[] }>)
      .then((body) => {
        if (alive) setCards(body.cards ?? []);
      })
      .catch(() => setErrors((e) => [...e, 'could not load the card catalog']));
    return () => {
      alive = false;
    };
  }, []);

  // Load the authoritative PAT before rendering any bracket letter — the engine
  // otherwise falls back to its clearly-marked placeholder grid.
  const [patReady, setPatReady] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/pat')
      .then((r) => r.json() as Promise<PatTable>)
      .then((table) => {
        if (!alive) return;
        if (table?.brackets?.length) setPatTable(table);
        setPatReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setErrors((e) => [...e, 'could not load the Physical Attack Table — brackets may be wrong']);
        setPatReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl());
    socket.current = ws;
    ws.onopen = () => setConn('open');
    ws.onclose = () => setConn('closed');
    ws.onerror = () => setConn('error');
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.kind) {
        case 'session':
          setSeat(msg.playerIdx);
          setRoomCode(msg.roomCode);
          // Kept so a reload or a dropped socket can reclaim the same seat.
          try {
            localStorage.setItem(TOKEN_KEY(msg.roomCode), msg.token);
          } catch {
            /* private mode — reconnect will just take a new seat */
          }
          break;
        case 'lobby':
          setLobby(msg.lobby);
          break;
        case 'state': {
          if (msg.clientActionId) retire(msg.clientActionId);
          setAuthoritative(msg.state);
          if (msg.events.length) setEvents((prev) => [...prev, ...msg.events].slice(-200));
          break;
        }
        case 'error': {
          if (msg.clientActionId) retire(msg.clientActionId);
          setErrors((prev) => [...prev, msg.message].slice(-20));
          break;
        }
        case 'pong':
          break;
      }
    };

    const retire = (id: string) => {
      const before = pending.current.length;
      pending.current = pending.current.filter((a) => a.clientActionId !== id);
      if (pending.current.length !== before) setPendingCount(pending.current.length);
    };

    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'ping' } satisfies ClientMessage));
    }, 25_000);

    return () => {
      clearInterval(heartbeat);
      ws.close();
    };
  }, []);

  const join = useCallback((code: string, playerName: string, spectate = false) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    let token: string | undefined;
    try {
      token = localStorage.getItem(TOKEN_KEY(code)) ?? undefined;
    } catch {
      token = undefined;
    }
    const msg: ClientMessage = {
      kind: 'join',
      roomCode: code,
      playerName,
      ...(token ? { token } : {}),
      ...(spectate ? { spectate } : {}),
    };
    ws.send(JSON.stringify(msg));
  }, []);

  const send = useCallback((action: Action) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    const withMeta = { ...action, clientActionId: nextActionId() } as ActionWithMeta;
    pending.current = [...pending.current, withMeta];
    setPendingCount(pending.current.length);
    ws.send(JSON.stringify({ kind: 'action', action: withMeta } satisfies ClientMessage));
  }, []);

  /**
   * Render state = authority + un-retired predictions. Recomputed rather than
   * mutated so a rejected prediction disappears with no rollback bookkeeping.
   * A prediction that the local reducer rejects is skipped, not applied — the
   * server is the one that decides, and its verdict is already in flight.
   */
  const state = useMemo(() => {
    if (!authoritative || !db) return authoritative;
    let s = authoritative;
    for (const action of pending.current) {
      const result = reduce(s, action, db, seatRef.current ?? undefined);
      if (!result.error) s = result.state;
    }
    return s;
  }, [authoritative, db, pendingCount, patReady]);

  return {
    conn,
    seat,
    roomCode,
    lobby,
    state,
    events,
    errors,
    db,
    cards,
    pendingCount,
    join,
    send,
  };
}

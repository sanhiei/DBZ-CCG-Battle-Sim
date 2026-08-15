/**
 * WebSocket game server + a small HTTP surface for the catalog.
 *
 *   ws://host/            game protocol (see @dbz/shared ClientMessage/ServerMessage)
 *   GET /health           liveness + room count
 *   GET /api/cards        the card catalog, for the client's browser/deck builder
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@dbz/shared';
import { loadCatalog, type Catalog } from './catalog.js';
import { loadPatTable } from './pat.js';
import { Hub } from './hub.js';
import type { Room, RoomClient } from './room.js';

/** Decks are the largest legitimate payload; anything past this is abuse. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 60_000;

interface Connection {
  id: string;
  alive: boolean;
  room?: Room;
}

export interface ServerHandle {
  http: HttpServer;
  wss: WebSocketServer;
  hub: Hub;
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  host?: string;
  catalog?: Catalog;
  /** Fixed seed for every room — handy for reproducible dev games. */
  seed?: number;
  /** Relax the 50-card minimum (dev only). */
  allowSmallDecks?: boolean;
}

export async function startServer(opts: StartOptions = {}): Promise<ServerHandle> {
  const catalog = opts.catalog ?? loadCatalog();

  // Must happen before any combat resolves, or physical attacks use invented numbers.
  const pat = loadPatTable();
  if (pat.warning) console.warn(`[dbz] PAT: ${pat.warning}`);
  const hub = new Hub(catalog.db, {
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    deckRules: { enforceSize: !opts.allowSmallDecks },
  });

  const http = createServer((req, res) => handleHttp(req, res, catalog, hub));
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD_BYTES });

  const connections = new WeakMap<WebSocket, Connection>();
  wss.on('connection', (ws) => {
    const conn: Connection = { id: randomUUID(), alive: true };
    connections.set(ws, conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (raw) => handleMessage(ws, conn, hub, String(raw)));
    ws.on('close', () => conn.room?.leave(conn.id));
    ws.on('error', () => conn.room?.leave(conn.id));
  });

  // Drop connections that stopped answering pings, and reap idle rooms.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = connections.get(ws);
      if (conn && !conn.alive) {
        ws.terminate(); // 'close' fires and releases the seat for reconnect
        continue;
      }
      if (conn) conn.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(() => hub.sweep(), SWEEP_MS);
  heartbeat.unref?.();
  sweeper.unref?.();

  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });
  const address = http.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    http,
    wss,
    hub,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearInterval(sweeper);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(ws: WebSocket, conn: Connection, hub: Hub, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return send(ws, { kind: 'error', message: 'malformed message' });
  }
  if (!msg || typeof msg !== 'object') return send(ws, { kind: 'error', message: 'malformed message' });

  switch (msg.kind) {
    case 'ping':
      return send(ws, { kind: 'pong' });

    case 'join': {
      if (conn.room) return send(ws, { kind: 'error', message: 'already joined' });
      const room = hub.getOrCreate(msg.roomCode);
      const client: RoomClient = { id: conn.id, send: (m) => send(ws, m) };
      const { seatIdx, token } = room.join({
        client,
        playerName: msg.playerName,
        ...(msg.token ? { token: msg.token } : {}),
        ...(msg.spectate ? { spectate: msg.spectate } : {}),
      });
      conn.room = room;
      send(ws, { kind: 'session', roomCode: room.code, token, playerIdx: seatIdx, spectate: seatIdx === null });
      room.broadcast();
      return;
    }

    case 'action': {
      if (!conn.room) return send(ws, { kind: 'error', message: 'join a room first' });
      const action = msg.action;
      if (!action || typeof action.type !== 'string') {
        return send(ws, { kind: 'error', message: 'malformed action' });
      }
      return conn.room.handleAction(conn.id, action);
    }

    default:
      return send(ws, { kind: 'error', message: `unknown message kind` });
  }
}

function handleHttp(req: IncomingMessage, res: ServerResponse, catalog: Catalog, hub: Hub): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  if (url.pathname === '/health') {
    return json(res, { ok: true, rooms: hub.size, cards: catalog.cards.length });
  }
  if (url.pathname === '/api/cards') {
    return json(res, { sources: catalog.sources, cards: catalog.cards });
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

function json(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(payload);
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isEntrypoint) {
  startServer({ allowSmallDecks: process.env.DBZ_ALLOW_SMALL_DECKS === '1' })
    .then((h) => {
      console.log(`[dbz] server listening on :${h.port} (${h.hub.size} rooms)`);
    })
    .catch((err: unknown) => {
      console.error('[dbz] failed to start:', err);
      process.exit(1);
    });
}

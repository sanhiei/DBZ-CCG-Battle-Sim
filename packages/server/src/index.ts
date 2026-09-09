/**
 * WebSocket game server + a small HTTP surface for the catalog.
 *
 *   ws://host/            game protocol (see @dbz/shared ClientMessage/ServerMessage)
 *   GET /health           liveness + room count
 *   GET /api/cards        the card catalog, for the client's browser/deck builder
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@dbz/shared';
import { findDataDir, loadCatalog, type Catalog } from './catalog.js';
import { getPatTable } from '@dbz/engine';
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
  if (url.pathname === '/api/presets') {
    // Ready-made decks, resolved to card ids by scripts/resolve-presets.mjs.
    // Optional: without the file the builder simply offers no presets.
    const path = join(findDataDir(), 'preset-decks.resolved.json');
    if (!existsSync(path)) return json(res, { decks: [] });
    try {
      return json(res, JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return json(res, { decks: [] });
    }
  }
  if (url.pathname === '/api/pat') {
    // The client runs the same engine for optimistic prediction and renders PAT
    // bracket letters; without this it would fall back to PLACEHOLDER_PAT and
    // show brackets computed from invented numbers.
    return json(res, getPatTable());
  }
  if (url.pathname.startsWith('/cards/')) {
    return serveCardImage(url.pathname.slice('/cards/'.length), res);
  }
  if (url.pathname.startsWith('/playmat/')) {
    return serveLocalArt('playmats', url.pathname.slice('/playmat/'.length), res);
  }
  if (url.pathname.startsWith('/pat-image/')) {
    return serveLocalArt('pat-images', url.pathname.slice('/pat-image/'.length), res);
  }
  if (serveClient(url.pathname, res)) return;
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serve the built client, so one process on one port is the whole game.
 *
 * The client talks to same-origin `/ws`, `/api` and `/cards`; in development
 * Vite proxies those to this server, which is why nothing needed to serve the
 * UI before. In production there is no Vite, so without this there is no single
 * URL to hand anyone — which is the whole point of a multiplayer game.
 *
 * Unknown paths fall back to index.html because the client is a single-page
 * app: a room link like /r/ABCD is a client route, not a file. Returns false
 * when there is no build to serve, so `npm run dev:server` still 404s honestly
 * instead of pretending.
 */
function serveClient(pathname: string, res: ServerResponse): boolean {
  const root = clientDist();
  if (!root) return false;

  const rel = pathname.replace(/^\/+/, '');
  // Resolve inside the build directory only; a crafted path must not escape it.
  const candidate = rel ? join(root, rel) : '';
  const file = candidate && candidate.startsWith(root) && existsSync(candidate) && !candidate.endsWith('/') ? candidate : join(root, 'index.html');
  if (!existsSync(file)) return false;

  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Hashed asset filenames may be cached hard; index.html must not be.
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
  return true;
}

let clientDistCache: string | null | undefined;
function clientDist(): string | null {
  if (clientDistCache !== undefined) return clientDistCache;
  const fromEnv = process.env.DBZ_CLIENT_DIST;
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    join(process.cwd(), 'packages', 'client', 'dist'),
    join(process.cwd(), '..', 'client', 'dist'),
  ];
  clientDistCache = candidates.find((d) => existsSync(join(d, 'index.html'))) ?? null;
  return clientDistCache;
}

/**
 * Serve a sliced card face from data/images-tts/.
 *
 * Card art is not ours to redistribute, so these files are gitignored and this
 * route only ever reads from that one directory — the filename is reduced to a
 * bare basename so a crafted id cannot escape it.
 */
function serveCardImage(rawName: string, res: ServerResponse): void {
  const safe = basename(decodeURIComponent(rawName)).replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe || !/\.(jpg|jpeg|png)$/i.test(safe)) {
    res.writeHead(400).end();
    return;
  }
  // Prefer a web-sized WebP when one exists. The sliced originals average
  // 206KB and total 541MB, which is fine locally and painful through a tunnel;
  // `npm run optimize:images` writes smaller copies beside them. Nothing here
  // depends on that having been run — without it, the originals are served.
  const dataDir = findDataDir();
  const webp = join(dataDir, 'images-web', safe.replace(/\.(jpg|jpeg|png)$/i, '.webp'));
  const original = join(dataDir, 'images-tts', safe);
  const file = existsSync(webp) ? webp : original;
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': file.endsWith('.webp')
      ? 'image/webp'
      : safe.toLowerCase().endsWith('.png')
        ? 'image/png'
        : 'image/jpeg',
    'cache-control': 'public, max-age=86400',
  });
  createReadStream(file).pipe(res);
}

/**
 * Serve a piece of local table art — the playmat, the Physical Attack Table
 * card — from a named directory under data/.
 *
 * These are franchise images and gitignored for the same reason the card faces
 * are: they live on the machine running the game, not in the repository. The
 * host serves them the way any site serves its images. Missing is not an
 * error — the UI falls back to something it can draw itself, so a fresh clone
 * with no art still plays.
 *
 * The name is reduced to a bare basename and stripped to a safe charset, so a
 * crafted path cannot escape the directory.
 */
function serveLocalArt(dirName: string, rawName: string, res: ServerResponse): void {
  const safe = basename(decodeURIComponent(rawName)).replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) {
    res.writeHead(400).end();
    return;
  }
  const dir = join(findDataDir(), dirName);
  // The name may arrive without an extension ("default"), so try the ones we
  // are willing to serve rather than making the caller know which it is.
  const candidates = /\.(jpg|jpeg|png|webp)$/i.test(safe)
    ? [join(dir, safe)]
    : ['webp', 'png', 'jpg', 'jpeg'].map((ext) => join(dir, `${safe}.${ext}`));
  const file = candidates.find((f) => existsSync(f));
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  res.writeHead(200, {
    'content-type': ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
    'cache-control': 'public, max-age=86400',
  });
  createReadStream(file).pipe(res);
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

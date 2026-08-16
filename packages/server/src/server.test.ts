/** Server tests: deck legality, room lifecycle, redaction, authority, reconnect. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action, ActionWithMeta, DeckList, GameState, LobbyView, ServerMessage } from '@dbz/shared';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPatTable, PLACEHOLDER_PAT, type EngineCard, type PatTable } from '@dbz/engine';
import { WebSocket } from 'ws';
import { startServer } from './index.js';
import { findDataDir, loadCatalog } from './catalog.js';
import { loadPatTable, validatePatTable } from './pat.js';
import { Hub, normalizeCode } from './hub.js';
import { Room, type RoomClient } from './room.js';
import { MIN_DECK_SIZE, validateDeck } from './decks.js';
import { viewFor } from './redact.js';

const catalog = loadCatalog();
const db = catalog.db;

/* ---------- helpers ---------- */

/** A legal 50-card Goku deck built out of whatever the catalog actually has. */
function legalDeck(name = 'Test Deck', mpName = 'Goku'): DeckList {
  const levels = db
    .levelsOf(mpName)
    .filter((c, i, arr) => arr.findIndex((o) => o.rules!.personality!.level === c.rules!.personality!.level) === i)
    .slice(0, 3);
  assert.equal(levels.length, 3, `catalog should have 3 levels of ${mpName}`);

  const fillers = catalog.cards.filter(
    (c: EngineCard) => !c.rules?.personality && !/dragon ball/i.test(c.name) && !c.name.toLowerCase().includes(mpName.toLowerCase()),
  );
  const life: Array<{ cardId: string; qty: number }> = [];
  let remaining = MIN_DECK_SIZE - levels.length;
  for (const card of fillers) {
    if (remaining <= 0) break;
    const qty = Math.min(3, remaining);
    life.push({ cardId: card.id, qty });
    remaining -= qty;
  }
  return { name, mpLevels: levels.map((c) => c.id), life };
}

/** A RoomClient that records everything the room sends it. */
function fakeClient(id: string): RoomClient & { sent: ServerMessage[]; last<T extends ServerMessage['kind']>(kind: T): Extract<ServerMessage, { kind: T }> | undefined } {
  const sent: ServerMessage[] = [];
  return {
    id,
    sent,
    send: (msg: ServerMessage) => void sent.push(msg),
    last<T extends ServerMessage['kind']>(kind: T) {
      for (let i = sent.length - 1; i >= 0; i--) {
        if (sent[i]!.kind === kind) return sent[i] as Extract<ServerMessage, { kind: T }>;
      }
      return undefined;
    },
  };
}

const act = (a: Action, id = 'a1'): ActionWithMeta => ({ ...a, clientActionId: id }) as ActionWithMeta;

/** Two seated players in a started game. */
function startedRoom(): { room: Room; a: ReturnType<typeof fakeClient>; b: ReturnType<typeof fakeClient> } {
  const room = new Room('TEST', { db, seed: 42 });
  const a = fakeClient('ca');
  const b = fakeClient('cb');
  room.join({ client: a, playerName: 'Alice' });
  room.join({ client: b, playerName: 'Bob' });
  room.handleAction('ca', act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck('A', 'Goku') }));
  room.handleAction('cb', act({ type: 'loadDeck', playerIdx: 1, deck: legalDeck('B', 'Piccolo') }));
  room.handleAction('ca', act({ type: 'setReady', playerIdx: 0 }));
  room.handleAction('cb', act({ type: 'setReady', playerIdx: 1 }));
  return { room, a, b };
}

/* ---------- catalog ---------- */

test('catalog loads enriched cards', () => {
  assert.ok(catalog.cards.length > 0);
  assert.ok(catalog.sources.every((s) => s.endsWith('.json')));
  assert.ok(db.levelsOf('Goku').length >= 3);
});

test('TTS-covered sagas contain no duplicate gallery copies', () => {
  // TTS data is triangulated (typed + vision + OCR); the gallery block is
  // single-source OCR and is known to carry corrupt ladders. TTS wins.
  const ttsSagas = new Set(catalog.cards.filter((c) => c.id.startsWith('tts-')).map((c) => c.saga));
  const galleryInTtsSaga = catalog.cards.filter((c) => !c.id.startsWith('tts-') && ttsSagas.has(c.saga));
  assert.equal(galleryInTtsSaga.length, 0, galleryInTtsSaga.slice(0, 3).map((c) => `${c.name} [${c.saga}]`).join(', '));
});

test('every personality ladder starts at the zero stage', () => {
  // A scouter's bottom rung is printed 0/00/0000. A ladder that omits it makes
  // every stage read one rung high — the gallery Saiyan block had exactly this
  // defect, which is why it is no longer preferred.
  const bad = catalog.cards.filter((c) => {
    const r = c.rules?.personality?.powerRatings;
    return Array.isArray(r) && r.length >= 6 && r[0] !== 0;
  });
  assert.equal(bad.length, 0, bad.slice(0, 5).map((c) => `${c.name}: ${JSON.stringify(c.rules?.personality?.powerRatings?.slice(0, 3))}`).join(' | '));
});

/* ---------- PAT ---------- */

test('PAT table', async (t) => {
  await t.test('loads data/pat.json into the engine', () => {
    const result = loadPatTable();
    assert.equal(result.loaded, true, result.warning ?? '');
    assert.equal(result.placeholder, false, 'combat must not run on the placeholder grid');
    assert.notDeepEqual(getPatTable(), PLACEHOLDER_PAT);
  });

  await t.test('a bracket-lettered D exists for the go-first rule', () => {
    assert.ok(getPatTable().brackets.some((b) => b.letter === 'D'));
  });

  await t.test('rejects a malformed table instead of silently using it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbz-pat-'));
    writeFileSync(join(dir, 'pat.json'), JSON.stringify({ brackets: [{ letter: 'D', minRating: 0, maxRating: 1 }], damage: [], special: { zResult: 2 } }));
    const result = loadPatTable(dir);
    assert.equal(result.loaded, false);
    assert.match(result.warning ?? '', /damage has 0 rows/);
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('every recovered historical printing in data/pat/ is a valid table', async (t2) => {
    const patDir = join(findDataDir(), 'pat');
    const files = readdirSync(patDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 3, 'saiyan, trunks, cell transcriptions expected');
    for (const file of files) {
      const table = JSON.parse(readFileSync(join(patDir, file), 'utf8')) as PatTable;
      assert.equal(validatePatTable(table), undefined, `${file} failed validation`);
      assert.notEqual(table.placeholder, true, `${file} must not be a placeholder`);
      // Row 0 of every real printing: A-vs-A deals 1, everything else 0.
      assert.equal(table.damage[0]![0], 1, `${file}: A vs A must be 1`);
      assert.ok(table.damage[0]!.slice(1).every((d) => d === 0), `${file}: A vs higher must be 0`);
    }
    void t2;
  });

  await t.test('reports a missing table rather than failing silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbz-pat-'));
    const result = loadPatTable(dir);
    assert.equal(result.loaded, false);
    assert.match(result.warning ?? '', /PLACEHOLDER/);
    rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------- deck validation ---------- */

test('deck validation', async (t) => {
  await t.test('accepts a legal deck', () => {
    assert.deepEqual(validateDeck(legalDeck(), db), []);
  });

  await t.test('rejects a deck below the 50-card minimum', () => {
    const deck = legalDeck();
    deck.life = deck.life.slice(0, 2);
    const errors = validateDeck(deck, db);
    assert.ok(errors.some((e) => e.includes(`minimum is ${MIN_DECK_SIZE}`)), errors.join('; '));
  });

  await t.test('honours the enforceSize escape hatch', () => {
    const deck = legalDeck();
    deck.life = deck.life.slice(0, 2);
    assert.deepEqual(validateDeck(deck, db, { enforceSize: false }), []);
  });

  await t.test('requires 3 consecutive MP levels starting at 1', () => {
    const deck = legalDeck();
    deck.mpLevels = deck.mpLevels.slice(0, 2);
    assert.ok(validateDeck(deck, db).some((e) => e.includes('at least 3 levels')));

    const gapped = legalDeck();
    gapped.mpLevels = [gapped.mpLevels[0]!, gapped.mpLevels[2]!];
    assert.ok(validateDeck(gapped, db).some((e) => e.includes('consecutive') || e.includes('at least 3 levels')));
  });

  await t.test('rejects mixed personalities in the MP stack', () => {
    const deck = legalDeck();
    deck.mpLevels = [deck.mpLevels[0]!, deck.mpLevels[1]!, db.levelsOf('Piccolo')[2]!.id];
    assert.ok(validateDeck(deck, db).some((e) => e.includes('mix personalities')));
  });

  await t.test('enforces the 3-copy limit', () => {
    const deck = legalDeck();
    deck.life[0]!.qty = 4;
    assert.ok(validateDeck(deck, db).some((e) => e.includes('limit 3')));
  });

  await t.test('rejects unknown card ids', () => {
    const deck = legalDeck();
    deck.life.push({ cardId: 'no-such-card', qty: 1 });
    assert.ok(validateDeck(deck, db).some((e) => e.includes('unknown card id')));
  });

  await t.test('rejects malformed input off the wire', () => {
    assert.ok(validateDeck({ name: '', mpLevels: [], life: [] }, db).length > 0);
    assert.ok(validateDeck({ name: 'x', mpLevels: [], life: [{ cardId: 'a', qty: 0 }] }, db).length > 0);
    assert.ok(validateDeck({ name: 'x', mpLevels: 'nope' as never, life: [] }, db).length > 0);
  });
});

/* ---------- lobby ---------- */

test('lobby seats players and starts on ready', async (t) => {
  const room = new Room('TEST', { db, seed: 7 });
  const a = fakeClient('ca');
  const b = fakeClient('cb');

  await t.test('first two joins take the seats', () => {
    assert.equal(room.join({ client: a, playerName: 'Alice' }).seatIdx, 0);
    assert.equal(room.join({ client: b, playerName: 'Bob' }).seatIdx, 1);
  });

  await t.test('a third join spectates', () => {
    const c = fakeClient('cc');
    assert.equal(room.join({ client: c, playerName: 'Carol' }).seatIdx, null);
    room.broadcast();
    assert.equal(c.last('lobby')?.lobby.spectators, 1);
  });

  await t.test('lobby reflects submitted decks', () => {
    room.handleAction('ca', act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck('Alice Deck') }));
    const lobby = a.last('lobby')?.lobby as LobbyView;
    assert.equal(lobby.seats[0]?.deckName, 'Alice Deck');
    assert.equal(lobby.started, false);
  });

  await t.test('an illegal deck is rejected with a reason', () => {
    const bad = legalDeck('Bad');
    bad.life = [];
    room.handleAction('cb', act({ type: 'loadDeck', playerIdx: 1, deck: bad }, 'bad-1'));
    const err = b.last('error');
    assert.match(err?.message ?? '', /illegal deck/);
    assert.equal(err?.clientActionId, 'bad-1');
  });

  await t.test('ready before a deck is rejected', () => {
    room.handleAction('cb', act({ type: 'setReady', playerIdx: 1 }));
    assert.match(b.last('error')?.message ?? '', /load a deck first/);
  });

  await t.test('both ready starts the game', () => {
    room.handleAction('cb', act({ type: 'loadDeck', playerIdx: 1, deck: legalDeck('Bob Deck', 'Piccolo') }));
    room.handleAction('ca', act({ type: 'setReady', playerIdx: 0 }));
    assert.equal(room.started, false, 'one side ready is not enough');
    room.handleAction('cb', act({ type: 'setReady', playerIdx: 1 }));
    assert.equal(room.started, true);
    const state = a.last('state')?.state as GameState;
    assert.equal(state.players.length, 2);
    assert.equal(state.phase, 'playing');
  });
});

test('a new deck submission clears ready', () => {
  const room = new Room('TEST', { db, seed: 1 });
  const a = fakeClient('ca');
  room.join({ client: a, playerName: 'Alice' });
  room.handleAction('ca', act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck() }));
  room.handleAction('ca', act({ type: 'setReady', playerIdx: 0 }));
  assert.equal(a.last('lobby')?.lobby.seats[0]?.ready, true);
  room.handleAction('ca', act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck('Other') }));
  assert.equal(a.last('lobby')?.lobby.seats[0]?.ready, false);
});

/* ---------- redaction ---------- */

test('redaction hides what a seat may not see', async (t) => {
  const { room, a } = startedRoom();
  const state = room.gameState!;
  // Put a card in each hand to have something to hide.
  state.players[0]!.zones.hand.push(state.players[0]!.zones.lifeDeck.pop()!);
  state.players[1]!.zones.hand.push(state.players[1]!.zones.lifeDeck.pop()!);

  await t.test('you see your own hand', () => {
    const view = viewFor(state, 0);
    assert.ok(view.players[0]!.zones.hand[0]!.cardId.length > 0);
  });

  await t.test("you cannot see the opponent's hand, only its size", () => {
    const view = viewFor(state, 0);
    const oppHand = view.players[1]!.zones.hand;
    assert.equal(oppHand.length, 1);
    assert.equal(oppHand[0]!.cardId, '');
    assert.equal(oppHand[0]!.uid, state.players[1]!.zones.hand[0]!.uid, 'uid is preserved for animation');
  });

  await t.test('life decks are hidden from everyone including their owner', () => {
    const view = viewFor(state, 0);
    assert.ok(view.players[0]!.zones.lifeDeck.length > 0);
    assert.ok(view.players[0]!.zones.lifeDeck.every((c) => c.cardId === ''));
  });

  await t.test('spectators see no hands at all', () => {
    const view = viewFor(state, null);
    assert.ok(view.players.every((p) => p.zones.hand.every((c) => c.cardId === '')));
  });

  await t.test('redaction does not mutate the authoritative state', () => {
    viewFor(state, 0);
    assert.ok(state.players[1]!.zones.hand[0]!.cardId.length > 0);
  });

  await t.test('only the prompted player sees prompt options', () => {
    state.pendingPrompt = { id: 'p1', playerIdx: 1, type: 'defend', message: 'Defend?', options: ['secret-uid'] };
    assert.deepEqual(viewFor(state, 1).pendingPrompt?.options, ['secret-uid']);
    assert.equal(viewFor(state, 0).pendingPrompt?.options, undefined);
    assert.equal(viewFor(state, 0).pendingPrompt?.type, 'defend', 'the fact of the prompt is public');
    delete state.pendingPrompt;
  });

  await t.test('each client is sent its own view', () => {
    room.broadcast();
    const view = a.last('state')!.state;
    assert.ok(view.players[1]!.zones.hand.every((c) => c.cardId === ''));
  });
});

/* ---------- authority ---------- */

test('server authority', async (t) => {
  await t.test('a spectator cannot act', () => {
    const { room } = startedRoom();
    const spec = fakeClient('cs');
    room.join({ client: spec, playerName: 'Spec', spectate: true });
    room.handleAction('cs', act({ type: 'drawCards', playerIdx: 0, count: 1 }));
    assert.match(spec.last('error')?.message ?? '', /spectators cannot act/);
  });

  await t.test('a player cannot act out of the opponent seat', () => {
    const { room, b } = startedRoom();
    const before = room.gameState!.players[0]!.zones.hand.length;
    room.handleAction('cb', act({ type: 'drawCards', playerIdx: 0, count: 5 }, 'spoof'));
    const err = b.last('error');
    assert.match(err?.message ?? '', /cannot act for another player/);
    assert.equal(err?.clientActionId, 'spoof');
    assert.equal(room.gameState!.players[0]!.zones.hand.length, before, 'state unchanged');
  });

  await t.test('only the active player may advance the step', () => {
    const { room } = startedRoom();
    const active = room.gameState!.activePlayerIdx;
    const idle = active === 0 ? 'cb' : 'ca';
    const step = room.gameState!.step;
    room.handleAction(idle, act({ type: 'advanceStep' }));
    assert.equal(room.gameState!.step, step, 'step did not move');
  });

  await t.test('the active player may advance the step', () => {
    const { room } = startedRoom();
    const activeClient = room.gameState!.activePlayerIdx === 0 ? 'ca' : 'cb';
    const step = room.gameState!.step;
    room.handleAction(activeClient, act({ type: 'advanceStep' }));
    assert.notEqual(room.gameState!.step, step);
  });

  await t.test('a rejected engine action leaves state untouched and echoes the id', () => {
    const { room, a } = startedRoom();
    const before = JSON.stringify(room.gameState);
    room.handleAction('ca', act({ type: 'declareAttack', attackType: 'physical' }, 'bad-attack'));
    assert.equal(a.last('error')?.clientActionId, 'bad-attack');
    assert.equal(JSON.stringify(room.gameState), before);
  });

  await t.test('lobby actions are refused after the game starts', () => {
    const { room, a } = startedRoom();
    room.handleAction('ca', act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck() }));
    assert.match(a.last('error')?.message ?? '', /already started/);
  });

  await t.test('a successful action echoes its clientActionId to everyone', () => {
    const { room, a, b } = startedRoom();
    const activeIdx = room.gameState!.activePlayerIdx;
    const activeClient = activeIdx === 0 ? 'ca' : 'cb';
    room.handleAction(activeClient, act({ type: 'chat', playerIdx: activeIdx, text: 'gg' }, 'chat-1'));
    assert.equal(a.last('state')?.clientActionId, 'chat-1');
    assert.equal(b.last('state')?.clientActionId, 'chat-1');
  });
});

/* ---------- reconnect ---------- */

test('reconnect', async (t) => {
  await t.test('a token reclaims the seat mid-game', () => {
    const room = new Room('TEST', { db, seed: 3 });
    const a = fakeClient('ca');
    const b = fakeClient('cb');
    const { token } = room.join({ client: a, playerName: 'Alice' });
    room.join({ client: b, playerName: 'Bob' });
    room.handleAction('ca', act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck('A') }));
    room.handleAction('cb', act({ type: 'loadDeck', playerIdx: 1, deck: legalDeck('B', 'Piccolo') }));
    room.handleAction('ca', act({ type: 'setReady', playerIdx: 0 }));
    room.handleAction('cb', act({ type: 'setReady', playerIdx: 1 }));

    room.leave('ca');
    assert.equal(room.gameState!.players[0]!.connected, false);

    const a2 = fakeClient('ca2');
    assert.equal(room.join({ client: a2, playerName: 'Alice', token }).seatIdx, 0);
    assert.equal(room.gameState!.players[0]!.connected, true);
    assert.equal(room.seatOf('ca2'), 0);
  });

  await t.test('a wrong token does not steal a seat', () => {
    const room = new Room('TEST', { db, seed: 3 });
    room.join({ client: fakeClient('ca'), playerName: 'Alice' });
    const intruder = room.join({ client: fakeClient('cx'), playerName: 'Mallory', token: 'not-a-real-token' });
    assert.equal(intruder.seatIdx, 1, 'falls through to the open seat, not seat 0');
  });

  await t.test('leaving the lobby before loading a deck frees the seat', () => {
    const room = new Room('TEST', { db, seed: 3 });
    room.join({ client: fakeClient('ca'), playerName: 'Alice' });
    room.leave('ca');
    assert.equal(room.join({ client: fakeClient('cb'), playerName: 'Bob' }).seatIdx, 0);
  });
});

/* ---------- end to end over a real socket ---------- */

/** A WebSocket client that queues messages so tests can await them by kind. */
function wsClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: ServerMessage[] = [];
  ws.on('message', (raw) => void received.push(JSON.parse(String(raw)) as ServerMessage));
  return {
    ws,
    received,
    open: () => new Promise<void>((res, rej) => (ws.readyState === ws.OPEN ? res() : (ws.once('open', res), ws.once('error', rej)))),
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    /** Wait until a message of `kind` arrives (checking what already landed). */
    async next<T extends ServerMessage['kind']>(kind: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { kind: T }>> {
      const found = received.find((m) => m.kind === kind);
      if (found) return found as Extract<ServerMessage, { kind: T }>;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for '${kind}'`)), timeoutMs);
        const onMessage = (raw: unknown) => {
          const msg = JSON.parse(String(raw)) as ServerMessage;
          if (msg.kind === kind) {
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg as Extract<ServerMessage, { kind: T }>);
          }
        };
        ws.on('message', onMessage);
      });
    },
    close: () => ws.close(),
  };
}

test('end to end over websockets', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', catalog, seed: 99 });
  t.after(() => server.close());

  await t.test('serves the catalog over HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/cards`);
    const body = (await res.json()) as { cards: EngineCard[] };
    assert.equal(res.status, 200);
    assert.equal(body.cards.length, catalog.cards.length);

    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  });

  const alice = wsClient(server.port);
  const bob = wsClient(server.port);
  await Promise.all([alice.open(), bob.open()]);

  let aliceToken = '';
  await t.test('joining assigns seats', async () => {
    alice.send({ kind: 'join', roomCode: 'ZZZZ', playerName: 'Alice' });
    bob.send({ kind: 'join', roomCode: 'ZZZZ', playerName: 'Bob' });
    const aSession = await alice.next('session');
    const bSession = await bob.next('session');
    assert.equal(aSession.playerIdx, 0);
    assert.equal(bSession.playerIdx, 1);
    assert.equal(aSession.roomCode, 'ZZZZ');
    aliceToken = aSession.token;
    assert.ok(aliceToken.length > 0);
  });

  await t.test('a full lobby handshake starts the game', async () => {
    alice.send({ kind: 'action', action: act({ type: 'loadDeck', playerIdx: 0, deck: legalDeck('A', 'Goku') }) });
    bob.send({ kind: 'action', action: act({ type: 'loadDeck', playerIdx: 1, deck: legalDeck('B', 'Piccolo') }) });
    await alice.next('lobby');
    alice.send({ kind: 'action', action: act({ type: 'setReady', playerIdx: 0 }) });
    bob.send({ kind: 'action', action: act({ type: 'setReady', playerIdx: 1 }) });

    const state = (await alice.next('state')).state;
    assert.equal(state.phase, 'playing');
    assert.equal(state.players[0]!.name, 'Alice');
    // Redaction survives the wire.
    assert.ok(state.players[1]!.zones.lifeDeck.every((c) => c.cardId === ''));
  });

  await t.test('ping/pong and malformed input are handled', async () => {
    alice.send({ kind: 'ping' });
    await alice.next('pong');
    alice.ws.send('not json');
    assert.match((await alice.next('error')).message, /malformed/);
  });

  await t.test('a dropped client can reclaim its seat with its token', async () => {
    alice.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.hub.get('ZZZZ')!.gameState!.players[0]!.connected, false);

    const alice2 = wsClient(server.port);
    await alice2.open();
    alice2.send({ kind: 'join', roomCode: 'ZZZZ', playerName: 'Alice', token: aliceToken });
    assert.equal((await alice2.next('session')).playerIdx, 0);
    assert.equal(server.hub.get('ZZZZ')!.gameState!.players[0]!.connected, true);
    // Reconnecting delivers the current state, not a lobby view.
    assert.equal((await alice2.next('state')).state.phase, 'playing');
    alice2.close();
  });

  bob.close();
});

/* ---------- hub ---------- */

test('hub', async (t) => {
  await t.test('normalizes room codes', () => {
    assert.equal(normalizeCode(' ab-1z '), 'AB1Z');
    assert.equal(normalizeCode(42), '');
  });

  await t.test('joining an unused code creates the room', () => {
    const hub = new Hub(db);
    const room = hub.getOrCreate('xy9z');
    assert.equal(room.code, 'XY9Z');
    assert.equal(hub.getOrCreate('XY9Z'), room, 'same code returns the same room');
    assert.equal(hub.size, 1);
  });

  await t.test('an empty code allocates a fresh one', () => {
    const hub = new Hub(db);
    assert.match(hub.getOrCreate('').code, /^[A-Z0-9]{4}$/);
  });

  await t.test('sweeps rooms idle past the TTL', () => {
    const hub = new Hub(db);
    const room = hub.getOrCreate('AAAA');
    const c = fakeClient('c1');
    room.join({ client: c, playerName: 'A' });
    assert.equal(hub.sweep(Date.now(), 1000), 0, 'occupied rooms survive');
    room.leave('c1');
    assert.equal(hub.sweep(Date.now(), 60_000), 0, 'inside the TTL it survives');
    assert.equal(hub.sweep(Date.now() + 120_000, 60_000), 1);
    assert.equal(hub.size, 0);
  });
});

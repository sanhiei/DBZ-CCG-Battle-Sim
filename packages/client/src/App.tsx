/**
 * App shell: join screen -> lobby -> board, plus the card browser.
 *
 * Everything rendered here is a view of engine state; the only writes are
 * actions handed to the server (and optimistically to the local reducer).
 */
import { useEffect, useMemo, useState } from 'react';
import { useGame } from './net/useGame.ts';
import { Board } from './components/Board.tsx';
import { CardBrowser } from './components/CardBrowser.tsx';
import { DeckBuilder } from './components/DeckBuilder.tsx';

/** Room code from a shared link: /r/KAME or ?room=KAME. */
function codeFromUrl(): string {
  const path = /^\/r\/([A-Za-z0-9]{1,8})\/?$/.exec(location.pathname);
  const q = new URLSearchParams(location.search).get('room');
  return (path?.[1] ?? q ?? '').toUpperCase();
}

const NAME_KEY = 'dbz.name';

export function App() {
  const game = useGame();
  // Remember the name; you are the same person every session, and retyping it
  // to rejoin the room you were just in is pure friction.
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  // A shared link should land you on the room, not on an empty form.
  const [code, setCode] = useState(codeFromUrl);
  const [tab, setTab] = useState<'game' | 'cards'>('game');

  useEffect(() => {
    try {
      if (name.trim()) localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* not fatal */
    }
  }, [name]);

  const joined = game.roomCode !== null;
  const mySeat = game.lobby?.seats.find((s) => s.idx === game.seat);
  const canJoin = game.conn === 'open' && name.trim().length > 0 && code.trim().length > 0;

  const status = useMemo(() => {
    if (game.conn === 'connecting') return 'connecting…';
    if (game.conn === 'closed') return 'disconnected — reload to reconnect';
    if (game.conn === 'error') return 'connection error';
    return game.roomCode ? `room ${game.roomCode}` : 'connected';
  }, [game.conn, game.roomCode]);

  return (
    <div className="app">
      <header className="app__bar">
        <h1>
          DBZ<span>CCG</span>
        </h1>
        <nav>
          <button className={tab === 'game' ? 'on' : ''} onClick={() => setTab('game')}>
            Game
          </button>
          <button className={tab === 'cards' ? 'on' : ''} onClick={() => setTab('cards')}>
            Cards {game.cards.length > 0 && <em>{game.cards.length}</em>}
          </button>
        </nav>
        <span className="app__status">
          {status}
          {game.seat !== null && <em> · seat {game.seat + 1}</em>}
          {game.seat === null && joined && <em> · spectating</em>}
          {game.pendingCount > 0 && <em className="app__pending"> · {game.pendingCount} predicted</em>}
        </span>
      </header>

      {tab === 'cards' ? (
        <CardBrowser cards={game.cards} />
      ) : !joined ? (
        <main className="join">
          <h2>Join a room</h2>
          <p className="join__hint">
            Any unused code creates that room. First two players take the seats; everyone after spectates.
          </p>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="Goku" />
          </label>
          <label>
            Room code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={8}
              placeholder="KAME"
            />
          </label>
          <div className="join__actions">
            <button disabled={!canJoin} onClick={() => game.join(code, name)}>
              Take a seat
            </button>
            <button disabled={!canJoin} className="ghost" onClick={() => game.join(code, name, true)}>
              Spectate
            </button>
          </div>
        </main>
      ) : game.state ? (
        <Board
          state={game.state}
          seat={game.seat}
          db={game.db}
          onAdvanceStep={() => game.send({ type: 'advanceStep' })}
          onPowerUp={() => game.seat !== null && game.send({ type: 'powerUp', playerIdx: game.seat })}
          onPass={() => game.send({ type: 'pass' })}
          onAttack={(attackType, cardUid) =>
            game.send({ type: 'declareAttack', attackType, ...(cardUid ? { cardUid } : {}) })
          }
          onAnswer={(promptId, choice) => game.send({ type: 'answerPrompt', promptId, choice })}
          onConcede={() => game.seat !== null && game.send({ type: 'concede', playerIdx: game.seat })}
          onSetStage={(personalityUid, stageIndex) => game.send({ type: 'setStage', personalityUid, stageIndex })}
          onSetAnger={(personalityUid, anger) => game.send({ type: 'setAnger', personalityUid, anger })}
          onMoveCard={(cardUid, toZone) => game.send({ type: 'moveCard', cardUid, toZone })}
          onPlayCard={(cardUid) => game.seat !== null && game.send({ type: 'playCard', playerIdx: game.seat, cardUid })}
        />
      ) : (
        <>
          <section className="lobby lobby--strip">
            <h2>Room {game.roomCode}</h2>
          <p className="lobby__invite">
            Invite link: <code>{`${location.origin}/r/${game.roomCode}`}</code>{' '}
            <button
              className="ghost"
              onClick={() => void navigator.clipboard?.writeText(`${location.origin}/r/${game.roomCode}`)}
            >
              Copy
            </button>
          </p>
            <ul className="lobby__seats">
              {(game.lobby?.seats ?? []).map((s) => (
                <li key={s.idx} className={s.ready ? 'ready' : ''}>
                  <span className={`dot ${s.connected ? 'dot--on' : 'dot--off'}`} />
                  <strong>{s.name}</strong>
                  <span>{s.deckName ? `deck: ${s.deckName}` : 'no deck yet'}</span>
                  <span>{s.ready ? 'ready' : 'not ready'}</span>
                </li>
              ))}
            </ul>
            {game.lobby && game.lobby.spectators > 0 && <p>{game.lobby.spectators} spectating</p>}
          </section>
          <DeckBuilder
            cards={game.cards}
            db={game.db}
            seat={game.seat}
            ready={mySeat?.ready ?? false}
            {...(mySeat?.deckName ? { submittedName: mySeat.deckName } : {})}
            onSubmit={(deck) => game.seat !== null && game.send({ type: 'loadDeck', playerIdx: game.seat, deck })}
            onReady={() => game.seat !== null && game.send({ type: 'setReady', playerIdx: game.seat })}
          />
        </>
      )}

      {game.errors.length > 0 && (
        <div className="errors">
          {game.errors.slice(-3).map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}
